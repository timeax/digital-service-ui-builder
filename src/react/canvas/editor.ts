import { cloneDeep } from "lodash-es";
import type { Builder } from "@/core";
import type { ServiceProps, Tag, Field } from "@/schema";
import { normalise } from "@/core";
import type { CanvasAPI } from "./api";
import type {
    Command,
    EditorEvents,
    EditorOptions,
} from "@/schema/editor.types";
import { compilePolicies, PolicyDiagnostic } from "@/core/policy";
import { DynamicRule, FallbackSettings } from "@/schema/validation";
import { DgpServiceCapability, DgpServiceMap } from "@/schema/provider";
import { constraintFitOk, rateOk, toFiniteNumber } from "@/utils/util";
import { EditorSnapshot } from "@/schema/editor";
import { Selection } from "./selection";

const MAX_LIMIT = 100;
type WireKind = "bind" | "include" | "exclude" | "service";

// Addressing nodes
export type TagRef = { kind: "tag"; id: string };
export type FieldRef = { kind: "field"; id: string };
export type OptionRef = { kind: "option"; fieldId: string; id: string };
export type NodeRef = TagRef | FieldRef | OptionRef;

export type DuplicateOptions = {
    // tags
    withChildren?: boolean; // default false
    // fields
    copyBindings?: boolean; // default true
    copyIncludesExcludes?: boolean; // default false
    copyOptionMaps?: boolean; // default false
    // all
    id?: string; // force an id instead of auto
    labelStrategy?: (old: string) => string; // override default "Label (copy)" logic
    nameStrategy?: (old?: string) => string | undefined; // for fields; default suffix "_copy"
    optionIdStrategy?: (old: string) => string; // for options; default add "_copy"
};

const isTagId = (id: string) => id.startsWith("t:");
const isFieldId = (id: string) => id.startsWith("f:");
const isOptionId = (id: string) => id.startsWith("o:");

// owner lookup (linear, OK for editor; index if you want later)
function ownerOfOption(
    props: ServiceProps,
    optionId: string,
): { fieldId: string; index: number } | null {
    for (const f of props.fields ?? []) {
        const idx = (f.options ?? []).findIndex((o) => o.id === optionId);
        if (idx >= 0) return { fieldId: f.id, index: idx };
    }
    return null;
}

function ensureServiceExists(opts: EditorOptions, id: any) {
    if (typeof opts.serviceExists === "function") {
        if (!opts.serviceExists(id))
            throw new Error(`service_not_found:${String(id)}`);
        return;
    }
    if (opts.serviceMap) {
        if (!Object.prototype.hasOwnProperty.call(opts.serviceMap, id as any)) {
            throw new Error(`service_not_found:${String(id)}`);
        }
        return;
    }
    // Host didn't provide a way to verify — fail so they wire one.
    throw new Error("service_checker_missing");
}

export class Editor {
    private builder: Builder;
    private api: CanvasAPI;
    private readonly opts: Required<EditorOptions>;
    private history: EditorSnapshot[] = [];
    private index = -1; // points to current snapshot
    private txnDepth = 0;
    private txnLabel?: string;
    private stagedBefore?: EditorSnapshot;
    private _lastPolicyDiagnostics?: PolicyDiagnostic[];
    constructor(builder: Builder, api: CanvasAPI, opts: EditorOptions = {}) {
        this.builder = builder;
        this.api = api;
        // @ts-ignore
        this.opts = {
            historyLimit: Math.max(
                1,
                Math.min(opts.historyLimit ?? MAX_LIMIT, 1000),
            ),
            validateAfterEach: opts.validateAfterEach ?? false,
        };
        // seed initial snapshot
        this.pushHistory(this.makeSnapshot("init"));
    }

    /* ───────────────────────── Public API ───────────────────────── */

    getProps(): ServiceProps {
        return this.builder.getProps();
    }

    transact(label: string, fn: () => void): void {
        const wasTop = this.txnDepth === 0;
        let ok = false;
        if (wasTop) {
            this.txnLabel = label;
            this.stagedBefore = this.makeSnapshot(label + ":before");
        }
        this.txnDepth++;
        try {
            fn();
            ok = true;
        } finally {
            this.txnDepth--;
            if (wasTop) {
                if (ok) {
                    this.commit(label); // push one history entry
                } else if (this.stagedBefore) {
                    this.loadSnapshot(this.stagedBefore, "undo"); // rollback to pre-txn state
                }
                this.txnLabel = undefined;
                this.stagedBefore = undefined;
            }
        }
    }

    exec(cmd: Command): void {
        try {
            const before = this.makeSnapshot(cmd.name + ":before");
            cmd.do();
            this.afterMutation(cmd.name, before);
        } catch (err) {
            this.emit("editor:error", {
                message: (err as Error)?.message ?? String(err),
                code: "command",
            });
            throw err;
        }
    }

    undo(): boolean {
        if (this.index <= 0) return false;
        this.index--;
        this.loadSnapshot(this.history[this.index], "undo");
        this.emit("editor:undo", {
            stackSize: this.history.length,
            index: this.index,
        });
        return true;
    }

    redo(): boolean {
        if (this.index >= this.history.length - 1) return false;
        this.index++;
        this.loadSnapshot(this.history[this.index], "redo");
        this.emit("editor:redo", {
            stackSize: this.history.length,
            index: this.index,
        });
        return true;
    }

    clearService(id: string) {
        this.setService(id, { service_id: undefined });
    }

    /* ───────────── Convenience editing ops (command-wrapped) ───────────── */
    duplicate(ref: NodeRef, opts: DuplicateOptions = {}): string {
        const snapBefore = this.makeSnapshot("duplicate:before");
        try {
            let newId = "";
            this.transact("duplicate", () => {
                if (ref.kind === "tag") {
                    newId = this.duplicateTag(ref.id, opts);
                } else if (ref.kind === "field") {
                    newId = this.duplicateField(ref.id, opts);
                } else {
                    newId = this.duplicateOption(ref.fieldId, ref.id, opts);
                }
            });
            return newId;
        } catch (err) {
            // rollback to be safe
            this.loadSnapshot(snapBefore, "undo");
            throw err;
        }
    }

    /**
     * Update the display label for a node and refresh the graph so node labels stay in sync.
     * Supports: tag ("t:*"), field ("f:*"), option ("o:*").
     * IDs are NOT changed; only the human-readable label.
     */
    reLabel(id: string, nextLabel: string): void {
        const label = String(nextLabel ?? "").trim();

        this.exec({
            name: "reLabel",
            do: () =>
                this.patchProps((p) => {
                    // Tag
                    if (isTagId(id)) {
                        const t = (p.filters ?? []).find((x) => x.id === id);
                        if (!t) return;
                        if ((t.label ?? "") === label) return;
                        t.label = label;
                        // graph nodes mirror builder, so rebuild
                        this.api.refreshGraph();
                        return;
                    }

                    // Option (find owner field → option)
                    if (isOptionId(id)) {
                        const own = ownerOfOption(p, id);
                        if (!own) return;
                        const f = (p.fields ?? []).find(
                            (x) => x.id === own.fieldId,
                        );
                        const o = f?.options?.find((x) => x.id === id);
                        if (!o) return;
                        if ((o.label ?? "") === label) return;
                        o.label = label;
                        this.api.refreshGraph();
                        return;
                    }

                    // Field (default)
                    const fld = (p.fields ?? []).find((x) => x.id === id);
                    if (!fld) return;
                    if ((fld.label ?? "") === label) return;
                    fld.label = label;
                    this.api.refreshGraph();
                }),
            undo: () => this.api.undo(),
        });
    }

