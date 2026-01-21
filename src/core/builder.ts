// src/core/builder.ts
import { normalise } from "./normalise";
import { validate } from "./validate";

import type { ServiceProps, Tag, Field } from "@/schema";
import type {
    GraphNode,
    GraphEdge,
    GraphSnapshot,
    NodeKind,
    EdgeKind,
} from "@/schema/graph";
import type { DgpServiceMap } from "@/schema/provider";
import type { ValidationError, ValidatorOptions } from "@/schema/validation";

/** Options you can set on the builder (used for validation/visibility) */
export type BuilderOptions = Omit<ValidatorOptions, "serviceMap"> & {
    serviceMap?: DgpServiceMap;
    /** max history entries for undo/redo */
    historyLimit?: number;
    /**
     * Field ids whose options should be shown as nodes in the graph.
     * If a field id is NOT in this set, its options are not materialized as nodes:
     * - include/exclude wires keyed by an option id will be drawn from the FIELD instead.
     */
    showOptionNodes?: Set<string> | string[];
};

export interface Builder {
    /** Replace current payload (injects root if missing, rebuilds indexes) */
    load(props: ServiceProps): void;

    /** Graph for visualisation */
    tree(): GraphSnapshot;

    /** Deterministic save payload (drops unbound utility fields, prunes dead maps) */
    cleanedProps(): ServiceProps;

    /** Validation errors for current state */
    errors(): ValidationError[];

    /**
     * Compute IDs of fields visible under a tag.
     * If selectedOptionKeys provided, applies option-level include/exclude.
     * NOTE: keys are “button ids”: either option.id or field.id for option-less buttons.
     */
    visibleFields(tagId: string, selectedOptionKeys?: string[]): string[];

    /** Update builder options (validator context etc.) */
    setOptions(patch: Partial<BuilderOptions>): void;

    /** History */
    undo(): boolean;
    redo(): boolean;

    /** Access the current props (already normalised) */
    getProps(): ServiceProps;

    /** Service map for validation/rules */
    getServiceMap(): DgpServiceMap;
}

export function createBuilder(opts: BuilderOptions = {}): Builder {
    return new BuilderImpl(opts);
}

/* ────────────────────────────────────────────────────────────────────────── */

class BuilderImpl implements Builder {
    private props: ServiceProps = {
        filters: [],
        fields: [],
        schema_version: "1.0",
    };
    private tagById = new Map<string, Tag>();
    private fieldById = new Map<string, Field>();
    private optionOwnerById = new Map<string, { fieldId: string }>(); // option.id → fieldId

    private options: BuilderOptions;
    private readonly history: ServiceProps[] = [];
    private readonly future: ServiceProps[] = [];
    private readonly historyLimit: number;

    constructor(opts: BuilderOptions = {}) {
        this.options = { ...opts };
        this.historyLimit = opts.historyLimit ?? 50;
    }

    /* ───── lifecycle ─────────────────────────────────────────────────────── */

    load(raw: ServiceProps): void {
        const next = normalise(raw, { defaultPricingRole: "base" });
        this.pushHistory(this.props);
        this.future.length = 0; // clear redo stack
        this.props = next;
        this.rebuildIndexes();
    }

    getProps(): ServiceProps {
        return this.props;
    }

    setOptions(patch: Partial<BuilderOptions>): void {
        this.options = { ...this.options, ...patch };
    }

    getServiceMap(): DgpServiceMap {
        return this.options.serviceMap ?? {};
    }

    /* ───── querying ─────────────────────────────────────────────────────── */

    tree(): GraphSnapshot {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        const showSet = toStringSet(this.options.showOptionNodes);

        // 1) tags as nodes
        for (const t of this.props.filters) {
            nodes.push({ id: t.id, kind: "tag" as NodeKind, label: t.label });
        }

        // 2) tag hierarchy edges
        for (const t of this.props.filters) {
            if (t.bind_id) {
                edges.push({
                    from: t.bind_id,
                    to: t.id,
                    kind: "child" as EdgeKind,
                });
            }
        }

        // 3) fields as nodes
        for (const f of this.props.fields) {
            nodes.push({
                id: f.id,
                kind: "field" as NodeKind,
                label: f.label,
                bind_type:
                    f.pricing_role === "utility"
                        ? "utility"
                        : f.bind_id
                          ? "bound"
                          : null,
            });
        }

        // 4) field bind edges
        for (const f of this.props.fields) {
            const b = f.bind_id;
            if (Array.isArray(b)) {
                for (const tagId of b)
                    edges.push({
                        from: tagId,
                        to: f.id,
                        kind: "bind" as EdgeKind,
                    });
            } else if (typeof b === "string") {
                edges.push({ from: b, to: f.id, kind: "bind" as EdgeKind });
            }
        }

        // 5) Option nodes (only for fields in showOptionNodes)
        for (const f of this.props.fields) {
            const showOptions = showSet.has(f.id);
            if (!showOptions) continue;
            if (!Array.isArray(f.options)) continue;

            for (const o of f.options) {
                nodes.push({
                    id: o.id,
                    kind: "option",
                    label: o.label,
                });
                // field → option edge
                const e: any = {
                    from: f.id,
                    to: o.id,
                    kind: "option" as EdgeKind,
                    meta: { ownerField: f.id },
                };
                edges.push(e as GraphEdge);
            }
        }

        // 6) tag includes/excludes
        for (const t of this.props.filters) {
            for (const id of t.includes ?? []) {
                edges.push({ from: t.id, to: id, kind: "include" as EdgeKind });
            }
            for (const id of t.excludes ?? []) {
                edges.push({ from: t.id, to: id, kind: "exclude" as EdgeKind });
            }
        }

        // 7) button-level includes/excludes (keys are button IDs: option.id OR field.id)
        const incMap = this.props.includes_for_buttons ?? {};
        const excMap = this.props.excludes_for_buttons ?? {};

        const pushButtonEdge = (
            keyId: string,
            targetFieldId: string,
            kind: EdgeKind,
        ) => {
            const owner = this.optionOwnerById.get(keyId);
            const ownerFieldId =
                owner?.fieldId ??
                (this.fieldById.has(keyId) ? keyId : undefined);
            if (!ownerFieldId) return; // dangling key, ignore

            // If the key is an option AND its field is being shown, draw from the option
            const fromNode =
                owner && showSet.has(owner.fieldId)
                    ? keyId // option node → visible, draw from option
                    : ownerFieldId; // else draw from the field

            const meta: any = owner
                ? showSet.has(owner.fieldId)
                    ? {
                          via: "option-visible",
                          ownerField: owner.fieldId,
                          sourceOption: keyId,
                      }
                    : {
                          via: "option-hidden",
                          ownerField: owner.fieldId,
                          sourceOption: keyId,
                      }
                : { via: "field-button" };

            const e: any = { from: fromNode, to: targetFieldId, kind, meta };
            edges.push(e as GraphEdge);
        };

        for (const [keyId, arr] of Object.entries(incMap)) {
            for (const fid of arr ?? [])
                pushButtonEdge(keyId, fid, "include" as EdgeKind);
        }
        for (const [keyId, arr] of Object.entries(excMap)) {
            for (const fid of arr ?? [])
                pushButtonEdge(keyId, fid, "exclude" as EdgeKind);
        }

        return { nodes, edges };
    }