    /**
     * Assign or change a field's `name`. Only allowed when the field (and its options) have NO service mapping.
     * - If `nextName` is empty/blank → removes the `name`.
     * - Emits an error if the field or any of its options carry a `service_id`.
     * - Emits an error if `nextName` collides with an existing field's name (case-sensitive).
     */
    setFieldName(fieldId: string, nextName: string | null | undefined): void {
        const raw = typeof nextName === "string" ? nextName : "";
        const name = raw.trim();

        this.exec({
            name: "setFieldName",
            do: () =>
                this.patchProps((p) => {
                    const fields = p.fields ?? [];
                    const f = fields.find((x) => x.id === fieldId);
                    if (!f) {
                        this.api.emit("error", {
                            code: "field_not_found",
                            message: `Field not found: ${fieldId}`,
                            meta: { fieldId },
                        });
                        return;
                    }

                    // Disallow if the field itself maps to a service
                    const fieldHasService =
                        typeof (f as any).service_id === "number";

                    // Disallow if any option maps to a service
                    const optionHasService = Array.isArray(f.options)
                        ? f.options.some(
                              (o) => typeof (o as any).service_id === "number",
                          )
                        : false;

                    if (fieldHasService || optionHasService) {
                        this.api.emit("error", {
                            code: "field_has_service_mapping",
                            message:
                                "Cannot set a name on a field that maps to a service (either the field or one of its options has a service_id).",
                            meta: {
                                fieldId,
                                fieldHasService,
                                optionHasService,
                            },
                        });
                        return;
                    }

                    // If clearing, remove the key to keep payload lean
                    if (name.length === 0) {
                        if ("name" in f) delete (f as any).name;
                        return;
                    }

                    // Prevent name collisions with other fields
                    const collision = fields.find(
                        (x) => x.id !== fieldId && (x.name ?? "") === name,
                    );
                    if (collision) {
                        this.api.emit("error", {
                            code: "field_name_collision",
                            message: `Another field already uses the name "${name}".`,
                            meta: { fieldId, otherFieldId: collision.id },
                        });
                        return;
                    }

                    // Assign
                    (f as any).name = name;
                }),
            undo: () => this.api.undo(),
        });
    }
    getLastPolicyDiagnostics(): PolicyDiagnostic[] | undefined {
        return this._lastPolicyDiagnostics;
    }
    /* ───────────────────── Internals: duplicate impls ───────────────────── */

    private duplicateTag(tagId: string, opts: DuplicateOptions): string {
        const props = this.builder.getProps();
        const tags = props.filters ?? [];
        const src = tags.find((t) => t.id === tagId);
        if (!src) throw new Error(`Tag not found: ${tagId}`);

        // generate new id + label
        const id = opts.id ?? this.uniqueId(src.id);
        const label = (opts.labelStrategy ?? nextCopyLabel)(src.label ?? id);

        if (!opts.withChildren) {
            // shallow copy
            this.patchProps((p) => {
                const clone = { ...src, id, label };
                // keep same parent
                clone.bind_id = src.bind_id;
                // includes/excludes are field ids—copy them as-is
                clone.constraints_overrides = undefined;
                clone.constraints_origin = undefined;
                // insert after original among siblings: we can rebuild array with splice
                const arr = p.filters ?? [];
                const idx = arr.findIndex((t) => t.id === tagId);
                arr.splice(idx + 1, 0, clone);
                p.filters = arr;
            });
            return id;
        }

        // deep clone subtree: map oldTagId -> newTagId
        const idMap = new Map<string, string>();
        const collect = (t: typeof src, acc: (typeof src)[]) => {
            acc.push(t);
            for (const child of tags.filter((x) => x.bind_id === t.id))
                collect(child as any, acc);
        };
        const subtree: (typeof src)[] = [];
        collect(src, subtree);

        // allocate ids
        for (const n of subtree)
            idMap.set(n.id, n.id === src.id ? id : this.uniqueId(n.id));

        // build clones
        const clones = subtree.map((n) => {
            const cloned = { ...n };
            cloned.id = idMap.get(n.id)!;
            cloned.label =
                n.id === src.id
                    ? label
                    : (opts.labelStrategy ?? nextCopyLabel)(n.label ?? n.id);

            // rewire parent if parent is in subtree
            cloned.bind_id = n.bind_id
                ? (idMap.get(n.bind_id) ?? n.bind_id)
                : undefined;

            // scrub derived meta (will be re-created by normalise)
            cloned.constraints_origin = undefined;
            cloned.constraints_overrides = undefined;
            return cloned;
        });

        this.patchProps((p) => {
            const arr = p.filters ?? [];
            // insert root clone after original
            const rootIdx = arr.findIndex((t) => t.id === tagId);
            arr.splice(rootIdx + 1, 0, clones[0] as any);
            // append other clones (order: parent before children to keep grouping stable)
            for (const c of clones.slice(1)) arr.push(c as any);
            p.filters = arr;
        });

        return id;
    }

    private duplicateField(fieldId: string, opts: DuplicateOptions): string {
        const props = this.builder.getProps();
        const fields = props.fields ?? [];
        const src = fields.find((f) => f.id === fieldId);
        if (!src) throw new Error(`Field not found: ${fieldId}`);

        const id = opts.id ?? this.uniqueId(src.id);
        const label = (opts.labelStrategy ?? nextCopyLabel)(src.label ?? id);
        const name = opts.nameStrategy
            ? opts.nameStrategy(src.name)
            : nextCopyName(src.name);

        // helper to create new option ids
        const optId = (old: string) =>
            this.uniqueOptionId(
                id,
                (opts.optionIdStrategy ?? defaultOptionIdStrategy)(old),
            );

        // deep copy options with new ids
        const clonedOptions = (src.options ?? []).map((o) => ({
            ...o,
            id: optId(o.id),
            label: (opts.labelStrategy ?? nextCopyLabel)(o.label ?? o.id),
        }));

        const cloned = {
            ...src,
            id,
            label,
            name,
            bind_id: (opts.copyBindings ?? true) ? src.bind_id : undefined,
            options: clonedOptions,
        } as typeof src;

        // map: oldOptId -> newOptId (only if options exist)
        const optionIdMap = new Map<string, string>();
        (src.options ?? []).forEach((o, i) => {
            const newOptId = clonedOptions[i]?.id ?? o.id;
            optionIdMap.set(o.id, newOptId);
        });

        this.patchProps((p) => {
            // insert clone after original
            const arr = p.fields ?? [];
            const idx = arr.findIndex((f) => f.id === fieldId);
            arr.splice(idx + 1, 0, cloned as any);
            p.fields = arr;

            // copy tag-level includes/excludes (field ids)
            if (opts.copyIncludesExcludes) {
                for (const t of p.filters ?? []) {
                    if (t.includes?.includes(fieldId)) {
                        const s = new Set(t.includes);
                        s.add(id);
                        t.includes = Array.from(s);
                    }
                    if (t.excludes?.includes(fieldId)) {
                        const s = new Set(t.excludes);
                        s.add(id);
                        t.excludes = Array.from(s);
                    }
                }
            }

            // copy button maps (keys are only field ids OR option ids)
            if (opts.copyOptionMaps) {
                const maps: Array<
                    "includes_for_buttons" | "excludes_for_buttons"
                > = ["includes_for_buttons", "excludes_for_buttons"];

                for (const mapKey of maps) {
                    const srcMap = (p as any)[mapKey] ?? {};
                    const nextMap: Record<string, string[]> = { ...srcMap };

                    for (const [key, targets] of Object.entries(
                        srcMap as Record<string, string[]>,
                    )) {
                        // A) non-option button: key === original field id → duplicate under new field id
                        if (key === fieldId) {
                            const newKey = id;
                            const merged = new Set([
                                ...(nextMap[newKey] ?? []),
                                ...targets,
                            ]);
                            nextMap[newKey] = Array.from(merged);
                            continue;
                        }

                        // B) option button: key === one of the original option ids → duplicate under new option id
                        if (optionIdMap.has(key)) {
                            const newKey = optionIdMap.get(key)!;
                            const merged = new Set([
                                ...(nextMap[newKey] ?? []),
                                ...targets,
                            ]);
                            nextMap[newKey] = Array.from(merged);
                        }
                    }

                    (p as any)[mapKey] = nextMap;
                }
            }
        });

        return id;
    }