    cleanedProps(): ServiceProps {
        // Build quick indexes
        const fieldIds = new Set(this.props.fields.map((f) => f.id));
        const optionIds = new Set<string>();
        this.optionOwnerById.forEach((_v, oid) => optionIds.add(oid));

        // 1) drop utility fields that are truly "orphaned"
        //    (unbound + not included by tag or button includes + not referenced as a key)
        const includedByTag = new Set<string>();
        const excludedAnywhere = new Set<string>();
        for (const t of this.props.filters) {
            for (const id of t.includes ?? []) includedByTag.add(id);
            for (const id of t.excludes ?? []) excludedAnywhere.add(id);
        }

        const incMap = this.props.includes_for_buttons ?? {};
        const excMap = this.props.excludes_for_buttons ?? {};
        const includedByButtons = new Set<string>(); // field ids that might be pulled in
        const referencedKeys = new Set<string>(); // keys in maps (field button or option id)
        const referencedOwnerFields = new Set<string>();

        for (const [key, arr] of Object.entries(incMap)) {
            referencedKeys.add(key);
            const owner = this.optionOwnerById.get(key);
            if (owner) referencedOwnerFields.add(owner.fieldId);
            for (const fid of arr ?? []) {
                includedByButtons.add(fid);
            }
        }
        for (const [key, arr] of Object.entries(excMap)) {
            referencedKeys.add(key);
            const owner = this.optionOwnerById.get(key);
            if (owner) referencedOwnerFields.add(owner.fieldId);
            for (const fid of arr ?? []) {
                // exclusion targets don’t “include”, but record that these field ids are referenced
                // (so we don’t accidentally drop something host intentionally excludes/controls)
                // not strictly necessary, but conservative:
                void fid;
            }
        }

        const boundIds = new Set<string>();
        for (const f of this.props.fields) {
            const b = f.bind_id;
            if (Array.isArray(b)) b.forEach((id) => boundIds.add(id));
            else if (typeof b === "string") boundIds.add(b);
        }

        const fields = this.props.fields.filter((f) => {
            const isUtility = (f.pricing_role ?? "base") === "utility";
            if (!isUtility) return true;

            const bound = !!f.bind_id;
            const included =
                includedByTag.has(f.id) || includedByButtons.has(f.id);
            const referenced =
                referencedOwnerFields.has(f.id) || referencedKeys.has(f.id);
            const excluded = excludedAnywhere.has(f.id);

            // keep if bound OR included OR referenced by maps; drop if truly orphaned or globally excluded
            return bound || included || referenced || !excluded;
        });

        // 2) prune button maps: keep only valid keys and existing field targets
        const allowedTargets = new Set(fields.map((f) => f.id)); // targets must be existing fields

        const pruneButtons = (src?: Record<string, string[]>) => {
            if (!src) return undefined;
            const out: Record<string, string[]> = {};
            for (const [key, arr] of Object.entries(src)) {
                // key must be an existing option.id OR field.id
                const keyIsValid = optionIds.has(key) || fieldIds.has(key);
                if (!keyIsValid) continue;

                const cleaned = (arr ?? []).filter((fid) =>
                    allowedTargets.has(fid),
                );
                if (cleaned.length) out[key] = Array.from(new Set(cleaned));
            }
            return Object.keys(out).length ? out : undefined;
        };

        const includes_for_buttons = pruneButtons(
            this.props.includes_for_buttons,
        );
        const excludes_for_buttons = pruneButtons(
            this.props.excludes_for_buttons,
        );

        // 3) return canonical object
        const out: ServiceProps = {
            filters: this.props.filters.slice(),
            fields,
            ...(includes_for_buttons && { includes_for_buttons }),
            ...(excludes_for_buttons && { excludes_for_buttons }),
            schema_version: this.props.schema_version ?? "1.0",
            // keep fallbacks & other maps as-is
            ...(this.props.fallbacks
                ? { fallbacks: this.props.fallbacks }
                : {}),
        };
        return out;
    }

    errors(): ValidationError[] {
        return validate(this.props, this.options);
    }