    private duplicateOption(
        fieldId: string,
        optionId: string,
        opts: DuplicateOptions,
    ): string {
        const props = this.builder.getProps();
        const fields = props.fields ?? [];
        const f = fields.find((x) => x.id === fieldId);
        if (!f) throw new Error(`Field not found: ${fieldId}`);
        const optIdx = (f.options ?? []).findIndex((o) => o.id === optionId);
        if (optIdx < 0)
            throw new Error(`Option not found: ${fieldId}::${optionId}`);
        const src = (f.options ?? [])[optIdx];

        const newId = this.uniqueOptionId(
            fieldId,
            (opts.optionIdStrategy ?? defaultOptionIdStrategy)(src.id),
        );
        const newLabel = (opts.labelStrategy ?? nextCopyLabel)(
            src.label ?? src.id,
        );

        this.patchProps((p) => {
            const fld = (p.fields ?? []).find((x) => x.id === fieldId)!;
            const arr = fld.options ?? [];
            const clone = { ...src, id: newId, label: newLabel };
            arr.splice(optIdx + 1, 0, clone);
            fld.options = arr;

            // Option-level maps are NOT copied by default (safer)
            if (opts.copyOptionMaps) {
                const oldKey = `${fieldId}::${optionId}`;
                const newKey = `${fieldId}::${newId}`;
                for (const mapKey of [
                    "includes_for_buttons",
                    "excludes_for_buttons",
                ] as const) {
                    const m = p[mapKey] ?? {};
                    if (m[oldKey]) {
                        m[newKey] = Array.from(new Set(m[oldKey]));
                        p[mapKey] = m as any;
                    }
                }
            }
        });

        return newId;
    }

    /* ───────────────────── Helpers: uniqueness & naming ───────────────────── */

    private uniqueId(base: string): string {
        const props = this.builder.getProps();
        const taken = new Set<string>([
            ...(props.filters ?? []).map((t) => t.id),
            ...(props.fields ?? []).map((f) => f.id),
        ]);
        let candidate = nextCopyId(base);
        while (taken.has(candidate)) candidate = bumpSuffix(candidate);
        return candidate;
    }

    private uniqueOptionId(fieldId: string, base: string): string {
        const props = this.builder.getProps();
        const fld = (props.fields ?? []).find((f) => f.id === fieldId);
        const taken = new Set((fld?.options ?? []).map((o) => o.id));
        let candidate = base;
        if (taken.has(candidate)) candidate = nextCopyId(candidate);
        while (taken.has(candidate)) candidate = bumpSuffix(candidate);
        return candidate;
    }

    //---------

    /**
     * Reorder a node:
     * - Tag: among its siblings (same bind_id) inside filters[]
     * - Field: inside order_for_tags[scopeTagId] (you must pass scopeTagId)
     * - Option: use placeOption() instead
     */
    placeNode(
        id: string,
        opts: {
            scopeTagId?: string;
            beforeId?: string;
            afterId?: string;
            index?: number;
        },
    ) {
        if (isTagId(id)) {
            // … your existing tag sibling reorder logic …
            this.exec({
                name: "placeTag",
                do: () =>
                    this.patchProps((p) => {
                        const all = p.filters ?? [];
                        const cur = all.find((t) => t.id === id);
                        if (!cur) return;
                        const groupKey = cur.bind_id ?? "__root__";
                        const siblings = all.filter(
                            (t) => (t.bind_id ?? "__root__") === groupKey,
                        );

                        const curIdx = siblings.findIndex((t) => t.id === id);
                        if (curIdx < 0) return;
                        const pulled = siblings.splice(curIdx, 1)[0];

                        let dest =
                            typeof opts.index === "number"
                                ? opts.index
                                : undefined;
                        if (opts.beforeId)
                            dest = Math.max(
                                0,
                                siblings.findIndex(
                                    (t) => t.id === opts.beforeId,
                                ),
                            );
                        if (opts.afterId)
                            dest = Math.min(
                                siblings.length,
                                siblings.findIndex(
                                    (t) => t.id === opts.afterId,
                                ) + 1,
                            );
                        if (dest === undefined || Number.isNaN(dest))
                            dest = siblings.length;

                        // stitch back: leave other groups untouched, replace this group in order
                        const out: Tag[] = [];
                        for (const t of all) {
                            const sameGroup =
                                (t.bind_id ?? "__root__") === groupKey;
                            if (!sameGroup) {
                                out.push(t);
                            }
                            // if (!used.has(t.id) && t.id !== id) continue; // skip old group entries
                        }
                        siblings.splice(dest, 0, pulled);
                        p.filters = [...out, ...siblings];
                    }),
                undo: () => this.api.undo(),
            });
        } else if (isFieldId(id)) {
            if (!opts.scopeTagId)
                throw new Error("placeNode(field): scopeTagId is required");
            const fieldId = id;
            const tagId = opts.scopeTagId;

            this.exec({
                name: "placeField",
                do: () =>
                    this.patchProps((p) => {
                        const map = (p.order_for_tags ??= {});
                        const arr = (map[tagId] ??= []);
                        const curIdx = arr.indexOf(fieldId);
                        if (curIdx >= 0) arr.splice(curIdx, 1);

                        let dest =
                            typeof opts.index === "number"
                                ? opts.index
                                : undefined;
                        if (opts.beforeId)
                            dest = Math.max(0, arr.indexOf(opts.beforeId));
                        if (opts.afterId)
                            dest = Math.min(
                                arr.length,
                                arr.indexOf(opts.afterId) + 1,
                            );
                        if (dest === undefined || Number.isNaN(dest))
                            dest = arr.length;

                        arr.splice(dest, 0, fieldId);
                    }),
                undo: () => this.api.undo(),
            });
        } else if (isOptionId(id)) {
            // defer to placeOption for options
            this.placeOption(id, opts);
        } else {
            throw new Error("placeNode: unknown id prefix");
        }
    }

    placeOption(
        optionId: string,
        opts: { beforeId?: string; afterId?: string; index?: number },
    ) {
        if (!isOptionId(optionId))
            throw new Error('placeOption: optionId must start with "o:"');

        this.exec({
            name: "placeOption",
            do: () =>
                this.patchProps((p) => {
                    const owner = ownerOfOption(p, optionId);
                    if (!owner) return;
                    const f = (p.fields ?? []).find(
                        (x) => x.id === owner.fieldId,
                    );
                    if (!f?.options) return;

                    const curIdx = f.options.findIndex(
                        (o) => o.id === optionId,
                    );
                    if (curIdx < 0) return;

                    const pulled = f.options.splice(curIdx, 1)[0];

                    let dest =
                        typeof opts.index === "number" ? opts.index : undefined;
                    if (opts.beforeId)
                        dest = Math.max(
                            0,
                            f.options.findIndex((o) => o.id === opts.beforeId),
                        );
                    if (opts.afterId)
                        dest = Math.min(
                            f.options.length,
                            f.options.findIndex((o) => o.id === opts.afterId) +
                                1,
                        );
                    if (dest === undefined || Number.isNaN(dest))
                        dest = f.options.length;

                    f.options.splice(dest, 0, pulled);
                }),
            undo: () => this.api.undo(),
        });
    }

    addOption(
        fieldId: string,
        input: {
            id?: string;
            label: string;
            service_id?: number;
            pricing_role?: "base" | "utility" | "addon";
            [k: string]: any;
        },
    ): string {
        // decide id up-front so we can return synchronously
        const id = input.id ?? this.genId("o");

        this.exec({
            name: "addOption",
            do: () =>
                this.patchProps((p) => {
                    const f = (p.fields ?? []).find((x) => x.id === fieldId);
                    if (!f)
                        throw new Error(
                            `addOption: field '${fieldId}' not found`,
                        );
                    const list = (f.options ??= []);
                    if (list.some((o) => o.id === id))
                        throw new Error(`Option id '${id}' already exists`);
                    // @ts-ignore
                    list.push({ ...input, id });
                }),
            undo: () => this.api.undo(),
        });

        return id;
    }

    updateOption(
        optionId: string,
        patch: Partial<
            {
                label: string;
                service_id: number;
                pricing_role: "base" | "utility" | "addon";
            } & Record<string, any>
        >,
    ) {
        if (!isOptionId(optionId))
            throw new Error('updateOption: optionId must start with "o:"');
        this.exec({
            name: "updateOption",
            do: () =>
                this.patchProps((p) => {
                    const owner = ownerOfOption(p, optionId);
                    if (!owner) return;
                    const f = (p.fields ?? []).find(
                        (x) => x.id === owner.fieldId,
                    );
                    if (!f?.options) return;
                    const o = f.options.find((x) => x.id === optionId);
                    if (o) Object.assign(o, patch);
                }),
            undo: () => this.api.undo(),
        });
    }

    removeOption(optionId: string) {
        if (!isOptionId(optionId))
            throw new Error('removeOption: optionId must start with "o:"');
        this.exec({
            name: "removeOption",
            do: () =>
                this.patchProps((p) => {
                    const owner = ownerOfOption(p, optionId);
                    if (!owner) return;
                    const f = (p.fields ?? []).find(
                        (x) => x.id === owner.fieldId,
                    );
                    if (!f?.options) return;
                    f.options = f.options.filter((o) => o.id !== optionId);

                    // prune option-level include/exclude maps keyed by the option id
                    const maps: Array<
                        "includes_for_options" | "excludes_for_options"
                    > = ["includes_for_options", "excludes_for_options"];
                    for (const m of maps) {
                        const map = (p as any)[m] as
                            | Record<string, string[]>
                            | undefined;
                        if (!map) continue;
                        if (map[optionId]) delete map[optionId];
                        if (!Object.keys(map).length) delete (p as any)[m];
                    }
                }),
            undo: () => this.api.undo(),
        });
    }

    editLabel(id: string, label: string): void {
        const next = (label ?? "").trim();
        if (!next) throw new Error("Label cannot be empty");

        this.exec({
            name: "editLabel",
            do: () =>
                this.patchProps((p) => {
                    if (isTagId(id)) {
                        const t = (p.filters ?? []).find((x) => x.id === id);
                        if (t) t.label = next;
                        return;
                    }
                    if (isFieldId(id)) {
                        const f = (p.fields ?? []).find((x) => x.id === id);
                        if (f) f.label = next;
                        return;
                    }
                    if (isOptionId(id)) {
                        const own = ownerOfOption(p, id);
                        if (!own) return;
                        const f = (p.fields ?? []).find(
                            (x) => x.id === own.fieldId,
                        );
                        const o = f?.options?.find((x) => x.id === id);
                        if (o) o.label = next;
                        return;
                    }
                    throw new Error("editLabel: unsupported id");
                }),
            undo: () => this.api.undo(),
        });
    }

    editName(fieldId: string, name: string | undefined) {
        this.exec({
            name: "editName",
            do: () =>
                this.patchProps((p) => {
                    const f = (p.fields ?? []).find((x) => x.id === fieldId);
                    if (!f) return;
                    f.name = name;
                }),
            undo: () => this.api.undo(),
        });
    }

    setService(
        id: string,
        input: { service_id?: number; pricing_role?: "base" | "utility" },
    ): void {
        this.exec({
            name: "setService",
            do: () =>
                this.patchProps((p) => {
                    const hasSidKey = Object.prototype.hasOwnProperty.call(
                        input,
                        "service_id",
                    );
                    const validId =
                        hasSidKey &&
                        typeof input.service_id === "number" &&
                        Number.isFinite(input.service_id);
                    const sid: number | undefined = validId
                        ? Number(input.service_id)
                        : undefined;
                    const nextRole = input.pricing_role;

                    // ── TAG ───────────────────────────────────────────────────
                    if (isTagId(id)) {
                        const t = (p.filters ?? []).find((x) => x.id === id);
                        if (!t) return;

                        // role not applicable for tags
                        if (hasSidKey) {
                            if (sid === undefined) delete (t as any).service_id;
                            else t.service_id = sid;
                        }
                        return;
                    }

                    // ── OPTION ───────────────────────────────────────────────
                    if (isOptionId(id)) {
                        const own = ownerOfOption(p, id);
                        if (!own) return;
                        const f = (p.fields ?? []).find(
                            (x) => x.id === own.fieldId,
                        );
                        const o = f?.options?.find((x) => x.id === id);
                        if (!o) return;

                        const currentRole = (o.pricing_role ?? "base") as
                            | "base"
                            | "utility";
                        const role = nextRole ?? currentRole;

                        if (role === "utility") {
                            // Utilities cannot have service_id, and if switching to utility, strip any existing sid.
                            if (hasSidKey && sid !== undefined) {
                                this.api.emit("error", {
                                    message:
                                        "Utilities cannot have service_id (option).",
                                    code: "utility_service_conflict",
                                    meta: { id, service_id: sid },
                                });
                            }
                            o.pricing_role = "utility";
                            if ("service_id" in o) delete (o as any).service_id;
                            return;
                        }

                        // role === 'base'
                        if (nextRole) o.pricing_role = "base";
                        if (hasSidKey) {
                            if (sid === undefined) delete (o as any).service_id;
                            else o.service_id = sid;
                        }
                        return;
                    }

                    // ── FIELD (button-able) ─────────────────────────────────
                    // Field ids usually look like "f:*" in your project; we’ll treat any non-tag/non-option as field.
                    const f = (p.fields ?? []).find((x) => x.id === id);
                    if (!f) {
                        throw new Error(
                            'setService only supports tag ("t:*"), option ("o:*"), or field ("f:*") ids',
                        );
                    }

                    const isOptionBased =
                        Array.isArray(f.options) && f.options.length > 0;
                    const isButton = !!(f as any).button;

                    // Move/normalize role at field level if provided
                    if (nextRole) {
                        f.pricing_role = nextRole;
                    }
                    const effectiveRole = (f.pricing_role ?? "base") as
                        | "base"
                        | "utility";

                    // If the field is option-based, services must live on options, not on the field.
                    if (isOptionBased) {
                        if (hasSidKey) {
                            this.api.emit("error", {
                                message:
                                    "Cannot set service_id on an option-based field. Assign service_id on its options instead.",
                                code: "field_option_based_service_forbidden",
                                meta: { id, service_id: sid },
                            });
                        }
                        // Still allow changing pricing_role at field level (acts as a default for options),
                        // but never write/keep service_id on the field itself.
                        if ("service_id" in (f as any))
                            delete (f as any).service_id;
                        return;
                    }

                    // For non-option fields, only "button" fields are allowed to carry a service_id.
                    if (!isButton) {
                        if (hasSidKey) {
                            this.api.emit("error", {
                                message:
                                    "Only button fields (without options) can have a service_id.",
                                code: "non_button_field_service_forbidden",
                                meta: { id, service_id: sid },
                            });
                        }
                        // Ensure we don't keep any stray sid
                        if ("service_id" in (f as any))
                            delete (f as any).service_id;
                        return;
                    }

                    // Button field + role checks
                    if (effectiveRole === "utility") {
                        // Utilities cannot have service_id at all.
                        if (hasSidKey && sid !== undefined) {
                            this.api.emit("error", {
                                message:
                                    "Utilities cannot have service_id (field).",
                                code: "utility_service_conflict",
                                meta: { id, service_id: sid },
                            });
                        }
                        if ("service_id" in (f as any))
                            delete (f as any).service_id;
                        return;
                    }

                    // Button field with role 'base' → allow setting/clearing sid
                    if (hasSidKey) {
                        if (sid === undefined) delete (f as any).service_id;
                        else (f as any).service_id = sid;
                    }
                }),
            undo: () => this.api.undo(),
        });
    }

    addTag(
        partial: Omit<Tag, "id" | "label"> & { id?: string; label: string },
    ) {
        const id = partial.id ?? this.genId("t");
        const payload = { ...partial, id };
        this.exec({
            name: "addTag",
            do: () =>
                this.patchProps((p) => {
                    p.filters = [...(p.filters ?? []), payload];
                }),
            undo: () =>
                this.patchProps((p) => {
                    p.filters = (p.filters ?? []).filter((t) => t.id !== id);
                }),
        });
    }

    updateTag(id: string, patch: Partial<Tag>) {
        let prev: Tag | undefined;
        this.exec({
            name: "updateTag",
            do: () =>
                this.patchProps((p) => {
                    p.filters = (p.filters ?? []).map((t) => {
                        if (t.id !== id) return t;
                        prev = t;
                        return { ...t, ...patch };
                    });
                }),
            undo: () =>
                this.patchProps((p) => {
                    p.filters = (p.filters ?? []).map((t) =>
                        t.id === id && prev ? prev : t,
                    );
                }),
        });
    }