    visibleFields(tagId: string, selectedKeys?: string[]): string[] {
        const props = this.props;
        const selected = new Set(
            selectedKeys ?? this.options.selectedOptionKeys ?? [],
        );

        const tag = (props.filters ?? []).find((t) => t.id === tagId);
        if (!tag) return [];

        const tagInclude = new Set(tag.includes ?? []);
        const tagExclude = new Set(tag.excludes ?? []);

        // Button maps (can be keyed by fieldId OR "fieldId::optionId")
        const incMap = props.includes_for_buttons ?? {};
        const excMap = props.excludes_for_buttons ?? {};

        // Collect includes/excludes coming from the current selection,
        // and keep an ordered list of *revealed* ids to preserve determinism.
        const revealedOrder: string[] = [];
        const includeFromSelection = new Set<string>();
        const excludeFromSelection = new Set<string>();

        for (const key of selected) {
            const inc = incMap[key] ?? [];
            for (const id of inc) {
                if (!includeFromSelection.has(id)) revealedOrder.push(id);
                includeFromSelection.add(id);
            }
            const exc = excMap[key] ?? [];
            for (const id of exc) excludeFromSelection.add(id);
        }

        // Build candidate pool
        const pool = new Map<string, Field>();
        for (const f of props.fields ?? []) {
            if (isBoundTo(f, tagId)) pool.set(f.id, f);
            if (tagInclude.has(f.id)) pool.set(f.id, f);
            if (includeFromSelection.has(f.id)) pool.set(f.id, f);
        }

        // Remove excludes
        for (const id of tagExclude) pool.delete(id);
        for (const id of excludeFromSelection) pool.delete(id);

        // Optional explicit ordering per tag
        const order = props.order_for_tags?.[tagId];

        if (order && order.length) {
            // 1) tag order
            const ordered: string[] = [];
            for (const fid of order) if (pool.has(fid)) ordered.push(fid);
            // 2) any remaining (preserve insertion order)
            for (const fid of pool.keys())
                if (!ordered.includes(fid)) ordered.push(fid);
            return ordered;
        }

        // No tag order → promote revealed fields FIRST (in the exact reveal order),
        // then anything else in the natural field order.
        const promoted = revealedOrder.filter((fid) => pool.has(fid));
        const rest: string[] = [];
        for (const fid of pool.keys()) {
            if (!promoted.includes(fid)) rest.push(fid);
        }
        return [...promoted, ...rest];
    }

    /* ───── history ─────────────────────────────────────────────────────── */

    undo(): boolean {
        if (this.history.length === 0) return false;
        const prev = this.history.pop()!;
        this.future.push(structuredCloneSafe(this.props));
        this.props = prev;
        this.rebuildIndexes();
        return true;
    }

    redo(): boolean {
        if (this.future.length === 0) return false;
        const next = this.future.pop()!;
        this.pushHistory(this.props);
        this.props = next;
        this.rebuildIndexes();
        return true;
    }

    /* ───── internals ──────────────────────────────────────────────────── */

    private rebuildIndexes(): void {
        this.tagById.clear();
        this.fieldById.clear();
        this.optionOwnerById.clear();

        for (const t of this.props.filters) this.tagById.set(t.id, t);
        for (const f of this.props.fields) {
            this.fieldById.set(f.id, f);
            if (Array.isArray(f.options)) {
                for (const o of f.options)
                    this.optionOwnerById.set(o.id, { fieldId: f.id });
            }
        }
    }

    private pushHistory(state: ServiceProps): void {
        // avoid pushing initial empty state on the very first load
        if (!state || (!state.filters.length && !state.fields.length)) return;
        this.history.push(structuredCloneSafe(state));
        if (this.history.length > this.historyLimit) this.history.shift();
    }
}

/* ───────────────────────── helpers ───────────────────────── */

function isBoundTo(f: Field, tagId: string): boolean {
    const b = f.bind_id;
    if (!b) return false;
    return Array.isArray(b) ? b.includes(tagId) : b === tagId;
}

function structuredCloneSafe<T>(v: T): T {
    if (typeof (globalThis as any).structuredClone === "function") {
        return (globalThis as any).structuredClone(v);
    }
    return JSON.parse(JSON.stringify(v));
}

function toStringSet(v: Set<string> | string[] | undefined): Set<string> {
    if (!v) return new Set();
    if (v instanceof Set) return new Set(Array.from(v).map(String));
    return new Set((v as string[]).map(String));
}