    removeTag(id: string) {
        let prevSlice!: ServiceProps;
        this.exec({
            name: "removeTag",
            do: () =>
                this.patchProps((p) => {
                    prevSlice = cloneDeep(p);
                    // noinspection DuplicatedCode
                    p.filters = (p.filters ?? []).filter((t) => t.id !== id);
                    // drop references
                    for (const t of p.filters ?? []) {
                        if (t.bind_id === id) delete t.bind_id;
                        t.includes = (t.includes ?? []).filter((x) => x !== id);
                        t.excludes = (t.excludes ?? []).filter((x) => x !== id);
                    }
                    for (const f of p.fields ?? []) {
                        if (Array.isArray(f.bind_id))
                            f.bind_id = f.bind_id.filter((x) => x !== id);
                        else if (f.bind_id === id) delete f.bind_id;
                    }
                }),
            undo: () => this.replaceProps(prevSlice),
        });
    }

    addField(
        partial: Omit<Field, "id" | "label" | "type"> & {
            id?: string;
            label: string;
            type: Field["type"];
        },
    ) {
        const id = partial.id ?? this.genId("f");
        const payload = { ...partial, id };
        this.exec({
            name: "addField",
            do: () =>
                this.patchProps((p) => {
                    p.fields = [...(p.fields ?? []), payload as Field];
                }),
            undo: () =>
                this.patchProps((p) => {
                    p.fields = (p.fields ?? []).filter((f) => f.id !== id);
                }),
        });
    }

    updateField(id: string, patch: Partial<Field>) {
        let prev: Field | undefined;
        this.exec({
            name: "updateField",
            do: () =>
                this.patchProps((p) => {
                    // @ts-ignore
                    p.fields = (p.fields ?? []).map((f) => {
                        if (f.id !== id) return f;
                        prev = f;
                        return { ...f, ...patch };
                    });
                }),
            undo: () =>
                this.patchProps((p) => {
                    p.fields = (p.fields ?? []).map((f) =>
                        f.id === id && prev ? prev : f,
                    );
                }),
        });
    }

    removeField(id: string) {
        let prevSlice!: ServiceProps;
        this.exec({
            name: "removeField",
            do: () =>
                this.patchProps((p) => {
                    prevSlice = cloneDeep(p);
                    p.fields = (p.fields ?? []).filter((f) => f.id !== id);
                    // prune option maps that reference this field
                    for (const mapKey of [
                        "includes_for_buttons",
                        "excludes_for_buttons",
                    ] as const) {
                        const m = p[mapKey];
                        if (!m) continue;
                        for (const k of Object.keys(m)) {
                            m[k] = (m[k] ?? []).filter((fid) => fid !== id);
                            if (!m[k]?.length) delete m[k];
                        }
                    }
                    for (const t of p.filters ?? []) {
                        t.includes = (t.includes ?? []).filter((x) => x !== id);
                        t.excludes = (t.excludes ?? []).filter((x) => x !== id);
                    }
                }),
            undo: () => this.replaceProps(prevSlice),
        });
    }

    remove(id: string) {
        if (isTagId(id)) {
            this.exec({
                name: "removeTag",
                do: () =>
                    this.patchProps((p) => {
                        // noinspection DuplicatedCode
                        p.filters = (p.filters ?? []).filter(
                            (t) => t.id !== id,
                        );

                        // detach children + prune includes/excludes references
                        for (const t of p.filters ?? []) {
                            if (t.bind_id === id) delete t.bind_id;
                            t.includes = (t.includes ?? []).filter(
                                (x) => x !== id,
                            );
                            t.excludes = (t.excludes ?? []).filter(
                                (x) => x !== id,
                            );
                        }

                        // remove tag from field.bind_id arrays
                        for (const f of p.fields ?? []) {
                            if (Array.isArray(f.bind_id))
                                f.bind_id = f.bind_id.filter(
                                    (x) => x !== id,
                                ) as any;
                            else if (f.bind_id === id) delete f.bind_id;
                        }

                        // prune per-tag ordering entry and stale field ids
                        if (p.order_for_tags?.[id]) delete p.order_for_tags[id];
                        for (const k of Object.keys(p.order_for_tags ?? {})) {
                            p.order_for_tags![k] = (
                                p.order_for_tags![k] ?? []
                            ).filter((fid) =>
                                (p.fields ?? []).some((f) => f.id === fid),
                            );
                            if (!p.order_for_tags![k].length)
                                delete p.order_for_tags![k];
                        }
                    }),
                undo: () => this.api.undo(),
            });
            return;
        }

        if (isFieldId(id)) {
            this.exec({
                name: "removeField",
                do: () =>
                    this.patchProps((p) => {
                        p.fields = (p.fields ?? []).filter((f) => f.id !== id);

                        // prune tag includes/excludes
                        for (const t of p.filters ?? []) {
                            t.includes = (t.includes ?? []).filter(
                                (x) => x !== id,
                            );
                            t.excludes = (t.excludes ?? []).filter(
                                (x) => x !== id,
                            );
                        }

                        // prune per-tag ordering
                        for (const k of Object.keys(p.order_for_tags ?? {})) {
                            p.order_for_tags![k] = (
                                p.order_for_tags![k] ?? []
                            ).filter((fid) => fid !== id);
                            if (!p.order_for_tags![k].length)
                                delete p.order_for_tags![k];
                        }

                        // prune option maps that reference this field id
                        const maps: Array<
                            "includes_for_options" | "excludes_for_options"
                        > = ["includes_for_options", "excludes_for_options"];
                        for (const m of maps) {
                            const map = (p as any)[m] as
                                | Record<string, string[]>
                                | undefined;
                            if (!map) continue;
                            for (const key of Object.keys(map)) {
                                map[key] = (map[key] ?? []).filter(
                                    (fid) => fid !== id,
                                );
                                if (!map[key]?.length) delete map[key];
                            }
                            if (!Object.keys(map).length) delete (p as any)[m];
                        }
                    }),
                undo: () => this.api.undo(),
            });
            return;
        }

        if (isOptionId(id)) {
            this.removeOption(id);
            return;
        }

        throw new Error("remove: unknown id prefix");
    }

    getNode(
        id: string,
    ):
        | { kind: "tag"; data?: Tag; owners: { parentTagId?: string } }
        | { kind: "field"; data?: Field; owners: { bindTagIds: string[] } }
        | { kind: "option"; data?: any; owners: { fieldId?: string } } {
        const props = this.builder.getProps();
        if (isTagId(id)) {
            const t = (props.filters ?? []).find((x) => x.id === id);
            return {
                kind: "tag",
                data: t,
                owners: { parentTagId: t?.bind_id },
            };
        }
        if (isFieldId(id)) {
            const f = (props.fields ?? []).find((x) => x.id === id);
            const bind = Array.isArray(f?.bind_id)
                ? (f!.bind_id as string[])
                : f?.bind_id
                  ? [f.bind_id]
                  : [];
            return { kind: "field", data: f, owners: { bindTagIds: bind } };
        }
        if (isOptionId(id)) {
            const own = ownerOfOption(props, id);
            const f = own
                ? (props.fields ?? []).find((x) => x.id === own.fieldId)
                : undefined;
            const o = f?.options?.find((x) => x.id === id);
            return {
                kind: "option",
                data: o,
                owners: { fieldId: own?.fieldId },
            };
        }
        // you can extend for service lookup if desired
        return { kind: "option", data: undefined, owners: {} };
    }

    getFieldQuantityRule(id: string): QuantityRule | undefined {
        const props = this.builder.getProps();
        const f = (props.fields ?? []).find((x) => x.id === id);
        if (!f) return undefined;
        return normalizeQuantityRule((f as any).meta?.quantity);
    }

    setFieldQuantityRule(id: string, rule: unknown): void {
        this.exec({
            name: "setFieldQuantityRule",
            do: () =>
                this.patchProps((p) => {
                    const f = (p.fields ?? []).find((x) => x.id === id);
                    if (!f) return;

                    const normalized = normalizeQuantityRule(rule);

                    if (!normalized) {
                        // Drop invalid shapes entirely
                        if ((f as any).meta?.quantity !== undefined) {
                            delete (f as any).meta.quantity;
                            // Clean up empty meta object
                            if (
                                (f as any).meta &&
                                Object.keys((f as any).meta).length === 0
                            ) {
                                delete (f as any).meta;
                            }
                        }
                        return;
                    }

                    // Keep other meta keys intact
                    (f as any).meta = {
                        ...(f as any).meta,
                        quantity: normalized,
                    };
                }),
            undo: () => this.api.undo(),
        });
    }

    clearFieldQuantityRule(id: string): void {
        this.exec({
            name: "clearFieldQuantityRule",
            do: () =>
                this.patchProps((p) => {
                    const f = (p.fields ?? []).find((x) => x.id === id);
                    if (!f || !(f as any).meta?.quantity) return;
                    delete (f as any).meta.quantity;
                    if (
                        (f as any).meta &&
                        Object.keys((f as any).meta).length === 0
                    ) {
                        delete (f as any).meta;
                    }
                }),
            undo: () => this.api.undo(),
        });
    }

    /** Walk ancestors for a tag and detect if parent→child would create a cycle */
    private wouldCreateTagCycle(
        p: ServiceProps,
        parentId: string,
        childId: string,
    ): boolean {
        if (parentId === childId) return true;
        const tagById = new Map((p.filters ?? []).map((t) => [t.id, t]));
        let cur: string | undefined = parentId;
        const guard = new Set<string>();
        while (cur) {
            if (cur === childId) return true; // child is ancestor of parent → cycle
            if (guard.has(cur)) break;
            guard.add(cur);
            cur = tagById.get(cur)?.bind_id;
        }
        return false;
    }

    /* ──────────────────────────────────────────────────────────────────────────
     * CONNECT
     * ────────────────────────────────────────────────────────────────────────── */
    connect(kind: WireKind, fromId: string, toId: string): void {
        this.exec({
            name: `connect:${kind}`,
            do: () =>
                this.patchProps((p) => {
                    /* ── BIND ─────────────────────────────────────────────── */
                    if (kind === "bind") {
                        // Tag → Tag: set child.bind_id = parent (cycle-safe)
                        if (isTagId(fromId) && isTagId(toId)) {
                            if (this.wouldCreateTagCycle(p, fromId, toId)) {
                                throw new Error(
                                    `bind would create a cycle: ${fromId} → ${toId}`,
                                );
                            }
                            const child = (p.filters ?? []).find(
                                (t) => t.id === toId,
                            );
                            if (child) child.bind_id = fromId;
                            return;
                        }
                        // Tag → Field (or Field → Tag): ensure field.bind_id contains the tag
                        if (
                            (isTagId(fromId) && isFieldId(toId)) ||
                            (isFieldId(fromId) && isTagId(toId))
                        ) {
                            const fieldId = isFieldId(toId) ? toId : fromId;
                            const tagId = isTagId(fromId) ? fromId : toId;
                            const f = (p.fields ?? []).find(
                                (x) => x.id === fieldId,
                            );
                            if (!f) return;
                            if (!f.bind_id) {
                                f.bind_id = tagId;
                                return;
                            }
                            if (typeof f.bind_id === "string") {
                                if (f.bind_id !== tagId)
                                    f.bind_id = [f.bind_id, tagId];
                                return;
                            }
                            if (!f.bind_id.includes(tagId))
                                f.bind_id.push(tagId);
                            return;
                        }
                        throw new Error(
                            `bind: unsupported route ${fromId} → ${toId}`,
                        );
                    }

                    /* ── INCLUDE / EXCLUDE (Tag→Field, Option→Field) ──────── */
                    if (kind === "include" || kind === "exclude") {
                        const key =
                            kind === "include" ? "includes" : "excludes";

                        // Tag → Field: mutate tag.includes/excludes
                        if (isTagId(fromId) && isFieldId(toId)) {
                            const t = (p.filters ?? []).find(
                                (x) => x.id === fromId,
                            );
                            if (!t) return;
                            const arr = (t[key] ??= []);
                            if (!arr.includes(toId)) arr.push(toId);
                            return;
                        }

                        // Option → Field: mutate includes_for_options / excludes_for_options using optionId
                        if (isOptionId(fromId) && isFieldId(toId)) {
                            const mapKey =
                                kind === "include"
                                    ? "includes_for_options"
                                    : "excludes_for_options";
                            const maps = (p as any)[mapKey] as
                                | Record<string, string[]>
                                | undefined;
                            const next = { ...(maps ?? {}) };
                            const arr = next[fromId] ?? [];
                            if (!arr.includes(toId)) arr.push(toId);
                            next[fromId] = arr;
                            (p as any)[mapKey] = next;
                            return;
                        }

                        throw new Error(
                            `${kind}: unsupported route ${fromId} → ${toId}`,
                        );
                    }

                    /* ── SERVICE (Service→Tag | Service→Option) ───────────── */
                    // inside connect(kind, from, to)
                    if (kind === "service") {
                        // ONLY ensure it exists; no type checks/parsing
                        ensureServiceExists(this.opts, fromId);

                        if (toId.startsWith("t:")) {
                            this.exec({
                                name: "connect:service→tag",
                                do: () =>
                                    this.patchProps((p) => {
                                        const t = (p.filters ?? []).find(
                                            (x) => x.id === toId,
                                        );
                                        if (t) (t as any).service_id = fromId; // store as-is
                                    }),
                                undo: () => this.api.undo(),
                            });
                            return;
                        }

                        if (toId.startsWith("o:")) {
                            this.exec({
                                name: "connect:service→option",
                                do: () =>
                                    this.patchProps((p) => {
                                        for (const f of p.fields ?? []) {
                                            const o = f.options?.find(
                                                (x) => x.id === toId,
                                            );
                                            if (o) {
                                                (o as any).service_id = fromId;
                                                return;
                                            }
                                        }
                                    }),
                                undo: () => this.api.undo(),
                            });
                            return;
                        }

                        throw new Error(
                            'service: to must be a tag ("t:*") or option ("o:*")',
                        );
                    }

                    throw new Error(`Unknown connect kind: ${kind}`);
                }),
            undo: () => this.api.undo(), // snapshot-based undo will restore prior state
        });
    }

    /* ──────────────────────────────────────────────────────────────────────────
     * DISCONNECT
     * ────────────────────────────────────────────────────────────────────────── */
    disconnect(kind: WireKind, fromId: string, toId: string): void {
        this.exec({
            name: `disconnect:${kind}`,
            do: () =>
                this.patchProps((p) => {
                    /* ── BIND ─────────────────────────────────────────────── */
                    if (kind === "bind") {
                        // Tag → Tag
                        if (isTagId(fromId) && isTagId(toId)) {
                            const child = (p.filters ?? []).find(
                                (t) => t.id === toId,
                            );
                            if (child?.bind_id === fromId) delete child.bind_id;
                            return;
                        }
                        // Tag ↔ Field
                        if (
                            (isTagId(fromId) && isFieldId(toId)) ||
                            (isFieldId(fromId) && isTagId(toId))
                        ) {
                            const fieldId = isFieldId(toId) ? toId : fromId;
                            const tagId = isTagId(fromId) ? fromId : toId;
                            const f = (p.fields ?? []).find(
                                (x) => x.id === fieldId,
                            );
                            if (!f?.bind_id) return;
                            if (typeof f.bind_id === "string") {
                                if (f.bind_id === tagId) delete f.bind_id;
                                return;
                            }
                            f.bind_id = f.bind_id.filter(
                                (x) => x !== tagId,
                            ) as any;
                            if (f.bind_id?.length === 0) delete f.bind_id;
                            return;
                        }
                        throw new Error(
                            `unbind: unsupported route ${fromId} → ${toId}`,
                        );
                    }

                    /* ── INCLUDE / EXCLUDE (Tag→Field, Option→Field) ──────── */
                    if (kind === "include" || kind === "exclude") {
                        const key =
                            kind === "include" ? "includes" : "excludes";

                        // Tag → Field
                        if (isTagId(fromId) && isFieldId(toId)) {
                            const t = (p.filters ?? []).find(
                                (x) => x.id === fromId,
                            );
                            if (!t) return;
                            t[key] = (t[key] ?? []).filter((x) => x !== toId);
                            if (!t[key]?.length) delete (t as any)[key];
                            return;
                        }

                        // Option → Field
                        if (isOptionId(fromId) && isFieldId(toId)) {
                            const mapKey =
                                kind === "include"
                                    ? "includes_for_options"
                                    : "excludes_for_options";
                            const maps = (p as any)[mapKey] as
                                | Record<string, string[]>
                                | undefined;
                            if (!maps) return;
                            if (maps[fromId]) {
                                maps[fromId] = (maps[fromId] ?? []).filter(
                                    (fid) => fid !== toId,
                                );
                                if (!maps[fromId]?.length) delete maps[fromId];
                            }
                            if (!Object.keys(maps).length)
                                delete (p as any)[mapKey];
                            return;
                        }

                        throw new Error(
                            `${kind}: unsupported route ${fromId} → ${toId}`,
                        );
                    }

                    /* ── SERVICE (Service→Tag | Service→Option) ───────────── */
                    if (kind === "service") {
                        // STILL only ensure it exists; no type checks/parsing
                        ensureServiceExists(this.opts, fromId);

                        if (toId.startsWith("t:")) {
                            this.exec({
                                name: "disconnect:service→tag",
                                do: () =>
                                    this.patchProps((p) => {
                                        const t = (p.filters ?? []).find(
                                            (x) => x.id === toId,
                                        );
                                        if (t) delete (t as any).service_id;
                                    }),
                                undo: () => this.api.undo(),
                            });
                            return;
                        }

                        if (toId.startsWith("o:")) {
                            this.exec({
                                name: "disconnect:service→option",
                                do: () =>
                                    this.patchProps((p) => {
                                        for (const f of p.fields ?? []) {
                                            const o = f.options?.find(
                                                (x) => x.id === toId,
                                            );
                                            if (o) {
                                                delete (o as any).service_id;
                                                return;
                                            }
                                        }
                                    }),
                                undo: () => this.api.undo(),
                            });
                            return;
                        }

                        throw new Error(
                            'service: to must be a tag ("t:*") or option ("o:*")',
                        );
                    }

                    throw new Error(`Unknown disconnect kind: ${kind}`);
                }),
            undo: () => this.api.undo(),
        });
    }

    setConstraint(
        tagId: string,
        flag: "refill" | "cancel" | "dripfeed",
        value: boolean | undefined,
    ) {
        let prev: boolean | undefined;
        this.exec({
            name: "setConstraint",
            do: () =>
                this.patchProps((p) => {
                    const t = (p.filters ?? []).find((x) => x.id === tagId);
                    if (!t) return;
                    prev = t.constraints?.[flag];
                    if (!t.constraints) t.constraints = {};
                    if (value === undefined) delete t.constraints[flag];
                    else t.constraints[flag] = value;
                }),
            undo: () =>
                this.patchProps((p) => {
                    const t = (p.filters ?? []).find((x) => x.id === tagId);
                    if (!t) return;
                    if (!t.constraints) t.constraints = {};
                    if (prev === undefined) delete t.constraints[flag];
                    else t.constraints[flag] = prev;
                }),
        });
        // After mutation, normalise() will propagate effective constraints & meta
    }

    /* ───────────────────── Internals ───────────────────── */

    private replaceProps(next: ServiceProps): void {
        // Ensure canonical shape + constraint propagation
        const norm = normalise(next);
        this.builder.load(norm);
        this.api.refreshGraph();
    }

    private patchProps(mut: (p: ServiceProps) => void): void {
        const cur = cloneDeep(this.builder.getProps());
        mut(cur);
        this.replaceProps(cur);
    }

    private afterMutation(command: string, _before: EditorSnapshot) {
        if (this.txnDepth > 0) return; // delay until commit()
        this.pushHistory(this.makeSnapshot(command));
        this.emit("editor:command", { name: command });
        if (this.opts.validateAfterEach)
            this.emit("editor:change", {
                props: this.builder.getProps(),
                reason: "validate",
                command,
            });
        else
            this.emit("editor:change", {
                props: this.builder.getProps(),
                reason: "mutation",
                command,
            });
    }

    private commit(label: string) {
        const snap = this.makeSnapshot(label);
        this.pushHistory(snap);
        this.emit("editor:change", {
            props: snap.props,
            reason: "transaction",
            command: this.txnLabel,
        });
    }

    private makeSnapshot(_why: string): EditorSnapshot {
        const props = cloneDeep(this.builder.getProps());
        const canvas = this.api.snapshot();
        return {
            props,
            layout: {
                canvas,
            },
        };
    }

    private loadSnapshot(s: EditorSnapshot, reason: "undo" | "redo") {
        this.builder.load(cloneDeep(s.props));

        const layout = s.layout;
        const canvas = layout?.canvas;

        if (canvas) {
            if (canvas.positions) this.api.setPositions(canvas.positions);
            if (canvas.viewport) this.api.setViewport(canvas.viewport);
            if (canvas.selection)
                this.api.select(
                    Array.isArray(canvas.selection)
                        ? canvas.selection
                        : Array.from(canvas.selection),
                );
        } else {
            this.api.refreshGraph();
        }
        this.emit("editor:change", { props: this.builder.getProps(), reason });
    }

    private pushHistory(snap: EditorSnapshot) {
        // truncate forward
        if (this.index < this.history.length - 1) {
            this.history = this.history.slice(0, this.index + 1);
        }
        this.history.push(snap);
        // trim from start if beyond limit
        const over = this.history.length - this.opts.historyLimit;
        if (over > 0) {
            this.history.splice(0, over);
            this.index = this.history.length - 1;
        } else {
            this.index = this.history.length - 1;
        }
    }

    // IDs like "t:1", "f:2", "o:3" — must be unique across tags, fields, options.
    private genId(prefix: "t" | "f" | "o"): string {
        const props = this.builder.getProps();
        const taken = new Set<string>([
            ...(props.filters ?? []).map((t) => t.id),
            ...(props.fields ?? []).map((f) => f.id),
            ...(props.fields ?? []).flatMap(
                (f) => f.options?.map((o) => o.id) ?? [],
            ),
        ]);
        for (let i = 1; i < 10_000; i++) {
            const id = `${prefix}:${i}`;
            if (!taken.has(id)) return id;
        }
        throw new Error("Unable to generate id");
    }

    private emit<K extends keyof (EditorEvents & any)>(
        event: K,
        payload: (EditorEvents & any)[K],
    ) {
        // Reuse CanvasAPI’s bus so consumers have a single stream
        this.api.emit(event as any, payload as any);
    }

    /**
     * Suggest/filter candidate services against the current visible-group
     * (single tag) context.
     *
     * - Excludes services already used in this group.
     * - Applies capability presence, tag constraints, rate policy, and compiled policies.
     *
     * @param candidates    service ids to evaluate
     * @param ctx
     * @param ctx.tagId     active visible-group tag id
     * @param ctx.usedServiceIds  services already selected for this visible group (first is treated as "primary" for rate policy)
     * @param ctx.effectiveConstraints  effective constraints for the active tag (dripfeed/refill/cancel)
     * @param ctx.policies  raw JSON policies (will be compiled via compilePolicies)
     * @param ctx.fallback  fallback/rate settings (defaults applied if omitted)
     */
    public filterServicesForVisibleGroup(
        candidates: Array<number | string>,
        ctx: {
            tagId: string;
            usedServiceIds: Array<number | string>;
            effectiveConstraints?: Partial<
                Record<"refill" | "cancel" | "dripfeed", boolean>
            >;
            policies?: unknown;
            fallback?: FallbackSettings;
        },
    ): ServiceCheck[] {
        const svcMap: DgpServiceMap =
            (this as any).opts?.serviceMap ??
            (this.builder as any).getServiceMap?.() ??
            {};

        const usedSet = new Set(ctx.usedServiceIds.map(String));
        const primary = ctx.usedServiceIds[0]; // group "primary" (first used); rate policy compares against this when present

        const fb: FallbackSettings = {
            requireConstraintFit: true,
            ratePolicy: { kind: "lte_primary" },
            selectionStrategy: "priority",
            mode: "strict",
            ...(ctx.fallback ?? {}),
        };

        // Compile policies once here; you asked for the evaluate path to call compilePolicies.
        const evaluatePoliciesRaw = (
            raw: unknown,
            serviceIds: Array<number | string>,
            tagId: string,
        ) => {
            const { policies } = compilePolicies(raw);
            return evaluateServicePolicies(policies, serviceIds, svcMap, tagId);
        };

        const out: ServiceCheck[] = [];

        for (const id of candidates) {
            // Skip already-used services in this group
            if (usedSet.has(String(id))) continue;

            const cap = svcMap[Number(id)];
            if (!cap) {
                out.push({
                    id,
                    ok: false,
                    fitsConstraints: false,
                    passesRate: false,
                    passesPolicies: false,
                    reasons: ["missing_capability"],
                });
                continue;
            }

            // Constraints (only flags explicitly true at tag are "required")
            const fitsConstraints = constraintFitOk(
                svcMap,
                cap.id,
                ctx.effectiveConstraints ?? {},
            );

            // Rate policy vs primary (if any); if no primary, consider pass
            const passesRate =
                primary == null ? true : rateOk(svcMap, id, primary, fb);

            // Policies: compile + evaluate with current used + candidate
            const polRes = evaluatePoliciesRaw(
                ctx.policies ?? [],
                [...ctx.usedServiceIds, id],
                ctx.tagId,
            );
            const passesPolicies = polRes.ok;

            const reasons: ServiceCheck["reasons"] = [];
            if (!fitsConstraints) reasons.push("constraint_mismatch");
            if (!passesRate) reasons.push("rate_policy");
            if (!passesPolicies) reasons.push("policy_error");

            out.push({
                id,
                ok: fitsConstraints && passesRate && passesPolicies,
                fitsConstraints,
                passesRate,
                passesPolicies,
                policyErrors: polRes.errors.length ? polRes.errors : undefined,
                policyWarnings: polRes.warnings.length
                    ? polRes.warnings
                    : undefined,
                reasons,
                cap,
                rate: toFiniteNumber(cap.rate),
            });
        }

        return out;
    }
}

function nextCopyLabel(old: string): string {
    // "Label" -> "Label (copy)", "Label (copy)" -> "Label (copy 2)"
    // noinspection RegExpUnnecessaryNonCapturingGroup
    const m = old.match(/^(.*?)(?:\s*\(copy(?:\s+(\d+))?\))$/i);
    if (!m) return `${old} (copy)`;
    const stem = m[1].trim();
    const n = m[2] ? parseInt(m[2], 10) + 1 : 2;
    return `${stem} (copy ${n})`;
}

function nextCopyName(old?: string): string | undefined {
    if (!old) return undefined;
    // "name" -> "name_copy", "name_copy" -> "name_copy2", "name_copy2" -> "name_copy3"
    const m = old.match(/^(.*?)(_copy(\d+)?)$/i);
    if (!m) return `${old}_copy`;
    const stem = m[1];
    const n = m[3] ? parseInt(m[3], 10) + 1 : 2;
    return `${stem}_copy${n}`;
}

function defaultOptionIdStrategy(old: string): string {
    // "basic" -> "basic_copy" / "basic_copy2"…
    return nextCopyId(old);
}

function nextCopyId(old: string): string {
    // "tag_1" -> "tag_1_copy" or bumps trailing copy N
    // noinspection RegExpUnnecessaryNonCapturingGroup
    const m = old.match(/^(.*?)(?:_copy(\d+)?)$/i);
    if (!m) return `${old}_copy`;
    const stem = m[1];
    const n = m[2] ? parseInt(m[2], 10) + 1 : 2;
    return `${stem}_copy${n}`;
}

function bumpSuffix(old: string): string {
    // "foo_copy" -> "foo_copy2", "foo_copy2" -> "foo_copy3"
    const m = old.match(/^(.*?)(\d+)$/);
    if (!m) return `${old}2`;
    const stem = m[1];
    return `${stem}${parseInt(m[2], 10) + 1}`;
}

// Accept only these shapes; drop everything else.
type QuantityRule = { valueBy: "value" | "length" | "eval"; code?: string };

function normalizeQuantityRule(input: unknown): QuantityRule | undefined {
    if (!input || typeof input !== "object") return undefined;
    const v = input as any;
    const vb = v.valueBy;
    if (vb !== "value" && vb !== "length" && vb !== "eval") return undefined;

    const out: QuantityRule = { valueBy: vb };
    if (vb === "eval" && typeof v.code === "string" && v.code.trim()) {
        out.code = v.code;
    }
    // For non-eval, any provided code is dropped.
    return out;
}

// ---- Policy evaluation (compiled rules) -------------------------------------

function evaluateServicePolicies(
    rules: DynamicRule[] | undefined,
    svcIds: (string | number)[],
    svcMap: DgpServiceMap,
    tagId: string,
): { ok: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!rules || !rules.length) return { ok: true, errors, warnings };

    const relevant = rules.filter(
        (r) =>
            r.subject === "services" &&
            (r.scope === "visible_group" || r.scope === "global"),
    );

    for (const r of relevant) {
        const ids = svcIds.filter((id) =>
            matchesRuleFilter(svcMap[Number(id)], r, tagId),
        );
        const projection = r.projection || "service.id";
        const values = ids.map((id) =>
            policyProjectValue(svcMap[Number(id)], projection),
        );

        let ok = true;
        switch (r.op) {
            case "all_equal":
                ok = values.length <= 1 || values.every((v) => v === values[0]);
                break;
            case "unique": {
                const uniq = new Set(values.map((v) => String(v)));
                ok = uniq.size === values.length;
                break;
            }
            case "no_mix": {
                const uniq = new Set(values.map((v) => String(v)));
                ok = uniq.size <= 1;
                break;
            }
            case "all_true":
                ok = values.every((v) => !!v);
                break;
            case "any_true":
                ok = values.some((v) => !!v);
                break;
            case "max_count": {
                const n = typeof r.value === "number" ? r.value : NaN;
                ok = Number.isFinite(n) ? values.length <= n : true;
                break;
            }
            case "min_count": {
                const n = typeof r.value === "number" ? r.value : NaN;
                ok = Number.isFinite(n) ? values.length >= n : true;
                break;
            }
            default:
                ok = true;
        }

        if (!ok) {
            if ((r.severity ?? "error") === "error")
                errors.push(r.id ?? "policy_error");
            else warnings.push(r.id ?? "policy_warning");
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}

function policyProjectValue(
    cap: DgpServiceCapability | undefined,
    projection: string,
) {
    if (!cap) return undefined;
    const key = projection.startsWith("service.")
        ? projection.slice(8)
        : projection;
    return (cap as any)[key];
}

function matchesRuleFilter(
    cap: DgpServiceCapability | undefined,
    rule: DynamicRule,
    tagId: string,
): boolean {
    if (!cap) return false;
    const f = rule.filter;
    if (!f) return true;

    if (f.tag_id && !toStrSet(f.tag_id).has(String(tagId))) return false;
    if (
        f.handler_id &&
        !toStrSet(f.handler_id).has(String((cap as any).handler_id))
    )
        return false;
    if (
        f.platform_id &&
        !toStrSet(f.platform_id).has(String((cap as any).platform_id))
    )
        return false;

    // role is intentionally ignored at suggestion-time (unknown), as discussed.
    return true;
}

function toStrSet(v: string | string[] | number | number[]): Set<string> {
    const arr = Array.isArray(v) ? v : [v];
    const s = new Set<string>();
    for (const x of arr) s.add(String(x));
    return s;
}

type ServiceCheck = {
    id: number | string;
    ok: boolean;
    fitsConstraints: boolean;
    passesRate: boolean;
    passesPolicies: boolean;
    policyErrors?: string[];
    policyWarnings?: string[];
    reasons: Array<
        | "constraint_mismatch"
        | "rate_policy"
        | "policy_error"
        | "missing_capability"
    >;
    cap?: DgpServiceCapability;
    rate?: number;
};
