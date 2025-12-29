# Included Source Files

- src/core/builder.ts
- src/core/fallback.ts
- src/core/index.ts
- src/core/normalise.ts
- src/core/policy.ts
- src/core/rate-coherence.ts
- src/core/validate.ts
- src/react/canvas/api.ts
- src/react/canvas/backend.ts
- src/react/canvas/comments.ts
- src/react/canvas/context.tsx
- src/react/canvas/editor.ts
- src/react/canvas/events.ts
- src/react/canvas/selection.ts
- src/react/hooks/OrderFlowProvider.tsx
- src/react/hooks/use-order-flow.ts
- src/react/index.ts
- src/react/inputs/FormContext.tsx
- src/react/inputs/InputRegistry.ts
- src/react/inputs/InputsProvider.tsx
- src/schema/canvas-types.ts
- src/schema/editor.ts
- src/schema/editor.types.ts
- src/schema/graph.ts
- src/schema/index.ts
- src/schema/order.ts
- src/schema/policies.ts
- src/schema/provider.ts
- src/schema/validation.ts
- src/utils/build-order-snapshot.ts
- src/utils/index.ts
- src/utils/prune-fallbacks.ts
- src/utils/retry-queue.ts
- src/utils/util.ts

---

`File: src/core/builder.ts`
```ts
// src/core/builder.ts
import { normalise } from "./normalise";
import { validate } from "./validate";

import type { ServiceProps, Tag, Field } from "../schema";
import type {
    GraphNode,
    GraphEdge,
    GraphSnapshot,
    NodeKind,
    EdgeKind,
} from "../schema/graph";
import type { DgpServiceMap } from "../schema/provider";
import type { ValidationError, ValidatorOptions } from "../schema/validation";

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
            nodes.push({ id: t.id, kind: "tag" as NodeKind });
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
                nodes.push({ id: o.id, kind: "option" as NodeKind });
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
```
---
`File: src/core/fallback.ts`
```ts
// src/core/utils/fallback.ts
import type {
    ServiceProps,
    ServiceFallback,
    ServiceIdRef,
    NodeIdRef,
} from "../schema";
import type { DgpServiceMap } from "../schema/provider";
import type { FallbackSettings } from "../schema/validation";

export type FailedFallbackContext = {
    scope: "node" | "global";
    nodeId?: string; // when scope='node'
    primary: ServiceIdRef;
    candidate: ServiceIdRef;
    tagContext?: string; // tag.id when evaluating constraints
    reason:
        | "unknown_service"
        | "no_primary"
        | "rate_violation"
        | "constraint_mismatch"
        | "cycle"
        | "no_tag_context";
    details?: Record<string, unknown>;
};

const DEFAULT_SETTINGS: Required<FallbackSettings> = {
    requireConstraintFit: true,
    ratePolicy: { kind: "lte_primary" },
    selectionStrategy: "priority",
    mode: "strict",
};

export function resolveServiceFallback(params: {
    primary: ServiceIdRef;
    nodeId?: NodeIdRef; // prefer node-scoped first if provided
    tagId?: string; // constraints context (if known)
    services: DgpServiceMap;
    fallbacks?: ServiceFallback;
    settings?: FallbackSettings;
    props: ServiceProps;
}): ServiceIdRef | null {
    const s = { ...DEFAULT_SETTINGS, ...(params.settings ?? {}) };
    const { primary, nodeId, tagId, services } = params;
    const fb = params.fallbacks ?? {};
    const tried: ServiceIdRef[] = [];

    const lists: ServiceIdRef[][] = [];
    if (nodeId && fb.nodes?.[nodeId]) lists.push(fb.nodes[nodeId]);
    if (fb.global?.[primary]) lists.push(fb.global[primary]);

    const primaryRate = rateOf(services, primary);

    for (const list of lists) {
        for (const cand of list) {
            if (tried.includes(cand)) continue;
            tried.push(cand);

            const candCap = services[Number(cand)] ?? services[cand as any];
            if (!candCap) continue;

            if (!passesRate(s.ratePolicy, primaryRate, candCap.rate)) continue;
            if (s.requireConstraintFit && tagId) {
                const ok = satisfiesTagConstraints(tagId, params, candCap);
                if (!ok) continue;
            }
            return cand;
        }
    }
    return null;
}

export function collectFailedFallbacks(
    props: ServiceProps,
    services: DgpServiceMap,
    settings?: FallbackSettings,
): FailedFallbackContext[] {
    const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    const out: FailedFallbackContext[] = [];
    const fb = props.fallbacks ?? {};
    const primaryRate = (p: ServiceIdRef) => rateOf(services, p);

    // Node-scoped (tags or options)
    for (const [nodeId, list] of Object.entries(fb.nodes ?? {})) {
        const { primary, tagContexts } = primaryForNode(props, nodeId);
        if (!primary) {
            out.push({
                scope: "node",
                nodeId,
                primary: "" as any,
                candidate: "" as any,
                reason: "no_primary",
            });
            continue;
        }
        for (const cand of list) {
            const cap = getCap(services, cand);
            if (!cap) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "unknown_service",
                });
                continue;
            }
            if (String(cand) === String(primary)) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "cycle",
                });
                continue;
            }
            if (!passesRate(s.ratePolicy, primaryRate(primary), cap.rate)) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "rate_violation",
                });
                continue;
            }
            // Tag contexts
            if (tagContexts.length === 0) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "no_tag_context",
                });
                continue;
            }
            let anyPass = false;
            let anyFail = false;
            for (const tagId of tagContexts) {
                const ok = s.requireConstraintFit
                    ? satisfiesTagConstraints(tagId, { services, props }, cap)
                    : true;
                if (ok) anyPass = true;
                else {
                    anyFail = true;
                    out.push({
                        scope: "node",
                        nodeId,
                        primary,
                        candidate: cand,
                        tagContext: tagId,
                        reason: "constraint_mismatch",
                    });
                }
            }
            // If none passed, we already added per-context mismatches above
            void anyPass;
            void anyFail;
        }
    }

    // Global (soft; no tag context)
    for (const [primary, list] of Object.entries(fb.global ?? {})) {
        for (const cand of list) {
            const cap = getCap(services, cand);
            if (!cap) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "unknown_service",
                });
                continue;
            }
            if (String(cand) === String(primary)) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "cycle",
                });
                continue;
            }
            if (!passesRate(s.ratePolicy, primaryRate(primary), cap.rate)) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "rate_violation",
                });
            }
        }
    }
    return out;
}

/* ───────────────────────── helpers ───────────────────────── */

function getCap(map: DgpServiceMap, id: ServiceIdRef) {
    return map[Number(id)] ?? map[id as any];
}

function rateOf(
    map: DgpServiceMap,
    id: ServiceIdRef | undefined,
): number | undefined {
    if (id === undefined || id === null) return undefined;
    const c = getCap(map, id);
    return c?.rate ?? undefined;
}

function passesRate(
    policy: Required<FallbackSettings>["ratePolicy"],
    primaryRate?: number,
    candRate?: number,
): boolean {
    if (typeof candRate !== "number" || !Number.isFinite(candRate))
        return false;
    if (typeof primaryRate !== "number" || !Number.isFinite(primaryRate))
        return false;
    switch (policy.kind) {
        case "lte_primary":
            return candRate <= primaryRate;
        case "within_pct":
            return candRate <= primaryRate * (1 + policy.pct / 100);
        case "at_least_pct_lower":
            return candRate <= primaryRate * (1 - policy.pct / 100);
    }
}

function satisfiesTagConstraints(
    tagId: string,
    ctx: { props: ServiceProps; services: DgpServiceMap },
    cap: { dripfeed?: boolean; refill?: boolean; cancel?: boolean },
): boolean {
    const tag = ctx.props.filters.find((t) => t.id === tagId);
    const eff = tag?.constraints; // effective constraints (should already be propagated)
    if (!eff) return true;
    // Only enforce flags explicitly set TRUE at the tag; false/undefined = no requirement
    if (eff.dripfeed === true && !cap.dripfeed) return false;
    if (eff.refill === true && !cap.refill) return false;
    return !(eff.cancel === true && !cap.cancel);
}

function primaryForNode(
    props: ServiceProps,
    nodeId: string,
): {
    primary?: ServiceIdRef;
    tagContexts: string[];
    reasonNoPrimary?: string;
} {
    // Tag node?
    const tag = props.filters.find((t) => t.id === nodeId);
    if (tag) {
        return { primary: tag.service_id as any, tagContexts: [tag.id] };
    }
    // Option node: locate its parent field
    const field = props.fields.find(
        (f) =>
            Array.isArray(f.options) && f.options.some((o) => o.id === nodeId),
    );
    if (!field) return { tagContexts: [], reasonNoPrimary: "no_parent_field" };
    const opt = field.options!.find((o) => o.id === nodeId)!;
    const contexts = bindIdsToArray(field.bind_id);
    return { primary: opt.service_id as any, tagContexts: contexts };
}

function bindIdsToArray(bind: string | string[] | undefined): string[] {
    if (!bind) return [];
    return Array.isArray(bind) ? bind.slice() : [bind];
}

/**
 * Return all fallback candidates that are eligible for the given primary,
 * respecting:
 *  - node-scoped list first (if nodeId provided), then global list for `primary`
 *  - rate policy vs. primary
 *  - (optional) tag constraint fit, only when tagId is provided and requireConstraintFit=true
 *  - excludes (including primary automatically)
 *  - selectionStrategy: 'priority' keeps list order, 'cheapest' sorts by rate asc
 *  - unique (dedupe) and optional limit
 */
export function getEligibleFallbacks(params: {
    primary: ServiceIdRef;
    nodeId?: NodeIdRef; // prefer node-scoped list first
    tagId?: string; // constraints context (if known)
    services: DgpServiceMap;
    fallbacks?: ServiceFallback;
    settings?: FallbackSettings;
    props: ServiceProps;
    exclude?: Array<ServiceIdRef>; // additional ids to ignore
    unique?: boolean; // default true
    limit?: number; // optional cap
}): ServiceIdRef[] {
    const s = { ...DEFAULT_SETTINGS, ...(params.settings ?? {}) };
    const { primary, nodeId, tagId, services } = params;
    const fb = params.fallbacks ?? {};
    const excludes = new Set<string>((params.exclude ?? []).map(String));
    excludes.add(String(primary)); // never return the primary itself
    const unique = params.unique ?? true;

    // Gather source lists: node → global
    const lists: ServiceIdRef[][] = [];
    if (nodeId && fb.nodes?.[nodeId]) lists.push(fb.nodes[nodeId]);
    if (fb.global?.[primary]) lists.push(fb.global[primary]);

    if (!lists.length) return [];

    const primaryRate = rateOf(services, primary);
    const seen = new Set<string>();
    const eligible: ServiceIdRef[] = [];

    for (const list of lists) {
        for (const cand of list) {
            const key = String(cand);
            if (excludes.has(key)) continue;
            if (unique && seen.has(key)) continue;
            seen.add(key);

            const cap = getCap(services, cand);
            if (!cap) continue;

            // Rate policy must pass
            if (!passesRate(s.ratePolicy, primaryRate, cap.rate)) continue;

            // Tag constraint fit is only enforced if we know tagId and setting requires it
            if (s.requireConstraintFit && tagId) {
                const ok = satisfiesTagConstraints(
                    tagId,
                    { props: params.props, services },
                    cap,
                );
                if (!ok) continue;
            }

            eligible.push(cand);
        }
    }

    // Selection strategy
    if (s.selectionStrategy === "cheapest") {
        eligible.sort((a, b) => {
            const ra = rateOf(services, a) ?? Infinity;
            const rb = rateOf(services, b) ?? Infinity;
            return ra - rb;
        });
    }
    // 'priority' keeps original order

    // Optional limit
    if (typeof params.limit === "number" && params.limit >= 0) {
        return eligible.slice(0, params.limit);
    }
    return eligible;
}
```
---
`File: src/core/index.ts`
```ts
export * from "./normalise";
export * from "./validate";
export * from "./builder";
export * from "./fallback";
export * from "./rate-coherence";
```
---
`File: src/core/normalise.ts`
```ts
// src/core/normalise.ts

import type {
    ServiceProps,
    Tag,
    Field,
    FieldOption,
    PricingRole,
    ServiceFallback,
    ServiceIdRef,
} from "../schema";

export type NormaliseOptions = {
    /** default pricing role for fields/options when missing */
    defaultPricingRole?: PricingRole; // default: 'base'
};

export function normalise(
    input: unknown,
    opts: NormaliseOptions = {},
): ServiceProps {
    const defRole: PricingRole = opts.defaultPricingRole ?? "base";
    const obj = toObject(input);

    // ── Canonical top-level keys only
    const rawFilters = Array.isArray((obj as any).filters)
        ? (obj as any).filters
        : [];
    const rawFields = Array.isArray((obj as any).fields)
        ? (obj as any).fields
        : [];

    const includes_for_buttons = toStringArrayMap(
        (obj as any).includes_for_buttons,
    );
    const excludes_for_buttons = toStringArrayMap(
        (obj as any).excludes_for_buttons,
    );

    // Tags & fields
    let filters: Tag[] = rawFilters.map(coerceTag);
    const fields: Field[] = rawFields.map((f: any) => coerceField(f, defRole));

    // ── Ensure a root tag exists (id: 't:root')
    if (!filters.some((t) => t.id === "t:root")) {
        filters = [{ id: "t:root", label: "Root" }, ...filters];
    }

    // Canonical fallbacks only
    const fallbacks = coerceFallbacks((obj as any).fallbacks);

    const out: ServiceProps = {
        filters,
        fields,
        ...(isNonEmpty(includes_for_buttons) && { includes_for_buttons }),
        ...(isNonEmpty(excludes_for_buttons) && { excludes_for_buttons }),
        ...(fallbacks &&
            (isNonEmpty(fallbacks.nodes) || isNonEmpty(fallbacks.global)) && {
                fallbacks,
            }),
        schema_version:
            typeof (obj as any).schema_version === "string"
                ? (obj as any).schema_version
                : "1.0",
    };

    propagateConstraints(out);
    return out;
}

/* ───────────────────────── Constraint propagation ───────────────────────── */

const FLAG_KEYS = ["refill", "cancel", "dripfeed"] as const;
type FlagKey = (typeof FLAG_KEYS)[number];

/**
 * Propagate constraint flags down the tag tree:
 * - Any flag defined on an ancestor overrides the child's local value.
 * - Writes back the effective value to each tag.constraints.
 * - Records provenance in tag.constraints_origin[flag] = <originTagId>.
 * - Records child overrides in tag.constraints_overrides[flag] = { from, to, origin }.
 *
 * IMPORTANT: Children inherit the **effective** value from their parent,
 * not the parent's raw local. This ensures overridden values keep propagating.
 */
function propagateConstraints(props: ServiceProps): void {
    const tags = Array.isArray(props.filters) ? props.filters : [];
    if (!tags.length) return;

    const byId = new Map(tags.map((t) => [t.id, t]));
    const children = new Map<string, Tag[]>();

    for (const t of tags) {
        const pid = t.bind_id;
        if (!pid || !byId.has(pid)) continue;
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid)!.push(t);
    }

    const roots = tags.filter((t) => !t.bind_id || !byId.has(t.bind_id));
    const starts = roots.length ? roots : tags;

    type Inherited = Partial<Record<FlagKey, { val: boolean; origin: string }>>;
    const visited = new Set<string>();

    const visit = (tag: Tag, inherited: Inherited) => {
        if (visited.has(tag.id)) return;
        visited.add(tag.id);

        const local = tag.constraints ?? {};
        const next: Partial<Record<FlagKey, boolean>> = {};
        const origin: Partial<Record<FlagKey, string>> = {};
        const overrides: NonNullable<Tag["constraints_overrides"]> = {};

        for (const k of FLAG_KEYS) {
            const inh = inherited[k];
            const prev = local[k];

            if (inh) {
                if (prev === undefined) {
                    next[k] = inh.val;
                    origin[k] = inh.origin;
                } else if (prev === inh.val) {
                    next[k] = inh.val;
                    origin[k] = tag.id;
                } else {
                    next[k] = inh.val;
                    origin[k] = inh.origin;
                    overrides[k] = {
                        from: prev as boolean,
                        to: inh.val,
                        origin: inh.origin,
                    };
                }
            } else if (prev !== undefined) {
                next[k] = prev as boolean;
                origin[k] = tag.id;
            }
        }

        // Persist only defined keys (keep JSON lean)
        const definedConstraints: Partial<Record<FlagKey, boolean>> = {};
        const definedOrigin: Partial<Record<FlagKey, string>> = {};
        const definedOverrides: NonNullable<Tag["constraints_overrides"]> = {};

        for (const k of FLAG_KEYS) {
            if (next[k] !== undefined)
                definedConstraints[k] = next[k] as boolean;
            if (origin[k] !== undefined) definedOrigin[k] = origin[k] as string;
            if (overrides[k] !== undefined) definedOverrides[k] = overrides[k]!;
        }

        tag.constraints = Object.keys(definedConstraints).length
            ? definedConstraints
            : undefined;
        tag.constraints_origin = Object.keys(definedOrigin).length
            ? definedOrigin
            : undefined;
        tag.constraints_overrides = Object.keys(definedOverrides).length
            ? definedOverrides
            : undefined;

        // Children inherit effective values + nearest origin
        const passDown: Inherited = { ...inherited };
        for (const k of FLAG_KEYS) {
            if (next[k] !== undefined && origin[k] !== undefined) {
                passDown[k] = { val: next[k] as boolean, origin: origin[k]! };
            }
        }
        for (const c of children.get(tag.id) ?? []) visit(c, passDown);
    };

    for (const r of starts) visit(r, {});
}

/* ───────────────────────────── coercers ───────────────────────────── */

function coerceTag(src: any): Tag {
    if (!src || typeof src !== "object") src = {};
    const id = str(src.id);
    const label = str(src.label);
    const bind_id = str(src.bind_id) || undefined;
    const service_id = toNumberOrUndefined(src.service_id);

    const includes = toStringArray(src.includes);
    const excludes = toStringArray(src.excludes);

    const constraints =
        src.constraints && typeof src.constraints === "object"
            ? {
                  refill: bool((src.constraints as any).refill),
                  cancel: bool((src.constraints as any).cancel),
                  dripfeed: bool((src.constraints as any).dripfeed),
              }
            : undefined;

    const meta =
        src.meta && typeof src.meta === "object"
            ? (src.meta as Record<string, unknown>)
            : undefined;

    const tag: Tag = {
        id: "",
        label: "",
        ...(id && { id }),
        ...(label && { label }),
        ...(bind_id && { bind_id }),
        ...(service_id !== undefined && { service_id }),
        ...(constraints && { constraints }),
        ...(includes.length && { includes: dedupe(includes) }),
        ...(excludes.length && { excludes: dedupe(excludes) }),
        ...(meta && { meta }),
    };
    return tag;
}
function coerceField(src: any, defRole: PricingRole): Field {
    if (!src || typeof src !== "object") src = {};

    const bind_id = normaliseBindId(src.bind_id);
    const type = str(src.type) || "text";
    const id = str(src.id);
    const name = typeof src.name === "string" ? src.name : undefined;

    // BaseFieldUI (trimmed)
    const label = str(src.label) || "";
    const required = !!src.required;

    // host-defined UI schema + defaults (pass-through if objects)
    const ui =
        src.ui && typeof src.ui === "object"
            ? (src.ui as Record<string, unknown>)
            : undefined;
    const defaults =
        src.defaults && typeof src.defaults === "object"
            ? (src.defaults as Record<string, unknown>)
            : undefined;

    // field-level role (used as default for options)
    const pricing_role: PricingRole =
        src.pricing_role === "utility" || src.pricing_role === "base"
            ? src.pricing_role
            : defRole;

    // options
    const srcHasOptions = Array.isArray(src.options) && src.options.length > 0;
    const options = srcHasOptions
        ? (src.options as any[]).map((o) => coerceOption(o, pricing_role))
        : undefined;

    // custom component (only for type === 'custom')
    const component =
        type === "custom" ? str(src.component) || undefined : undefined;

    // meta (pass-through)
    const meta =
        src.meta && typeof src.meta === "object"
            ? { ...(src.meta as any) }
            : undefined;

    // button rule:
    // - option-based fields are always buttons
    // - otherwise, respect explicit boolean true
    const button: boolean = srcHasOptions ? true : src.button === true;

    // field-level service_id is allowed only for *buttons* with base role
    const field_service_id_raw = toNumberOrUndefined(src.service_id);
    const field_service_id =
        button &&
        pricing_role !== "utility" &&
        field_service_id_raw !== undefined
            ? field_service_id_raw
            : undefined;

    const field: Field = {
        id,
        type,
        ...(bind_id !== undefined && { bind_id }),
        ...(name && { name }),
        ...(options && options.length && { options }),
        ...(component && { component }),
        pricing_role,
        label,
        required,
        ...(ui && { ui: ui as any }),
        ...(defaults && { defaults }),
        ...(meta && { meta }),
        ...(button ? { button } : {}),
        ...(field_service_id !== undefined && { service_id: field_service_id }),
    };

    return field;
}

function coerceOption(src: any, inheritRole: PricingRole): FieldOption {
    if (!src || typeof src !== "object") src = {};
    const id = str(src.id);
    const label = str(src.label);
    const service_id = toNumberOrUndefined(src.service_id);
    const value =
        typeof src.value === "string" || typeof src.value === "number"
            ? (src.value as string | number)
            : undefined;

    const pricing_role: PricingRole =
        src.pricing_role === "utility" || src.pricing_role === "base"
            ? src.pricing_role
            : inheritRole;

    const meta =
        src.meta && typeof src.meta === "object"
            ? (src.meta as Record<string, unknown>)
            : undefined;

    const option: FieldOption = {
        id: "",
        label: "",
        ...(id && { id }),
        ...(label && { label }),
        ...(value !== undefined && { value }),
        ...(service_id !== undefined && { service_id }),
        pricing_role,
        ...(meta && { meta }),
    };
    return option;
}

/* ───────────────────────── fallbacks (canonical only) ───────────────────────── */

function coerceFallbacks(src: any): ServiceFallback | undefined {
    if (!src || typeof src !== "object") return undefined;

    const out: ServiceFallback = {};
    const g = (src as any).global;
    const n = (src as any).nodes;

    if (g && typeof g === "object") {
        const rg: Record<string, ServiceIdRef[]> = {};
        for (const [k, v] of Object.entries(g)) {
            const key = String(k);
            const arr = toServiceIdArray(v);
            const clean = dedupe(arr.filter((x) => String(x) !== key));
            if (clean.length) rg[key] = clean;
        }
        if (Object.keys(rg).length) out.global = rg;
    }

    if (n && typeof n === "object") {
        const rn: Record<string, ServiceIdRef[]> = {};
        for (const [nodeId, v] of Object.entries(n)) {
            const key = String(nodeId);
            const arr = toServiceIdArray(v);
            const clean = dedupe(arr.filter((x) => String(x) !== key));
            if (clean.length) rn[key] = clean;
        }
        if (Object.keys(rn).length) out.nodes = rn;
    }

    return out.nodes || out.global ? out : undefined;
}

/* ───────────────────────── utilities ───────────────────────── */

function toObject(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object")
        return input as Record<string, unknown>;
    throw new TypeError("normalise(): expected an object payload");
}

function normaliseBindId(bind: unknown): string | string[] | undefined {
    if (typeof bind === "string" && bind.trim()) return bind.trim();
    if (Array.isArray(bind)) {
        const arr = dedupe(bind.map((b) => String(b).trim()).filter(Boolean));
        if (arr.length === 0) return undefined;
        if (arr.length === 1) return arr[0];
        return arr;
    }
    return undefined;
}

function toStringArrayMap(src: any): Record<string, string[]> | undefined {
    if (!src || typeof src !== "object") return undefined;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(src)) {
        if (!k) continue;
        const arr = toStringArray(v);
        if (arr.length) out[k] = dedupe(arr);
    }
    return Object.keys(out).length ? out : undefined;
}

function toStringArray(v: any): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x)).filter((s) => !!s && s.trim().length > 0);
}

function toNumberOrUndefined(v: any): number | undefined {
    if (v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function str(v: any): string | undefined {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    return undefined;
}

function bool(v: any): boolean | undefined {
    if (v === undefined) return undefined;
    return !!v;
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

function isNonEmpty<T extends Record<string, any> | undefined>(
    obj: T,
): obj is NonNullable<T> {
    return !!obj && Object.keys(obj).length > 0;
}

function toServiceIdArray(v: any): ServiceIdRef[] {
    if (!Array.isArray(v)) return [];
    return v
        .map((x) =>
            typeof x === "number" || typeof x === "string" ? x : String(x),
        )
        .filter(
            (x) => x !== "" && x !== null && x !== undefined,
        ) as ServiceIdRef[];
}
```
---
`File: src/core/policy.ts`
```ts
// src/core/policy.ts
import type { DynamicRule, ValidatorOptions } from '../schema/validation';

export type PolicyDiagnostic = {
    ruleIndex: number;
    ruleId?: string;
    severity: 'error' | 'warning';
    message: string;
    path?: string; // e.g. "filter.role", "op"
};

const ALLOWED_SCOPES = new Set<DynamicRule['scope']>(['global', 'visible_group']);
const ALLOWED_SUBJECTS = new Set<DynamicRule['subject']>(['services']);
const ALLOWED_OPS = new Set<DynamicRule['op']>([
    'all_equal', 'unique', 'no_mix', 'all_true', 'any_true', 'max_count', 'min_count',
]);
const ALLOWED_ROLES = new Set<NonNullable<DynamicRule['filter']>['role']>(['base', 'utility', 'both']);
const ALLOWED_SEVERITIES = new Set<NonNullable<DynamicRule['severity']>>(['error', 'warning']);

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
}

/**
 * Compile & validate arbitrary JSON into DynamicRule[] with defaults:
 * - scope: (default) "visible_group"
 * - subject: (default) "services"
 * - filter.role: (default) "both"
 * - severity: (default) "error"
 * - projection: (default) "service.id"
 *
 * Returns normalized rules + diagnostics (errors/warnings).
 */
export function compilePolicies(raw: unknown): {
    policies: DynamicRule[];
    diagnostics: PolicyDiagnostic[];
} {
    const diagnostics: PolicyDiagnostic[] = [];
    const policies: DynamicRule[] = [];

    if (!Array.isArray(raw)) {
        diagnostics.push({
            ruleIndex: -1,
            severity: 'error',
            message: 'Policies root must be an array.',
        });
        return { policies, diagnostics };
    }

    raw.forEach((entry, i) => {
        const d: PolicyDiagnostic[] = [];
        const src = (entry && typeof entry === 'object') ? (entry as any) : {};
        let id: string | undefined = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : undefined;

        // id default
        if (!id) {
            id = `policy_${i + 1}`;
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Missing "id"; generated automatically.', path: 'id' });
        }

        // scope default + validation
        let scope: DynamicRule['scope'] =
            ALLOWED_SCOPES.has(src.scope) ? src.scope : (src.scope === undefined ? 'visible_group' : 'visible_group');
        if (src.scope !== undefined && !ALLOWED_SCOPES.has(src.scope)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "scope"; defaulted to "visible_group".', path: 'scope' });
        }

        // subject default + validation
        let subject: DynamicRule['subject'] =
            ALLOWED_SUBJECTS.has(src.subject) ? src.subject : 'services';
        if (src.subject !== undefined && !ALLOWED_SUBJECTS.has(src.subject)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "subject"; defaulted to "services".', path: 'subject' });
        }

        // op required & valid
        const op: DynamicRule['op'] = src.op;
        if (!ALLOWED_OPS.has(op)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'error', message: `Invalid "op": ${String(op)}.`, path: 'op' });
        }

        // projection default
        let projection: string | undefined = typeof src.projection === 'string' && src.projection.trim()
            ? src.projection.trim()
            : 'service.id';

        // For services subject, encourage service.* projection
        if (subject === 'services' && projection && !projection.startsWith('service.')) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Projection should start with "service." for subject "services".', path: 'projection' });
        }

        // filter defaults & shape
        const filterSrc = (src.filter && typeof src.filter === 'object') ? src.filter as DynamicRule['filter'] : undefined;
        const role: NonNullable<DynamicRule['filter']>['role'] =
            filterSrc?.role && ALLOWED_ROLES.has(filterSrc.role) ? filterSrc.role : 'both';
        if (filterSrc?.role && !ALLOWED_ROLES.has(filterSrc.role)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown filter.role; defaulted to "both".', path: 'filter.role' });
        }

        const filter: DynamicRule['filter'] | undefined = {
            role,
            handler_id: filterSrc?.handler_id !== undefined ? (Array.isArray(filterSrc.handler_id) ? filterSrc.handler_id : [filterSrc.handler_id]) : undefined,
            platform_id: filterSrc?.platform_id !== undefined ? (Array.isArray(filterSrc.platform_id) ? filterSrc.platform_id : [filterSrc.platform_id]) : undefined,
            tag_id: filterSrc?.tag_id !== undefined ? (Array.isArray(filterSrc.tag_id) ? filterSrc.tag_id : [filterSrc.tag_id]) : undefined,
            field_id: filterSrc?.field_id !== undefined ? (Array.isArray(filterSrc.field_id) ? filterSrc.field_id : [filterSrc.field_id]) : undefined,
        };

        // severity default
        const severity: NonNullable<DynamicRule['severity']> =
            ALLOWED_SEVERITIES.has(src.severity) ? src.severity : 'error';
        if (src.severity !== undefined && !ALLOWED_SEVERITIES.has(src.severity)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "severity"; defaulted to "error".', path: 'severity' });
        }

        // value requirements by op
        const value = src.value;
        if (op === 'max_count' || op === 'min_count') {
            if (!(typeof value === 'number' && Number.isFinite(value))) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'error', message: `"${op}" requires numeric "value".`, path: 'value' });
            }
        } else if (op === 'all_true' || op === 'any_true') {
            if (value !== undefined) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: `"${op}" ignores "value"; it checks all/any true.`, path: 'value' });
            }
        } else {
            if (value !== undefined) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: `"${op}" does not use "value".`, path: 'value' });
            }
        }

        // assemble rule if no fatal (error-level) diagnostics for op/value
        const hasFatal = d.some(x => x.severity === 'error');
        if (!hasFatal) {
            const rule: DynamicRule = {
                id,
                scope,
                subject,
                filter,
                projection,
                op,
                value: value as any,
                severity,
                message: typeof src.message === 'string' ? src.message : undefined,
            };
            policies.push(rule);
        }

        diagnostics.push(...d);
    });

    return { policies, diagnostics };
}

/** Split diagnostics for convenience in UI */
export function splitPolicyDiagnostics(diags: PolicyDiagnostic[]): {
    errors: PolicyDiagnostic[];
    warnings: PolicyDiagnostic[];
} {
    return {
        errors: diags.filter(d => d.severity === 'error'),
        warnings: diags.filter(d => d.severity === 'warning'),
    };
}

/**
 * Convenience helper: compile policies and pass to validator options.
 * You can use this in your editor before calling validate().
 */
export function withCompiledPolicies(
    opts: ValidatorOptions,
    rawPolicies: unknown,
): { opts: ValidatorOptions; diagnostics: PolicyDiagnostic[] } {
    const { policies, diagnostics } = compilePolicies(rawPolicies);
    return { opts: { ...opts, policies }, diagnostics };
}
```
---
`File: src/core/rate-coherence.ts`
```ts
import { RatePolicy } from "../schema/validation";
import { Builder } from "./builder";
import { DgpServiceCapability, DgpServiceMap } from "../schema/provider";
import { Field, PricingRole, ServiceProps, Tag } from "../schema";

type BaseCandidate = {
    kind: "field" | "option";
    id: string;
    label?: string;
    service_id: number;
    rate: number;
};

/** Result for each violation discovered during deep simulation. */
export type RateCoherenceDiagnostic = {
    scope: "visible_group";
    tagId: string;
    /** The “primary” used for comparison in this simulation:
     *  anchor service if present; otherwise, the first base service among simulated candidates.
     *  (Tag service is never used as primary.)
     */
    primary: BaseCandidate;
    /** The item that violated the policy against the primary. */
    offender: {
        kind: "field" | "option";
        id: string;
        label?: string;
        service_id: number;
        rate: number;
    };
    policy: RatePolicy["kind"];
    policyPct?: number; // for within_pct / at_least_pct_lower
    message: string;
    /** Which button triggered this simulation */
    simulationAnchor: {
        kind: "field" | "option";
        id: string;
        fieldId: string;
        label?: string;
    };
};

/** Run deep rate-coherence validation by simulating each button selection in the active tag. */
export function validateRateCoherenceDeep(params: {
    builder: Builder;
    services: DgpServiceMap;
    tagId: string;
    /** Optional rate policy (defaults to { kind: 'lte_primary' }) */
    ratePolicy?: RatePolicy;
}): RateCoherenceDiagnostic[] {
    const { builder, services, tagId } = params;
    const ratePolicy: RatePolicy = params.ratePolicy ?? { kind: "lte_primary" };
    const props = builder.getProps() as ServiceProps;

    // Indexes
    const fields = props.fields ?? [];
    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const tagById = new Map((props.filters ?? []).map((t) => [t.id, t]));
    const tag: Tag | undefined = tagById.get(tagId);

    // Baseline visible fields (no selection)
    const baselineFieldIds = builder.visibleFields(tagId, []);
    const baselineFields = baselineFieldIds
        .map((fid) => fieldById.get(fid))
        .filter(Boolean) as Field[];

    // Build the list of *simulation anchors* = every button in the baseline group
    const anchors: Array<{
        kind: "field" | "option";
        id: string;
        fieldId: string;
        label?: string;
        service_id?: number;
    }> = [];

    for (const f of baselineFields) {
        if (!isButton(f)) continue;

        if (Array.isArray(f.options) && f.options.length) {
            // Option buttons → every option becomes an anchor (even if it has no base service)
            for (const o of f.options) {
                anchors.push({
                    kind: "option",
                    id: o.id,
                    fieldId: f.id,
                    label: o.label ?? o.id,
                    service_id: numberOrUndefined((o as any).service_id),
                });
            }
        } else {
            // Non-option button → the field itself is an anchor (even if it has no base service)
            anchors.push({
                kind: "field",
                id: f.id,
                fieldId: f.id,
                label: f.label ?? f.id,
                service_id: numberOrUndefined((f as any).service_id),
            });
        }
    }

    const diags: RateCoherenceDiagnostic[] = [];
    const seen = new Set<string>(); // dedupe across simulations

    for (const anchor of anchors) {
        // Build the simulated “selected keys” (how includes_for_buttons is addressed)
        const selectedKeys =
            anchor.kind === "option"
                ? [`${anchor.fieldId}::${anchor.id}`]
                : [anchor.fieldId];

        // Recompute the visible group under this simulation
        const vgFieldIds = builder.visibleFields(tagId, selectedKeys);
        const vgFields = vgFieldIds
            .map((fid) => fieldById.get(fid))
            .filter(Boolean) as Field[];

        // Collect base service candidates in this simulated group
        const baseCandidates: Array<BaseCandidate> = [];

        for (const f of vgFields) {
            if (!isButton(f)) continue;

            if (Array.isArray(f.options) && f.options.length) {
                for (const o of f.options) {
                    const sid = numberOrUndefined((o as any).service_id);
                    const role = normalizeRole(o.pricing_role, "base");
                    if (sid == null || role !== "base") continue;
                    const r = rateOf(services, sid);
                    if (!isFiniteNumber(r)) continue;
                    baseCandidates.push({
                        kind: "option",
                        id: o.id,
                        label: o.label ?? o.id,
                        service_id: sid,
                        rate: r!,
                    });
                }
            } else {
                const sid = numberOrUndefined((f as any).service_id);
                const role = normalizeRole((f as any).pricing_role, "base");
                if (sid == null || role !== "base") continue;
                const r = rateOf(services, sid);
                if (!isFiniteNumber(r)) continue;
                baseCandidates.push({
                    kind: "field",
                    id: f.id,
                    label: f.label ?? f.id,
                    service_id: sid,
                    rate: r!,
                });
            }
        }

        if (baseCandidates.length === 0) continue;

        // Choose the “primary” for this simulation:
        // 1) Anchor’s base service (if present),
        // 2) else first base candidate (deterministic).
        const anchorPrimary =
            anchor.service_id != null
                ? pickByServiceId(baseCandidates, anchor.service_id)
                : undefined;

        const primary = anchorPrimary ? anchorPrimary : baseCandidates[0]!;

        // Compare every *other* candidate against the primary using the configured policy
        for (const cand of baseCandidates) {
            if (sameService(primary, cand)) continue;

            if (!rateOkWithPolicy(ratePolicy, cand.rate, primary.rate)) {
                const key = dedupeKey(tagId, anchor, primary, cand, ratePolicy);
                if (seen.has(key)) continue;
                seen.add(key);

                diags.push({
                    scope: "visible_group",
                    tagId,
                    primary,
                    offender: {
                        kind: cand.kind,
                        id: cand.id,
                        label: cand.label,
                        service_id: cand.service_id,
                        rate: cand.rate,
                    },
                    policy: ratePolicy.kind,
                    policyPct: "pct" in ratePolicy ? ratePolicy.pct : undefined,
                    message: explainRateMismatch(
                        ratePolicy,
                        primary.rate,
                        cand.rate,
                        describeLabel(tag),
                    ),
                    simulationAnchor: {
                        kind: anchor.kind,
                        id: anchor.id,
                        fieldId: anchor.fieldId,
                        label: anchor.label,
                    },
                });
            }
        }
    }

    return diags;
}

/* ───────────────────────── helpers ───────────────────────── */

function isButton(f: Field): boolean {
    // Buttons = explicit flag OR any option-based field
    if ((f as any).button === true) return true;
    return Array.isArray(f.options) && f.options.length > 0;
}

function normalizeRole(
    role: PricingRole | undefined,
    d: PricingRole,
): PricingRole {
    return role === "utility" || role === "base" ? role : d;
}

function numberOrUndefined(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function rateOf(
    map: DgpServiceMap,
    id: number | string | undefined,
): number | undefined {
    if (id === undefined || id === null) return undefined;
    const cap: DgpServiceCapability | undefined =
        map[Number(id)] ?? (map as any)[id];
    return cap?.rate;
}

function pickByServiceId<T extends BaseCandidate>(
    arr: T[],
    sid: number,
): T | undefined {
    return arr.find((x) => x.service_id === sid);
}

function sameService(a: { service_id: number }, b: { service_id: number }) {
    return a.service_id === b.service_id;
}

function rateOkWithPolicy(
    policy: RatePolicy,
    candRate: number,
    primaryRate: number,
): boolean {
    const rp = policy ?? { kind: "lte_primary" as const };
    switch (rp.kind) {
        case "lte_primary":
            return candRate <= primaryRate;
        case "within_pct": {
            const pct = Math.max(0, rp.pct ?? 0);
            return candRate <= primaryRate * (1 + pct / 100);
        }
        case "at_least_pct_lower": {
            const pct = Math.max(0, rp.pct ?? 0);
            return candRate <= primaryRate * (1 - pct / 100);
        }
        default:
            return candRate <= primaryRate;
    }
}

function describeLabel(tag?: Tag): string {
    const tagName = tag?.label ?? tag?.id ?? "tag";
    return `${tagName}`;
}

function explainRateMismatch(
    policy: RatePolicy,
    primary: number,
    candidate: number,
    where: string,
): string {
    switch (policy.kind) {
        case "lte_primary":
            return `Rate coherence failed (${where}): candidate ${candidate} must be ≤ primary ${primary}.`;
        case "within_pct":
            return `Rate coherence failed (${where}): candidate ${candidate} must be within ${policy.pct}% of primary ${primary}.`;
        case "at_least_pct_lower":
            return `Rate coherence failed (${where}): candidate ${candidate} must be at least ${policy.pct}% lower than primary ${primary}.`;
        default:
            return `Rate coherence failed (${where}): candidate ${candidate} mismatches primary ${primary}.`;
    }
}

function dedupeKey(
    tagId: string,
    anchor: { kind: "field" | "option"; id: string },
    primary: { service_id: number },
    cand: { service_id: number; id: string },
    rp: RatePolicy,
) {
    const rpKey =
        rp.kind +
        ("pct" in rp && typeof rp.pct === "number" ? `:${rp.pct}` : "");
    return `${tagId}|${anchor.kind}:${anchor.id}|p${primary.service_id}|c${cand.service_id}:${cand.id}|${rpKey}`;
}
```
---
`File: src/core/validate.ts`
```ts
// src/core/validate.ts
import type {
    ServiceProps,
    Tag,
    Field,

} from '../schema';
import type {
    DgpServiceMap,
} from '../schema/provider';
import type {
    DynamicRule,
    ValidationError,
    ValidatorOptions,
} from '../schema/validation';
import {isMultiField} from "../utils";
import {collectFailedFallbacks} from "./fallback";

const FLAG_KEYS = ['refill', 'cancel', 'dripfeed'] as const;
type FlagKey = typeof FLAG_KEYS[number];

/**
 * Validate a ServiceProps payload against structural, identity, visibility,
 * service/input, rates, constraints, and custom-field rules.
 *
 * Notes:
 * - JSON Schema should handle shape; this performs business logic checks.
 * - "custom component resolvable" requires a registry — not covered here.
 */
export function validate(
    props: ServiceProps,
    ctx: ValidatorOptions = {}
): ValidationError[] {
    const errors: ValidationError[] = [];
    const serviceMap: DgpServiceMap = ctx.serviceMap ?? {};
    const selectedKeys = new Set(ctx.selectedOptionKeys ?? []);

    const tagById = new Map<string, Tag>();
    const fieldById = new Map<string, Field>();

    /* ────────────────────────────────────────────────────────────────
     * 1) STRUCTURE: root, cycles, bind references
     * ──────────────────────────────────────────────────────────────── */
    const tags = Array.isArray(props.filters) ? props.filters : [];
    const fields = Array.isArray(props.fields) ? props.fields : [];

    // root present
    if (!tags.some(t => t.id === 'root')) {
        errors.push({code: 'root_missing'});
    }

    // indexes
    for (const t of tags) tagById.set(t.id, t);
    for (const f of fields) fieldById.set(f.id, f);

    // cycles in tag parentage
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycleFrom = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        const parent = tagById.get(id)?.bind_id;
        if (parent && tagById.has(parent) && hasCycleFrom(parent)) return true;
        visiting.delete(id);
        visited.add(id);
        return false;
    };
    for (const t of tags) {
        if (hasCycleFrom(t.id)) {
            errors.push({code: 'cycle_in_tags', nodeId: t.id});
            break; // one is enough to signal
        }
    }

    // tag.bind_id must point to existing tag (if present)
    for (const t of tags) {
        if (t.bind_id && !tagById.has(t.bind_id)) {
            errors.push({code: 'bad_bind_reference', nodeId: t.id, details: {ref: t.bind_id}});
        }
    }

    // field.bind_id must reference tags
    for (const f of fields) {
        const b = f.bind_id;
        if (Array.isArray(b)) {
            for (const id of b) {
                if (!tagById.has(id)) {
                    errors.push({code: 'bad_bind_reference', nodeId: f.id, details: {ref: id}});
                }
            }
        } else if (typeof b === 'string') {
            if (!tagById.has(b)) {
                errors.push({code: 'bad_bind_reference', nodeId: f.id, details: {ref: b}});
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────
     * 2) IDENTITY & LABELS
     * ──────────────────────────────────────────────────────────────── */
    // duplicate ids across tags + fields
    {
        const seen = new Set<string>();
        for (const t of tags) {
            if (seen.has(t.id)) errors.push({code: 'duplicate_id', nodeId: t.id});
            seen.add(t.id);
        }
        for (const f of fields) {
            if (seen.has(f.id)) errors.push({code: 'duplicate_id', nodeId: f.id});
            seen.add(f.id);
        }
    }

    // tag labels unique
    {
        const seen = new Map<string, string>(); // label -> tagId
        for (const t of tags) {
            if (!t.label || !t.label.trim()) {
                errors.push({code: 'label_missing', nodeId: t.id, details: {kind: 'tag'}});
            }
            const k = t.label;
            if (seen.has(k)) errors.push({code: 'duplicate_tag_label', nodeId: t.id, details: {other: seen.get(k)}});
            else seen.set(k, t.id);
        }
    }

    // field labels required; names unique among user-input fields
    {
        const seenNames = new Map<string, string>(); // name -> fieldId
        for (const f of fields) {
            if (!f.label || !f.label.trim()) {
                errors.push({code: 'label_missing', nodeId: f.id, details: {kind: 'field'}});
            }
            const isUserInput = !!f.name && !hasAnyServiceOption(f);
            if (isUserInput && f.name) {
                const k = f.name;
                if (seenNames.has(k)) errors.push({
                    code: 'duplicate_field_name',
                    nodeId: f.id,
                    details: {other: seenNames.get(k)}
                });
                else seenNames.set(k, f.id);
            }
        }
    }

    // option labels required
    for (const f of fields) {
        for (const o of f.options ?? []) {
            if (!o.label || !o.label.trim()) {
                errors.push({code: 'label_missing', nodeId: o.id, details: {kind: 'option', fieldId: f.id}});
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────
     * 3) OPTION MAPS: key validity + conflict
     * ──────────────────────────────────────────────────────────────── */
    const incMap = props.includes_for_buttons ?? {};
    const excMap = props.excludes_for_buttons ?? {};

    const parseKey = (key: string): { fieldId: string; optionId: string } | null => {
        const [fid, oid] = key.split('::');
        if (!fid || !oid) return null;
        return {fieldId: fid, optionId: oid};
    };

    const hasOption = (fid: string, oid: string): boolean => {
        const f = fieldById.get(fid);
        if (!f) return false;
        return !!(f.options ?? []).find(o => o.id === oid);
    };

    // bad_option_key
    for (const [k] of Object.entries(incMap)) {
        const p = parseKey(k);
        if (!p || !hasOption(p.fieldId, p.optionId)) {
            errors.push({code: 'bad_option_key', details: {key: k}});
        }
    }
    for (const [k] of Object.entries(excMap)) {
        const p = parseKey(k);
        if (!p || !hasOption(p.fieldId, p.optionId)) {
            errors.push({code: 'bad_option_key', details: {key: k}});
        }
    }

    // option_include_exclude_conflict
    for (const k of Object.keys(incMap)) {
        if (k in excMap) {
            const p = parseKey(k);
            errors.push({code: 'option_include_exclude_conflict', nodeId: p?.fieldId, details: {key: k}});
        }
    }

    /* ────────────────────────────────────────────────────────────────
     * 4) VISIBILITY: duplicate labels under a tag (bind/include − exclude)
     * (Option-level maps depend on runtime selection; ignored here)
     * ──────────────────────────────────────────────────────────────── */
    /* ───────── visibility helper (now selection-aware) ───────── */
    const fieldsVisibleUnder = (tagId: string): Field[] => {
        const tag = tagById.get(tagId);
        const includesTag = new Set(tag?.includes ?? []);
        const excludesTag = new Set(tag?.excludes ?? []);

        // Option-level maps only for the provided selections
        const incForOpt = props.includes_for_buttons ?? {};
        const excForOpt = props.excludes_for_buttons ?? {};

        const includesOpt = new Set<string>();
        const excludesOpt = new Set<string>();
        for (const key of selectedKeys) {
            for (const id of incForOpt[key] ?? []) includesOpt.add(id);
            for (const id of excForOpt[key] ?? []) excludesOpt.add(id);
        }

        // Base pool: bound + tag-includes + opt-includes
        const merged = new Map<string, Field>();
        for (const f of fields) {
            // bound to tag
            if (isBoundTo(f, tagId)) merged.set(f.id, f);
            // explicit includes (tag)
            if (includesTag.has(f.id)) merged.set(f.id, f);
            // option includes
            if (includesOpt.has(f.id)) merged.set(f.id, f);
        }

        // Remove excludes (tag + option)
        for (const id of excludesTag) merged.delete(id);
        for (const id of excludesOpt) merged.delete(id);

        return Array.from(merged.values());
    };

    /* ───────── duplicate visible labels (now selection-aware) ───────── */
    for (const t of tags) {
        const visible = fieldsVisibleUnder(t.id);
        const seen = new Map<string, string>();
        for (const f of visible) {
            const label = (f.label ?? '').trim();
            if (!label) continue;
            if (seen.has(label)) {
                errors.push({
                    code: 'duplicate_visible_label',
                    nodeId: f.id,
                    details: {tagId: t.id, other: seen.get(label)}
                });
            } else {
                seen.set(label, f.id);
            }
        }
    }

    /* ── Quantity marker rule: at most one marker per visible group (tag) ── */
    {
        for (const t of tags) {
            const visible = fieldsVisibleUnder(t.id);
            const markers: string[] = [];
            for (const f of visible) {
                const q = (f.meta as any)?.quantity;
                if (q) markers.push(f.id);
            }
            if (markers.length > 1) {
                errors.push({
                    code: 'quantity_multiple_markers',
                    nodeId: t.id,
                    details: {tagId: t.id, markers},
                });
            }
        }
    }

    /* ───────── utility_without_base per visible tag group (selection-aware) ───────── */
    for (const t of tags) {
        const visible = fieldsVisibleUnder(t.id);
        let hasBase = false;
        let hasUtility = false;
        const utilityOptionIds: string[] = [];

        for (const f of visible) {
            for (const o of f.options ?? []) {
                if (!isFiniteNumber(o.service_id)) continue;
                const role = o.pricing_role ?? f.pricing_role ?? 'base';
                if (role === 'base') hasBase = true;
                else if (role === 'utility') {
                    hasUtility = true;
                    utilityOptionIds.push(o.id);
                }
            }
        }
        if (hasUtility && !hasBase) {
            errors.push({code: 'utility_without_base', nodeId: t.id, details: {utilityOptionIds}});
        }
    }

    // --------- Dynamic policies (super-admin) --------------------------
    applyPolicies(errors, props, serviceMap, ctx.policies, fieldsVisibleUnder, tags);

    /* ────────────────────────────────────────────────────────────────
     * 5) SERVICE vs USER-INPUT RULES
     * ──────────────────────────────────────────────────────────────── */
    for (const f of fields) {
        const anySvc = hasAnyServiceOption(f);
        const hasName = !!(f.name && f.name.trim());
        // "custom" must not carry service options
        if (f.type === 'custom' && anySvc) {
            errors.push({
                code: 'user_input_field_has_service_option',
                nodeId: f.id,
                details: {reason: 'custom_cannot_map_service'}
            });
        }
        if (!hasName) {
            // treated as service-backed → require at least one service option
            if (!anySvc) {
                errors.push({code: 'service_field_missing_service_id', nodeId: f.id});
            }
        } else {
            // user-input → options must not carry service_id
            if (anySvc) {
                errors.push({code: 'user_input_field_has_service_option', nodeId: f.id});
            }
        }
    }

    // Utility rules — option-level (conflicts and marker validity)
    {
        const ALLOWED_UTILITY_MODES = new Set(['flat', 'per_quantity', 'per_value', 'percent']);
        for (const f of fields) {
            const optsArr = Array.isArray(f.options) ? f.options : [];
            for (const o of optsArr) {
                const role = o.pricing_role ?? f.pricing_role ?? 'base';
                const hasService = isFiniteNumber(o.service_id);
                const util = (o.meta as any)?.utility;

                if (role === 'utility' && hasService) {
                    errors.push({
                        code: 'utility_with_service_id',
                        nodeId: o.id,
                        details: {fieldId: f.id, optionId: o.id, service_id: o.service_id},
                    });
                }

                if (util) {
                    const mode = util.mode;
                    const rate = util.rate;
                    if (!isFiniteNumber(rate)) {
                        errors.push({
                            code: 'utility_missing_rate',
                            nodeId: o.id,
                            details: {fieldId: f.id, optionId: o.id},
                        });
                    }
                    if (!ALLOWED_UTILITY_MODES.has(mode)) {
                        errors.push({
                            code: 'utility_invalid_mode',
                            nodeId: o.id,
                            details: {fieldId: f.id, optionId: o.id, mode},
                        });
                    }
                }
            }
        }

        // Field-level utility marker validity
        for (const f of fields) {
            const util = (f.meta as any)?.utility;
            if (!util) continue;
            const mode = util.mode;
            const rate = util.rate;
            if (!isFiniteNumber(rate)) {
                errors.push({
                    code: 'utility_missing_rate',
                    nodeId: f.id,
                    details: {fieldId: f.id},
                });
            }
            if (!ALLOWED_UTILITY_MODES.has(mode)) {
                errors.push({
                    code: 'utility_invalid_mode',
                    nodeId: f.id,
                    details: {fieldId: f.id, mode},
                });
            }
        }
    }

    // within validate(), after fieldsVisibleUnder() is defined and before constraints section:

    /* ────────────────────────────────────────────────────────────────
     * 6) RATES & PRICING ROLES
     *    - utility_without_base: now per visible tag group
     *    - rate coherence across BASE options (unchanged)
     * ──────────────────────────────────────────────────────────────── */

    // A) utility_without_base per tag (visible group)
    for (const t of tags) {
        const visible = fieldsVisibleUnder(t.id);
        let hasBase = false;
        let hasUtility = false;
        const utilityOptionIds: string[] = [];

        for (const f of visible) {
            for (const o of f.options ?? []) {
                const sid = o.service_id;
                if (!isFiniteNumber(sid)) continue;
                const role = (o.pricing_role ?? f.pricing_role ?? 'base');
                if (role === 'base') hasBase = true;
                else if (role === 'utility') {
                    hasUtility = true;
                    utilityOptionIds.push(o.id);
                }
            }
        }

        if (hasUtility && !hasBase) {
            errors.push({
                code: 'utility_without_base',
                nodeId: t.id, // attach to the tag/group
                details: {utilityOptionIds}
            });
        }
    }

    // B) Per-field base-only rate coherence (kept as before)
    for (const f of fields) {
        if (!isMultiField(f)) continue;
        const baseRates = new Set<number>();
        for (const o of f.options ?? []) {
            const role = o.pricing_role ?? f.pricing_role ?? 'base';
            if (role !== 'base') continue;
            const sid = o.service_id;
            if (!isFiniteNumber(sid)) continue;
            const rate = serviceMap[sid!]?.rate;
            if (isFiniteNumber(rate)) baseRates.add(Number(rate));
        }
        if (baseRates.size > 1) {
            errors.push({code: 'rate_mismatch_across_base', nodeId: f.id});
        }
    }

    /* ────────────────────────────────────────────────────────────────
     * 7) CONSTRAINTS vs CAPABILITIES + INHERITANCE
     * ──────────────────────────────────────────────────────────────── */
    // Build ancestor chain resolver
// Inheritance contradiction (nearest ancestor wins; descendants cannot contradict)
    // effective constraint resolution (nearest ancestor wins)
    const flags: Array<keyof NonNullable<Tag['constraints']>> = ['refill', 'cancel', 'dripfeed'];

    function effectiveConstraints(tagId: string): Partial<Record<typeof flags[number], boolean>> {
        const out: Partial<Record<typeof flags[number], boolean>> = {};
        for (const key of flags) {
            // walk up until you find a defined value
            let cur: string | undefined = tagId;
            const seen = new Set<string>();
            while (cur && !seen.has(cur)) {
                seen.add(cur);
                const t = tagById.get(cur);
                const v = t?.constraints?.[key];
                if (v !== undefined) {
                    out[key] = v;
                    break;
                }
                cur = t?.bind_id;
            }
        }
        return out;
    }

    // Enforce tag constraints on visible options' services
    for (const t of tags) {
        const eff = effectiveConstraints(t.id);
        if (!FLAG_KEYS.some(k => eff[k] === true)) continue; // nothing to enforce

        const visible = fieldsVisibleUnder(t.id);
        for (const f of visible) {
            for (const o of f.options ?? []) {
                if (!isFiniteNumber(o.service_id)) continue;
                const svc = serviceMap[o.service_id];
                if (!svc) continue;

                for (const k of FLAG_KEYS) {
                    if (eff[k] === true && (svc as any)[k] === false) {
                        errors.push({
                            code: 'unsupported_constraint_option',
                            nodeId: o.id,
                            details: {tagId: t.id, flag: k, serviceId: o.service_id},
                        });
                    }
                }
            }
        }
    }

    // Unsupported constraint vs tag's mapped service capabilities
    for (const t of tags) {
        const sid = t.service_id;
        if (!isFiniteNumber(sid)) continue;
        const svc = serviceMap[Number(sid)];
        if (!svc) continue;

        const eff = effectiveConstraints(t.id); // ← use inherited constraints

        if (eff.refill === true && svc.refill === false) {
            errors.push({code: 'unsupported_constraint', nodeId: t.id, details: {flag: 'refill', serviceId: sid}});
        }
        if (eff.cancel === true && svc.cancel === false) {
            errors.push({code: 'unsupported_constraint', nodeId: t.id, details: {flag: 'cancel', serviceId: sid}});
        }
        if (eff.dripfeed === true && svc.dripfeed === false) {
            errors.push({code: 'unsupported_constraint', nodeId: t.id, details: {flag: 'dripfeed', serviceId: sid}});
        }
    }

    // src/core/validate.ts (near other constraint checks)
    for (const t of tags) {
        const ov = t.constraints_overrides;
        if (!ov) continue;
        for (const k of Object.keys(ov) as FlagKey[]) {
            const {from, to, origin} = ov[k]!;
            errors.push({
                code: 'constraint_overridden',
                nodeId: t.id,
                details: {
                    flag: k,
                    from, to,
                    origin,
                    severity: 'warning'
                },
            } as any);
        }
    }

    /* ────────────────────────────────────────────────────────────────
     * 8) CUSTOM FIELD RULES
     * ──────────────────────────────────────────────────────────────── */
    for (const f of fields) {
        if (f.type === 'custom') {
            if (!f.component || !String(f.component).trim()) {
                errors.push({code: 'custom_component_missing', nodeId: f.id});
            }
            // "unresolvable" would require a registry; not checked here
        }
    }

    // ─── Optional global guard (lint) ───────────────────────────────
    if (ctx.globalUtilityGuard) {
        let hasUtility = false;
        let hasBase = false;

        for (const f of fields) {
            for (const o of f.options ?? []) {
                if (!isFiniteNumber(o.service_id)) continue;
                const role = o.pricing_role ?? f.pricing_role ?? 'base';
                if (role === 'base') hasBase = true;
                else if (role === 'utility') hasUtility = true;
                if (hasUtility && hasBase) break;
            }
            if (hasUtility && hasBase) break;
        }

        if (hasUtility && !hasBase) {
            errors.push({
                code: 'utility_without_base',
                nodeId: 'global',                 // ← signals it’s the global lint
                details: {scope: 'global'}      // ← consumers can treat as warning
            });
        }
    }


    // ─── Unbound fields: must be bound or included somewhere ────────────────
    {
        const boundFieldIds = new Set<string>();
        for (const f of fields) {
            if (f.bind_id) boundFieldIds.add(f.id);
        }

        const includedByTag = new Set<string>();
        for (const t of tags) {
            for (const id of t.includes ?? []) includedByTag.add(id);
        }

        const includedByOption = new Set<string>();
        for (const arr of Object.values(props.includes_for_buttons ?? {})) {
            for (const id of arr ?? []) includedByOption.add(id);
        }

        for (const f of fields) {
            if (
                !boundFieldIds.has(f.id) &&
                !includedByTag.has(f.id) &&
                !includedByOption.has(f.id)
            ) {
                errors.push({code: 'field_unbound', nodeId: f.id});
            }
        }
    }

    // ── Fallback validation ────────────────────────────────────────────────
    const mode = ctx.fallbackSettings?.mode ?? 'strict';
    if (props.fallbacks) {
        const diags = collectFailedFallbacks(
            props,
            ctx.serviceMap ?? {},
            {...ctx.fallbackSettings, mode: 'dev'} // collect non-fatal diagnostics
        );

        if (mode === 'strict') {
            // Convert node-scoped violations into ValidationError; global stays soft
            for (const d of diags) {
                if (d.scope === 'global') continue;
                // Only report when the candidate failed in all of its contexts. We approximate:
                // group by (nodeId,candidate) and check if we only saw failing reasons.
                // For simplicity, we emit per-failing context; editor may prune accordingly.
                const code =
                    d.reason === 'unknown_service' ? 'fallback_unknown_service' :
                        d.reason === 'no_primary' ? 'fallback_no_primary' :
                            d.reason === 'rate_violation' ? 'fallback_rate_violation' :
                                d.reason === 'constraint_mismatch' ? 'fallback_constraint_mismatch' :
                                    d.reason === 'cycle' ? 'fallback_cycle' :
                                        'fallback_bad_node';

                errors.push({
                    code: code as any,
                    nodeId: d.nodeId,
                    details: {
                        primary: d.primary,
                        candidate: d.candidate,
                        tagContext: d.tagContext,
                        scope: d.scope,
                    },
                });
            }
        }
    }

    return errors;
}


// ───────────────────── Policy helpers ─────────────────────

type ServiceItem = {
    tagId?: string;
    fieldId: string;
    optionId: string;
    serviceId: number;
    role: 'base' | 'utility';
    // capability snapshot (if present in serviceMap)
    service?: {
        id?: number;
        key?: string;
        type?: string;
        rate?: number;
        handler_id?: number;
        platform_id?: number;
        dripfeed?: boolean;
        refill?: boolean;
        cancel?: boolean;
        [k: string]: unknown;
    };
};

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
}

function getByPath(obj: any, path: string | undefined): unknown {
    if (!path) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

/** Build a list of ServiceItems from a set of fields, filtered by role and id filters */
function collectServiceItems(
    fields: Field[],
    tagId: string | undefined,
    serviceMap: DgpServiceMap,
    filter?: DynamicRule['filter'],
): ServiceItem[] {
    const roleFilter = filter?.role ?? 'both';
    const fieldIdAllow = asArray(filter?.field_id);
    const tagIdAllow = asArray(filter?.tag_id);
    const handlerAllow = asArray(filter?.handler_id);
    const platformAllow = asArray(filter?.platform_id);

    const out: ServiceItem[] = [];

    for (const f of fields) {
        if (fieldIdAllow && !fieldIdAllow.includes(f.id)) continue;

        for (const o of f.options ?? []) {
            const sid = o.service_id;
            if (typeof sid !== 'number' || !Number.isFinite(sid)) continue;

            const role = (o.pricing_role ?? f.pricing_role ?? 'base') as 'base' | 'utility';
            if (roleFilter !== 'both' && role !== roleFilter) continue;

            const svc = serviceMap[sid];
            if (handlerAllow && (svc?.handler_id == null || !handlerAllow.includes(svc.handler_id))) continue;
            if (platformAllow && (svc?.platform_id == null || !platformAllow.includes(svc.platform_id))) continue;
            if (tagIdAllow && (!tagId || !tagIdAllow.includes(tagId))) continue;

            out.push({
                tagId,
                fieldId: f.id,
                optionId: o.id,
                serviceId: sid,
                role,
                service: svc ? {
                    id: svc.id,
                    key: svc.key as any,
                    type: (svc as any).type as any, // optional in your map
                    rate: svc.rate,
                    handler_id: (svc as any).handler_id as any,
                    platform_id: (svc as any).platform_id as any,
                    dripfeed: svc.dripfeed,
                    refill: svc.refill,
                    cancel: svc.cancel,
                    ...svc.meta,
                } : undefined,
            });
        }
    }
    return out;
}

function evalPolicyOp(op: DynamicRule['op'], values: unknown[], rule: DynamicRule): boolean {
    switch (op) {
        case 'all_equal': {
            const set = new Set(values.map(v => JSON.stringify(v)));
            return set.size <= 1;
        }
        case 'no_mix': {
            const set = new Set(values.map(v => JSON.stringify(v)));
            return set.size <= 1;
        }
        case 'unique': {
            const seen = new Set<string>();
            for (const v of values) {
                const k = JSON.stringify(v);
                if (seen.has(k)) return false;
                seen.add(k);
            }
            return true;
        }
        case 'all_true': {
            return values.every(v => v === true);
        }
        case 'any_true': {
            return values.some(v => v === true);
        }
        case 'max_count': {
            const limit = typeof rule.value === 'number' ? rule.value : Infinity;
            return values.length <= limit;
        }
        case 'min_count': {
            const min = typeof rule.value === 'number' ? rule.value : 0;
            return values.length >= min;
        }
        default:
            return true;
    }
}

function applyPolicies(
    errors: ValidationError[],
    props: ServiceProps,
    serviceMap: DgpServiceMap,
    policies: DynamicRule[] | undefined,
    fieldsVisibleUnder: (tagId: string) => Field[],
    tags: Tag[],
): void {
    if (!policies?.length) return;

    for (const rule of policies) {
        const projPath = rule.projection ?? 'service.id';

        if (rule.scope === 'global') {
            const allFields = props.fields ?? [];
            const items = collectServiceItems(allFields, undefined, serviceMap, rule.filter);
            const values = items.map(it => getByPath(it, projPath));

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: 'policy_violation',
                    nodeId: 'global',
                    details: {
                        ruleId: rule.id,
                        scope: 'global',
                        severity: rule.severity ?? 'error',
                        op: rule.op,
                        projection: projPath,
                        count: items.length,
                    },
                });
            }
            continue;
        }

        // visible_group
        for (const t of tags) {
            const visibleFields = fieldsVisibleUnder(t.id);
            const items = collectServiceItems(visibleFields, t.id, serviceMap, rule.filter);
            if (!items.length) continue;

            const values = items.map(it => getByPath(it, projPath));

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: 'policy_violation',
                    nodeId: t.id,
                    details: {
                        ruleId: rule.id,
                        scope: 'visible_group',
                        severity: rule.severity ?? 'error',
                        op: rule.op,
                        projection: projPath,
                        count: items.length,
                    },
                });
            }
        }
    }
}

/* ───────────────────────── helpers ───────────────────────── */

function hasAnyServiceOption(f: Field): boolean {
    return (f.options ?? []).some(o => isFiniteNumber(o.service_id));
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

// ─── helper: is a field bound to a given tag? ───────────────────────────────────
function isBoundTo(f: Field, tagId: string): boolean {
    const b = f.bind_id;
    if (!b) return false;
    return Array.isArray(b) ? b.includes(tagId) : b === tagId;
}
```
---
`File: src/react/canvas/api.ts`
```ts
import { EventBus } from "./events";
import type {
    CanvasEvents,
    CanvasOptions,
    CanvasState,
    NodePositions,
    Viewport,
    DraftWire,
} from "../../schema/canvas-types";
import type { Builder } from "../../core";
import type { EdgeKind, GraphSnapshot } from "../../schema/graph";
import { CommentsAPI } from "./comments";
import { CanvasBackendOptions } from "./backend";
import { Editor } from "./editor";

export class CanvasAPI {
    private bus = new EventBus<CanvasEvents>();
    private readonly state: CanvasState;
    private builder: Builder;
    public readonly editor: Editor;
    private readonly autoEmit: boolean;
    readonly comments: CommentsAPI;

    constructor(
        builder: Builder,
        opts: CanvasOptions & CanvasBackendOptions = {},
    ) {
        this.builder = builder;
        this.autoEmit = opts.autoEmitState ?? true;

        const graph = builder.tree();
        this.state = {
            graph,
            positions: {},
            selection: new Set(),
            highlighted: new Set(),
            viewport: { x: 0, y: 0, zoom: 1, ...opts.initialViewport },
            version: 1,
        };

        // compose comments with backend (if provided)
        this.comments = new CommentsAPI(this.bus, {
            backend: opts.backend?.comments,
            workspaceId: opts.workspaceId,
            actor: opts.actor,
        });

        this.editor = new Editor(builder, this, {
            serviceMap: builder.getServiceMap(),
            serviceExists: (id) => builder.getServiceMap().hasOwnProperty(id),
            ...opts,
        });

        if (this.autoEmit) this.bus.emit("state:change", this.snapshot());
    }

    /* ─── Events ─────────────────────────────────────────────── */
    on = this.bus.on.bind(this.bus);
    once = this.bus.once.bind(this.bus);

    public emit<K extends keyof CanvasEvents>(
        event: K,
        payload: CanvasEvents[K],
    ): void {
        this.bus.emit(event, payload);
    }

    /* ─── State accessors ───────────────────────────────────── */
    snapshot(): CanvasState {
        // return an immutable-looking view
        return {
            ...this.state,
            selection: new Set(this.state.selection),
            highlighted: new Set(this.state.highlighted),
            graph: {
                nodes: [...this.state.graph.nodes],
                edges: [...this.state.graph.edges],
            },
            positions: { ...this.state.positions },
        };
    }

    getGraph(): GraphSnapshot {
        return this.state.graph;
    }

    getSelection(): string[] {
        return Array.from(this.state.selection);
    }

    getViewport(): Viewport {
        return { ...this.state.viewport };
    }

    /* ─── Graph lifecycle ───────────────────────────────────── */
    refreshGraph(): void {
        this.state.graph = this.builder.tree();
        this.bump();
        this.bus.emit("graph:update", this.state.graph);
    }

    setPositions(pos: NodePositions): void {
        this.state.positions = { ...this.state.positions, ...pos };
        this.bump();
    }

    setPosition(id: string, x: number, y: number): void {
        this.state.positions[id] = { x, y };
        this.bump();
    }

    /* ─── Selection ─────────────────────────────────────────── */
    select(ids: string[] | Set<string>): void {
        this.state.selection = new Set(ids as any);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    selectComments(threadId?: string): void {
        this.bus.emit("comment:select", { threadId });
    }

    addToSelection(ids: string[] | Set<string>): void {
        for (const id of ids as any) this.state.selection.add(id);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    toggleSelection(id: string): void {
        if (this.state.selection.has(id)) this.state.selection.delete(id);
        else this.state.selection.add(id);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    clearSelection(): void {
        if (this.state.selection.size === 0) return;
        this.state.selection.clear();
        this.bump();
        this.bus.emit("selection:change", { ids: [] });
    }

    /* ─── Highlight / Hover ─────────────────────────────────── */
    setHighlighted(ids: string[] | Set<string>): void {
        this.state.highlighted = new Set(ids as any);
        this.bump();
    }

    setHover(id?: string): void {
        this.state.hoverId = id;
        this.bump();
        this.bus.emit("hover:change", { id });
    }

    /* ─── Viewport ──────────────────────────────────────────── */
    setViewport(v: Partial<Viewport>): void {
        this.state.viewport = { ...this.state.viewport, ...v };
        this.bump();
        this.bus.emit("viewport:change", this.getViewport());
    }

    /* ─── Wiring draft (for bind/include/exclude UX) ────────── */
    startWire(from: string, kind: DraftWire["kind"]): void {
        this.state.draftWire = { from, kind };
        this.bump();
        this.bus.emit("wire:preview", { from, kind });
    }

    previewWire(to?: string): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        this.bus.emit("wire:preview", { from: dw.from, to, kind: dw.kind });
    }

    commitWire(to: string): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        // Headless API emits; the adapter/host decides how to mutate Builder
        this.bus.emit("wire:commit", { from: dw.from, to, kind: dw.kind });
        this.state.draftWire = undefined;
        this.bump();
    }

    cancelWire(): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        this.bus.emit("wire:cancel", { from: dw.from });
        this.state.draftWire = undefined;
        this.bump();
    }

    /* ─── Utilities ─────────────────────────────────────────── */
    private bump(): void {
        this.state.version++;
        if (this.autoEmit) this.bus.emit("state:change", this.snapshot());
    }

    dispose(): void {
        this.bus.clear();
    }

    undo() {
        this.builder.undo();
        this.refreshGraph();
    }

    private edgeRel: EdgeKind = "bind";
    getEdgeRel(): EdgeKind {
        return this.edgeRel;
    }

    public setEdgeRel(rel: EdgeKind) {
        if (this.edgeRel === rel) return; // ← correct: skip only if identical
        this.edgeRel = rel;
        this.refreshGraph();
    }

    /* ─── Option-node visibility (per field) ───────────────────────────────── */

    /** Internal mirror of which fields should show their options as nodes. */
    private shownOptionFields = new Set<string>();

    /** Return the field ids whose options are currently set to be visible as nodes. */
    getShownOptionFields(): string[] {
        return Array.from(this.shownOptionFields);
    }

    /** True if this field’s options are shown as nodes. */
    isFieldOptionsShown(fieldId: string): boolean {
        return this.shownOptionFields.has(String(fieldId));
    }

    /**
     * Set visibility of option nodes for a field, then rebuild the graph.
     * When shown = true, the Builder will emit option nodes for this field.
     */
    setFieldOptionsShown(fieldId: string, shown: boolean): void {
        const id = String(fieldId);
        const before = this.shownOptionFields.has(id);
        if (shown && !before) this.shownOptionFields.add(id);
        else if (!shown && before) this.shownOptionFields.delete(id);
        else return; // no-op

        // Push to builder options and refresh
        this.builder.setOptions({
            showOptionNodes: new Set(this.shownOptionFields),
        });
        this.refreshGraph();
    }

    /** Toggle option-node visibility for a field. Returns the new visibility. */
    toggleFieldOptions(fieldId: string): boolean {
        const next = !this.isFieldOptionsShown(fieldId);
        this.setFieldOptionsShown(fieldId, next);
        return next;
    }

    /**
     * Replace the whole set of fields whose options are visible as nodes.
     * Useful for restoring a saved UI state.
     */
    setShownOptionFields(ids: Iterable<string>): void {
        const next = new Set(Array.from(ids, String));
        // Fast-path: if identical set, skip work
        if (
            next.size === this.shownOptionFields.size &&
            Array.from(next).every((id) => this.shownOptionFields.has(id))
        ) {
            return;
        }
        this.shownOptionFields = next;
        this.builder.setOptions({
            showOptionNodes: new Set(this.shownOptionFields),
        });
        this.refreshGraph();
    }
}
```
---
`File: src/react/canvas/backend.ts`
```ts
// Transport-agnostic backend interfaces the HOST must implement

import type {CommentAnchor, CommentMessage, CommentThread} from './comments';

export type BackendError = {
    code: 'network' | 'forbidden' | 'not_found' | 'validation' | 'conflict' | 'unknown';
    message: string;
    meta?: any;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: BackendError };

// Minimal identity for annotation; permissions enforced server-side
export type Actor = { id: string; name?: string; avatarUrl?: string };

/**
 * Wire format is intentionally the same shape as headless types, so hosts can
 * pass data through if they like. They may add backend-specific fields via `meta`.
 */
export type CommentThreadDTO = CommentThread;
export type CommentMessageDTO = CommentMessage;

export interface CommentsBackend {
    // Load all threads for a canvas/workspace
    listThreads(ctx: { workspaceId: string }): Promise<Result<CommentThreadDTO[]>>;

    // Create thread with initial message
    createThread(ctx: { workspaceId: string; actor?: Actor }, input: {
        anchor: CommentAnchor;
        body: string;
        meta?: Record<string, unknown>;
    }): Promise<Result<CommentThreadDTO>>;

    addMessage(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
        body: string;
        meta?: Record<string, unknown>;
    }): Promise<Result<CommentMessageDTO>>;

    editMessage(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
        messageId: string;
        body: string;
    }): Promise<Result<CommentMessageDTO>>;

    deleteMessage(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
        messageId: string;
    }): Promise<Result<void>>;

    moveThread(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
        anchor: CommentAnchor;
    }): Promise<Result<CommentThreadDTO>>;

    resolveThread(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
        resolved: boolean;
    }): Promise<Result<CommentThreadDTO>>;

    deleteThread(ctx: { workspaceId: string; actor?: Actor }, input: {
        threadId: string;
    }): Promise<Result<void>>;
}

export type CanvasBackend = {
    comments?: CommentsBackend;
};

export type CanvasBackendOptions = {
    backend?: CanvasBackend;
    workspaceId?: string; // host-provided scope for loading/saving
    actor?: Actor;
};
```
---
`File: src/react/canvas/comments.ts`
```ts
import type {EventBus} from './events';
import type {CanvasEvents} from '../../schema/canvas-types';
import type {CommentsBackend, Actor, BackendError} from './backend';
import {RetryQueue, type RetryOptions as RetryOpts} from "../../utils/retry-queue";

export type CommentId = string;
export type ThreadId = string;

export type CommentAnchor =
    | { type: 'node'; nodeId: string; offset?: { dx: number; dy: number } }
    | { type: 'edge'; edgeId: string; t?: number }
    | { type: 'free'; position: { x: number; y: number } };

export type CommentMessage = {
    id: CommentId;
    authorId?: string;
    authorName?: string;
    body: string;
    createdAt: number;
    editedAt?: number;
    meta?: Record<string, unknown>;
};

export type CommentThread = {
    id: ThreadId;
    anchor: CommentAnchor;
    resolved: boolean;
    createdAt: number;
    updatedAt: number;
    messages: CommentMessage[];
    meta?: Record<string, unknown>;
    // local sync flags (not persisted by server)
    _sync?: 'pending' | 'synced' | 'error';
};

let __seq = 0;
const newLocalId = (p = 'loc'): string => `${p}_${Date.now().toString(36)}_${(++__seq).toString(36)}`;

type CommentsDeps = {
    backend?: CommentsBackend;
    workspaceId?: string;
    actor?: Actor;
    retry?: RetryOpts;
};

export class CommentsAPI {
    private threads = new Map<ThreadId, CommentThread>();
    private bus: EventBus<CanvasEvents>;
    private deps: CommentsDeps;
    private retry: RetryQueue;

    constructor(bus: EventBus<CanvasEvents>, deps: CommentsDeps = {}) {
        this.bus = bus;
        this.deps = deps;
        this.retry = new RetryQueue(deps.retry);
    }

    private emitSync(op: CanvasEvents['comment:sync']['op'], threadId: string, messageId: string | undefined, status: CanvasEvents['comment:sync']['status'], meta: {
        attempt: number;
        nextDelayMs?: number;
        error?: BackendError | unknown
    }) {
        this.bus.emit('comment:sync', {
            op,
            threadId,
            messageId,
            status,
            attempt: meta.attempt,
            nextDelayMs: meta.nextDelayMs,
            error: meta.error
        });
    }

    /* ─── Persistence bridge ───────────────────────────── */

    async loadAll(): Promise<void> {
        if (!this.deps.backend || !this.deps.workspaceId) return;
        const res = await this.deps.backend.listThreads({workspaceId: this.deps.workspaceId});
        if (!res.ok) {
            this.bus.emit('error', {message: res.error.message, code: res.error.code, meta: res.error.meta});
            return;
        }
        this.threads.clear();
        for (const th of res.data) this.threads.set(th.id, {...th, _sync: 'synced'});
        this.bus.emit('comment:thread:update', {thread: undefined as any}); // signal refresh
    }

    /* ─── Query ─────────────────────────────────────────── */
    list(): CommentThread[] {
        return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
    }

    get(id: ThreadId): CommentThread | undefined {
        return this.threads.get(id);
    }

    /* ─── Mutations (optimistic if backend present) ─────── */

    async create(anchor: CommentAnchor, initialBody: string, meta?: Record<string, unknown>): Promise<ThreadId> {
        const now = Date.now();
        const localId = newLocalId('t');
        const msgId = newLocalId('m');

        const local: CommentThread = {
            id: localId,
            anchor,
            resolved: false,
            createdAt: now,
            updatedAt: now,
            messages: [{id: msgId, body: initialBody, createdAt: now}],
            meta,
            _sync: this.deps.backend ? 'pending' : 'synced',
        };
        this.threads.set(localId, local);
        this.bus.emit('comment:thread:create', {thread: local});

        if (!this.deps.backend || !this.deps.workspaceId) return localId;

        const performOnce = async () => {
            const res = await this.deps.backend!.createThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {anchor, body: initialBody, meta}
            );
            if (!res.ok) throw res.error;
            // Swap local→server on success
            this.threads.delete(localId);
            const serverTh: CommentThread = {...res.data, _sync: 'synced'};
            this.threads.set(serverTh.id, serverTh);
            this.bus.emit('comment:thread:update', {thread: serverTh});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            // schedule retry
            const jobId = `comments:create_thread:${localId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async (_attempt) => {
                    try {
                        await performOnce();
                        return true;
                    } catch (e) {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('create_thread', localId, undefined, status, meta ?? {attempt: 0}),
            });
            // mark error locally (UI can show badge)
            local._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Create failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: local});
        }

        return localId;
    }

    async reply(threadId: ThreadId, body: string, meta?: Record<string, unknown>): Promise<CommentId> {
        const th = this.ensure(threadId);
        const now = Date.now();
        const localMid = newLocalId('m');
        const localMsg: CommentMessage = {id: localMid, body, createdAt: now, meta};
        th.messages.push(localMsg);
        th.updatedAt = now;
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:message:create', {threadId, message: localMsg});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return localMid;

        const performOnce = async () => {
            const res = await this.deps.backend!.addMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, body, meta}
            );
            if (!res.ok) throw res.error;
            const idx = th.messages.findIndex(m => m.id === localMid);
            if (idx >= 0) th.messages[idx] = res.data;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:add_message:${threadId}:${localMid}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('add_message', threadId, localMid, status, meta ?? {attempt: 0}),
            });
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Reply failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
        return localMid;
    }

    async editMessage(threadId: ThreadId, messageId: CommentId, body: string): Promise<void> {
        const th = this.ensure(threadId);
        const orig = th.messages.find(m => m.id === messageId);
        if (!orig) return;
        const previous = {...orig};
        orig.body = body;
        orig.editedAt = Date.now();
        th.updatedAt = orig.editedAt;
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.editMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, messageId, body}
            );
            if (!res.ok) throw res.error;
            const idx = th.messages.findIndex(m => m.id === messageId);
            if (idx >= 0) th.messages[idx] = res.data;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:edit_message:${threadId}:${messageId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('edit_message', threadId, messageId, status, meta ?? {attempt: 0}),
            });
            // rollback on immediate failure to keep UI honest
            const idx = th.messages.findIndex(m => m.id === messageId);
            if (idx >= 0) th.messages[idx] = previous;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Edit failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async deleteMessage(threadId: ThreadId, messageId: CommentId): Promise<void> {
        const th = this.ensure(threadId);
        const backup = [...th.messages];
        th.messages = th.messages.filter(m => m.id !== messageId);
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.deleteMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, messageId}
            );
            if (!res.ok) throw res.error;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:delete_message:${threadId}:${messageId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('delete_message', threadId, messageId, status, meta ?? {attempt: 0}),
            });
            // rollback UI on immediate failure
            th.messages = backup;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Delete failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async move(threadId: ThreadId, anchor: CommentAnchor): Promise<void> {
        const th = this.ensure(threadId);
        const prev = th.anchor;
        th.anchor = anchor;
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:move', {thread: th});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.moveThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, anchor}
            );
            if (!res.ok) throw res.error;
            this.threads.set(th.id, {...res.data, _sync: 'synced'});
            this.bus.emit('comment:thread:update', {thread: this.threads.get(threadId)!});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:move_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('move_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            th.anchor = prev;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Move failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async resolve(threadId: ThreadId, value = true): Promise<void> {
        const th = this.ensure(threadId);
        const prev = th.resolved;
        th.resolved = value;
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:resolve', {thread: th, resolved: value});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.resolveThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, resolved: value}
            );
            if (!res.ok) throw res.error;
            this.threads.set(th.id, {...res.data, _sync: 'synced'});
            this.bus.emit('comment:thread:update', {thread: this.threads.get(threadId)!});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:resolve_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('resolve_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            th.resolved = prev;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Resolve failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async deleteThread(threadId: ThreadId): Promise<void> {
        const prev = this.threads.get(threadId);
        if (!prev) return;
        this.threads.delete(threadId);
        this.bus.emit('comment:thread:delete', {threadId});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.deleteThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId}
            );
            if (!res.ok) throw res.error;
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:delete_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('delete_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            // rollback deletion so user can retry
            this.threads.set(threadId, prev);
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Delete thread failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: prev!});
        }
    }

    // Optional helpers for UI controls
    retryJob(jobId: string): boolean {
        return this.retry.triggerNow(jobId);
    }

    cancelJob(jobId: string): boolean {
        return this.retry.cancel(jobId);
    }

    pendingJobs(): string[] {
        return this.retry.pendingIds();
    }

    /* ─── internal ────────────────────────────────────────── */
    private ensure(threadId: ThreadId): CommentThread {
        const th = this.threads.get(threadId);
        if (!th) throw new Error(`Comment thread not found: ${threadId}`);
        return th;
    }
}
```
---
`File: src/react/canvas/context.tsx`
```tsx
import React, {createContext, useContext, useEffect, useMemo, useRef} from 'react';
import type {ReactNode} from 'react';
import {CanvasAPI} from './api';
import {Builder, BuilderOptions, createBuilder} from '../../core';
import type {CanvasOptions} from '../../schema/canvas-types';
import type {CanvasBackendOptions} from './backend';
import {ServiceProps} from "../../schema";

const Ctx = createContext<CanvasAPI | null>(null);

export function CanvasProvider({api, children}: { api: CanvasAPI; children: ReactNode }) {
    return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCanvasAPI(): CanvasAPI {
    const api = useContext(Ctx);
    if (!api) throw new Error('useCanvasAPI must be used within <CanvasProvider>');
    return api;
}

/**
 * Create & memoize a CanvasAPI from a Builder.
 * - Disposes the previous API when builder changes.
 * - Accepts both view/state options and backend options.
 * - Warns (DEV only) if `opts` identity is changing every render.
 */
export function useCanvasFromBuilder(
    builder: Builder,
    opts?: CanvasOptions & CanvasBackendOptions
): CanvasAPI {
    // Warn (DEV) if the raw opts reference is churning each render
    useDevWarnOnOptsChurn(opts);

    // Stabilize opts content to avoid churn-driven re-instantiation
    const lastOptsRef = useRef<CanvasOptions & CanvasBackendOptions | undefined>(undefined);
    const stableOpts =
        opts && lastOptsRef.current && shallowEqualOpts(lastOptsRef.current, opts)
            ? lastOptsRef.current
            : (lastOptsRef.current = opts);

    const api = useMemo(() => new CanvasAPI(builder, stableOpts), [builder, stableOpts]);

    useEffect(() => {
        return () => {
            // Clean up listeners / timers when API instance is replaced or unmounted
            api.dispose?.();
        };
    }, [api]);

    return api;
}

/**
 * Use an existing CanvasAPI instance without creating/disposing anything.
 * Useful when the host fully manages the API lifecycle (e.g., from a parent).
 */
export function useCanvasFromExisting(api: CanvasAPI): CanvasAPI {
    // No disposal here—the host owns the instance
    return api;
}

/* ───────────────────────── helpers ───────────────────────── */

function shallowEqualOpts(
    a?: CanvasOptions & CanvasBackendOptions,
    b?: CanvasOptions & CanvasBackendOptions
) {
    if (a === b) return true;
    if (!a || !b) return false;
    const aKeys = Object.keys(a) as (keyof (CanvasOptions & CanvasBackendOptions))[];
    const bKeys = Object.keys(b) as (keyof (CanvasOptions & CanvasBackendOptions))[];
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if ((a as any)[k] !== (b as any)[k]) return false;
    }
    return true;
}

/** DEV-only: warn if opts identity changes on most renders (suggests wrapping in useMemo). */
function useDevWarnOnOptsChurn(opts?: CanvasOptions & CanvasBackendOptions) {
    const rawRef = useRef<typeof opts>(undefined);
    const churnCountRef = useRef(0);
    const lastWindowStartRef = useRef<number>(Date.now());
    const warnedRef = useRef(false);

    useEffect(() => {
        //@ts-ignore
        if (window.SITE?.env === 'production') return;
        const now = Date.now();

        // Reset window every 2s
        if (now - lastWindowStartRef.current > 2000) {
            lastWindowStartRef.current = now;
            churnCountRef.current = 0;
        }

        if (rawRef.current !== opts) {
            churnCountRef.current += 1;
            rawRef.current = opts;
        }

        // If we see churn on most renders in the window, warn once.
        if (!warnedRef.current && churnCountRef.current >= 5) {
            warnedRef.current = true;
            // eslint-disable-next-line no-console
            console.warn(
                '[digital-service-ui-builder] useCanvasFromBuilder: `opts` is changing identity frequently. ' +
                'Wrap your options in useMemo to avoid unnecessary API re-instantiation.'
            );
        }
    });
}

type UseCanvasOwnedReturn = { api: CanvasAPI; builder: Builder };

/** Creates a Builder once, loads initial props once, and owns the CanvasAPI lifecycle. */
export function useCanvasOwned(
    initialProps?: ServiceProps,
    canvasOpts?: CanvasOptions & CanvasBackendOptions,
    builderOpts?: BuilderOptions                    // ← pass builder params here
): UseCanvasOwnedReturn {
    // 1) Create the builder ONCE with the provided builder options
    const builderRef = useRef<Builder>();
    const builderOptsRef = useRef<BuilderOptions | undefined>(builderOpts);

    if (!builderRef.current) {
        builderRef.current = createBuilder(builderOptsRef.current); // ← forwarded
        if (initialProps) {
            builderRef.current.load(initialProps);
        }
        ///@ts-ignore
    } else if (window.SITE?.env !== 'production') {
        // Warn if builderOpts identity changes after first mount (they won't be applied)
        if (builderOptsRef.current !== builderOpts) {
            // eslint-disable-next-line no-console
            console.warn('[useCanvasOwned] builderOpts changed after init; new values are ignored. ' +
                'If you need to recreate the builder, remount the hook (e.g. change a React key).');
            builderOptsRef.current = builderOpts;
        }
    }
    const builder = builderRef.current!;

    // 2) Stabilize canvas options to avoid churn re-instantiation of CanvasAPI
    const lastCanvasOptsRef = useRef<typeof canvasOpts>();
    const stableCanvasOpts = useMemo(() => {
        if (!lastCanvasOptsRef.current) {
            lastCanvasOptsRef.current = canvasOpts;
            return canvasOpts;
        }
        const a = canvasOpts ?? {};
        const b = lastCanvasOptsRef.current ?? {};
        const same =
            Object.keys({...a, ...b}).every(k => (a as any)[k] === (b as any)[k]);
        if (same) return lastCanvasOptsRef.current;
        lastCanvasOptsRef.current = canvasOpts;
        return canvasOpts;
    }, [canvasOpts]);

    // 3) Create CanvasAPI and dispose on change/unmount
    const api = useMemo(() => new CanvasAPI(builder, stableCanvasOpts), [builder, stableCanvasOpts]);

    useEffect(() => () => {
        api.dispose?.();
    }, [api]);

    return {api, builder};
}
```
---
`File: src/react/canvas/editor.ts`
```ts
import { cloneDeep } from "lodash-es";
import type { Builder } from "../../core";
import type { ServiceProps, Tag, Field } from "../../schema";
import { normalise } from "../../core";
import type { CanvasAPI } from "./api";
import type {
    Command,
    EditorEvents,
    EditorOptions,
    EditorSnapshot,
} from "../../schema/editor.types";
import { compilePolicies, PolicyDiagnostic } from "../../core/policy";
import { DynamicRule, FallbackSettings } from "../../schema/validation";
import { DgpServiceCapability, DgpServiceMap } from "../../schema/provider";
import { constraintFitOk, rateOk, toFiniteNumber } from "../../utils/util";

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
        const s = this.api.snapshot();
        return {
            props,
            canvas: {
                positions: cloneDeep(s.positions),
                viewport: { ...s.viewport },
                selection: new Set(s.selection),
            },
        };
    }

    private loadSnapshot(s: EditorSnapshot, reason: "undo" | "redo") {
        this.builder.load(cloneDeep(s.props));
        if (s.canvas) {
            this.api.setPositions(s.canvas.positions);
            this.api.setViewport(s.canvas.viewport);
            this.api.select(Array.from(s.canvas.selection ?? []));
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
```
---
`File: src/react/canvas/events.ts`
```ts
// Lightweight, typed event bus
export type EventMap = Record<string, unknown>;

export class EventBus<E extends EventMap> {
    private listeners = new Map<keyof E, Set<(p: any) => void>>();

    on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler as any);
        this.listeners.set(event, set);
        return () => {
            set.delete(handler as any);
        };
    }

    once<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
        const off = this.on(event, (p) => {
            off();
            handler(p);
        });
        return off;
    }

    emit<K extends keyof E>(event: K, payload: E[K]): void {
        const set = this.listeners.get(event);
        if (!set || set.size === 0) return;
        for (const h of Array.from(set)) try {
            (h as any)(payload);
        } catch { /* swallow */
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
```
---
`File: src/react/canvas/selection.ts`
```ts
// src/react/canvas/selection.ts
import type { Builder } from "../../core";
import type { ServiceProps, Tag, Field } from "../../schema";
import type { DgpServiceCapability } from "../../schema/provider";

export type Env = "client" | "workspace";

export type VisibleGroup = {
    tagId?: string;
    tag?: Tag;
    fields: Field[];
    fieldIds: string[];
    parentTags?: Tag[];
    childrenTags?: Tag[];
    /** In order of selection: tag base (unless overridden) then selected options */
    services?: DgpServiceCapability[];
};

// Returned by visibleGroup():
export type VisibleGroupResult =
    | { kind: "single"; group: VisibleGroup }
    | { kind: "multi"; groups: string[] };

type ChangeEvt = { ids: string[]; primary?: string };
type Listener = (e: ChangeEvt) => void;

const isTagId = (id: string) => typeof id === "string" && id.startsWith("t:");
const isOptionId = (id: string) =>
    typeof id === "string" && id.startsWith("o:");

export type SelectionOptions = {
    env?: Env;
    rootTagId?: string;
    /** Resolve service capability from an id (used for `services` array) */
    resolveService?: (id: any) => DgpServiceCapability | undefined;
};

export class Selection {
    private set = new Set<string>();
    private primaryId: string | undefined;
    private currentTagId: string | undefined;
    private onChangeFns: Listener[] = [];

    constructor(
        private readonly builder: Builder,
        private readonly opts: SelectionOptions = {},
    ) {}

    // ── Public mutators ──────────────────────────────────────────────────────
    replace(id?: string | null) {
        if (!id) return this.clear();
        this.set.clear();
        this.set.add(id);
        this.primaryId = id;
        this.updateCurrentTagFrom(id);
        this.emit();
    }

    add(id: string) {
        this.set.add(id);
        this.primaryId = id;
        this.updateCurrentTagFrom(id);
        this.emit();
    }

    remove(id: string) {
        if (!this.set.delete(id)) return;
        if (this.primaryId === id) {
            this.primaryId = this.set.values().next().value;
            if (this.primaryId) this.updateCurrentTagFrom(this.primaryId);
        }
        this.emit();
    }

    toggle(id: string) {
        if (this.set.has(id)) this.remove(id);
        else this.add(id);
    }

    many(ids: Iterable<string>, primary?: string) {
        this.set = new Set(ids);
        this.primaryId = primary ?? this.set.values().next().value;
        if (this.primaryId) this.updateCurrentTagFrom(this.primaryId);
        this.emit();
    }

    clear() {
        if (!this.set.size && !this.primaryId) return;
        this.set.clear();
        this.primaryId = undefined;
        this.emit();
    }

    // ── Read APIs ────────────────────────────────────────────────────────────
    all(): ReadonlySet<string> {
        return this.set;
    }

    has(id: string): boolean {
        return this.set.has(id);
    }

    primary(): string | undefined {
        return this.primaryId;
    }

    currentTag(): string | undefined {
        return this.currentTagId;
    }

    onChange(fn: Listener): () => void {
        this.onChangeFns.push(fn);
        return () => {
            const i = this.onChangeFns.indexOf(fn);
            if (i >= 0) this.onChangeFns.splice(i, 1);
        };
    }

    // ── Main: visible group snapshot (env-aware) ─────────────────────────────
    visibleGroup(): VisibleGroupResult {
        const props = this.builder.getProps() as ServiceProps;

        // WORKSPACE: >1 tag selected → return raw selection set
        if ((this.opts.env ?? "client") === "workspace") {
            const tagIds = Array.from(this.set).filter(isTagId);
            if (tagIds.length > 1) {
                return { kind: "multi", groups: Array.from(this.set) };
            }
        }

        const tagId = this.resolveTagContextId(props);
        if (!tagId)
            return { kind: "single", group: { fields: [], fieldIds: [] } };

        const group = this.computeGroupForTag(props, tagId);
        return { kind: "single", group };
    }

    // ── Internals ────────────────────────────────────────────────────────────
    private emit() {
        const payload: ChangeEvt = {
            ids: Array.from(this.set),
            primary: this.primaryId,
        };
        for (const fn of this.onChangeFns) fn(payload);
    }

    private updateCurrentTagFrom(id: string) {
        const props = this.builder.getProps() as ServiceProps;
        const tags = props.filters ?? [];
        const fields = props.fields ?? [];

        if (tags.some((t) => t.id === id)) {
            this.currentTagId = id;
            return;
        }
        const f = fields.find((x) => x.id === id);
        if (f?.bind_id) {
            this.currentTagId = Array.isArray(f.bind_id)
                ? f.bind_id[0]
                : f.bind_id;
            return;
        }

        if (isOptionId(id)) {
            const host = fields.find((x) =>
                (x.options ?? []).some((o) => o.id === id),
            );
            if (host?.bind_id) {
                this.currentTagId = Array.isArray(host.bind_id)
                    ? host.bind_id[0]
                    : host.bind_id;
                return;
            }
        }

        if (id.includes("::")) {
            const [fid] = id.split("::");
            const host = fields.find((x) => x.id === fid);
            if (host?.bind_id) {
                this.currentTagId = Array.isArray(host.bind_id)
                    ? host.bind_id[0]
                    : host.bind_id;
                return;
            }
        }
    }

    private resolveTagContextId(props: ServiceProps): string | undefined {
        if (this.currentTagId) return this.currentTagId;

        for (const id of this.set) if (isTagId(id)) return id;

        const fields = props.fields ?? [];
        for (const id of this.set) {
            const f = fields.find((x) => x.id === id);
            if (f?.bind_id)
                return Array.isArray(f.bind_id) ? f.bind_id[0] : f.bind_id;
        }

        for (const id of this.set) {
            if (isOptionId(id)) {
                const host = fields.find((x) =>
                    (x.options ?? []).some((o) => o.id === id),
                );
                if (host?.bind_id)
                    return Array.isArray(host.bind_id)
                        ? host.bind_id[0]
                        : host.bind_id;
            }
            if (id.includes("::")) {
                const [fid] = id.split("::");
                const host = fields.find((x) => x.id === fid);
                if (host?.bind_id)
                    return Array.isArray(host.bind_id)
                        ? host.bind_id[0]
                        : host.bind_id;
            }
        }

        return this.opts.rootTagId;
    }

    private computeGroupForTag(
        props: ServiceProps,
        tagId: string,
    ): VisibleGroup {
        const tags = props.filters ?? [];
        const fields = props.fields ?? [];
        const tagById = new Map(tags.map((t) => [t.id, t]));
        const tag = tagById.get(tagId);

        // selection-aware include/exclude via BUTTON TRIGGERS (options + button fields)
        const selectedTriggerIds = this.selectedButtonTriggerIds(props);
        const incMap = props.includes_for_buttons ?? {};
        const excMap = props.excludes_for_buttons ?? {};

        const trigInclude = new Set<string>();
        const trigExclude = new Set<string>();
        for (const triggerId of selectedTriggerIds) {
            for (const id of incMap[triggerId] ?? []) trigInclude.add(id);
            for (const id of excMap[triggerId] ?? []) trigExclude.add(id);
        }

        const tagInclude = new Set(tag?.includes ?? []);
        const tagExclude = new Set(tag?.excludes ?? []);

        // field pool
        const pool = new Map<string, Field>();
        for (const f of fields) {
            if (this.isBoundTo(f, tagId)) pool.set(f.id, f);
            if (tagInclude.has(f.id)) pool.set(f.id, f);
            if (trigInclude.has(f.id)) pool.set(f.id, f);
        }
        for (const id of tagExclude) pool.delete(id);
        for (const id of trigExclude) pool.delete(id);

        // optional order_for_tags
        const order = props.order_for_tags?.[tagId];
        const visible = order
            ? (
                  order.map((fid) => pool.get(fid)).filter(Boolean) as Field[]
              ).concat(
                  Array.from(pool.values()).filter(
                      (f) => !order.includes(f.id),
                  ),
              )
            : Array.from(pool.values());

        // ancestry & immediate children
        const parentTags: Tag[] = [];
        let cur = tag?.bind_id;
        const guard = new Set<string>();
        while (cur && !guard.has(cur)) {
            const t = tagById.get(cur);
            if (!t) break;
            parentTags.push(t);
            guard.add(cur);
            cur = t.bind_id;
        }
        const childrenTags = tags.filter((t) => t.bind_id === tagId);

        // services: tag base (unless overridden by base option) → selected options with service_id
        const services: DgpServiceCapability[] = [];
        const resolve = this.opts.resolveService;

        // 1) Start with tag base (if any)
        let baseAddedFromTag = false;
        if (tag?.service_id != null) {
            const cap =
                resolve?.(tag.service_id) ??
                ({ id: tag.service_id } as DgpServiceCapability);
            services.push(cap);
            baseAddedFromTag = true;
        }

        // 2) Walk selected ids in insertion order; if an OPTION maps to a service, add it.
        //    If the FIRST base-role option is encountered, it overrides the tag base (if any).
        let baseOverridden = false;
        for (const selId of this.set) {
            const opt = this.findOptionById(fields, selId);
            if (!opt || opt.service_id == null) continue;

            const role = (opt.pricing_role ?? (opt as any).role ?? "base") as
                | "base"
                | "utility"
                | "addon";
            const cap =
                resolve?.(opt.service_id) ??
                ({ id: opt.service_id } as DgpServiceCapability);

            if (role === "base") {
                if (!baseOverridden) {
                    if (baseAddedFromTag && services.length > 0) {
                        services[0] = cap; // override tag base
                    } else {
                        services.unshift(cap);
                    }
                    baseOverridden = true;
                } else {
                    // additional base entries (rare) — append after
                    services.push(cap);
                }
            } else {
                services.push(cap);
            }
        }

        return {
            tagId,
            tag,
            fields: visible,
            fieldIds: visible.map((f) => f.id),
            parentTags,
            childrenTags,
            services,
        };
    }

    private isBoundTo(f: Field, tagId: string): boolean {
        if (!f.bind_id) return false;
        return Array.isArray(f.bind_id)
            ? f.bind_id.includes(tagId)
            : f.bind_id === tagId;
    }

    /**
     * Return the selected "button trigger" ids that drive includes/excludes:
     *  - option ids (o:*)
     *  - field ids where field.button === true (option-less buttons)
     *  - legacy bridge for "fieldId::optionId"
     */
    private selectedButtonTriggerIds(props: ServiceProps): string[] {
        const out: string[] = [];
        const fields = props.fields ?? [];

        for (const id of this.set) {
            // option buttons
            if (isOptionId(id)) {
                out.push(id);
                continue;
            }

            // field-as-button (option-less buttons)
            const f = fields.find((x) => x.id === id);
            // guard via `as any` in case older builds don't have .button normalized yet
            if ((f as any)?.button === true) {
                out.push(id);
                continue;
            }

            // legacy bridge: "fieldId::optionId"
            if (id.includes("::")) {
                const [fid, legacyOid] = id.split("::");
                if (!fid || !legacyOid) continue;
                const host = fields.find((x) => x.id === fid);
                const global =
                    host?.options?.find((o) => o.id === legacyOid)?.id ??
                    legacyOid;
                out.push(global);
            }
        }
        return out;
    }

    private findOptionById(fields: Field[], selId: string) {
        if (isOptionId(selId)) {
            for (const f of fields) {
                const o = f.options?.find((x) => x.id === selId);
                if (o) return o;
            }
        }
        if (selId.includes("::")) {
            const [fid, oid] = selId.split("::");
            const f = fields.find((x) => x.id === fid);
            const o = f?.options?.find((x) => x.id === oid || x.id === selId);
            if (o) return o;
        }
        return undefined;
    }
}
```
---
`File: src/react/hooks/OrderFlowProvider.tsx`
```tsx
// src/react/hooks/OrderFlowProvider.tsx
import React, {
    useRef,
    useImperativeHandle,
    useEffect,
    useState,
    forwardRef,
    createContext,
    useContext,
    ReactNode,
    useMemo,
} from 'react';

import type {Builder} from '../../core';
import type {Selection} from '../canvas/selection';

import {InputsProvider} from '../inputs/InputsProvider';
import {InputRegistry as InputRegistryConfig} from '../inputs/InputRegistry';

import {FormProvider, useFormApi} from '../inputs/FormContext';
import type {Scalar} from '../../schema/order';

/* ───────────────────────── Types ───────────────────────── */

export type UseOrderFlowInit = {
    /** Seed form values keyed by fieldId (non-option inputs) */
    initialFormByFieldId?: Record<string, Scalar | Scalar[]>;
    /** (optional) seed selections by fieldId → optionIds[] */
    initialSelectionsByFieldId?: Record<string, string[]>;
};

export type OrderFlowProviderProps = {
    /** Bring your own flow (no internal Selection!) */
    flow: { builder: Builder; selection: Selection };
    /** Host input registry (maps kind/variant → components) */
    registry?: InputRegistryConfig;
    /** Optional init (form + selections seeding) */
    init?: UseOrderFlowInit;
    children?: ReactNode;
};

export type OrderFlowHandle = {
    /** Current active tag id (or undefined) */
    getActiveTag: () => string | undefined;
    /** Select a tag context (single-context) */
    selectTag: (tagId: string) => void;
    /** Latest visible-group result from Selection */
    getVisibleGroup: () => ReturnType<Selection['visibleGroup']>;
    /** Access to Form API (e.g., set/get values programmatically) */
    getFormApi: () => ReturnType<typeof useFormApi> | undefined;
    /** Raw selection ids */
    getSelectionIds: () => string[];
    /** Clear selection */
    clearSelection: () => void;
    /** Force refresh of internal activeTag tracker */
    refresh: () => void;
};

/* ───────────────────────── Context ───────────────────────── */

type CtxShape = {
    builder: Builder;
    selection: Selection;
    activeTagId?: string;
    setActiveTag: (id: string) => void;
};

const OrderFlowCtx = createContext<CtxShape | null>(null);

export function useOrderFlowContext(): CtxShape {
    const ctx = useContext(OrderFlowCtx);
    if (!ctx) throw new Error('useOrderFlowContext must be used within <OrderFlowProvider>');
    return ctx;
}

/* ───────────────────────── Internals ───────────────────────── */

/** Captures the FormApi from inside FormProvider (no extra props required). */
function CaptureFormApi({assign}: { assign: (api: ReturnType<typeof useFormApi>) => void }) {
    const api = useFormApi();
    useEffect(() => assign(api), [api, assign]);
    return null;
}

/* ───────────────────────── Component ───────────────────────── */

export const OrderFlowProvider = forwardRef<OrderFlowHandle, OrderFlowProviderProps>(function OrderFlowProvider(
    {flow, registry, init, children},
    ref
) {
    const {builder, selection} = flow;

    // Track current active tag from the provided Selection instance
    const [activeTagId, setActiveTagId] = useState<string | undefined>(() => selection.currentTag());
    useEffect(() => selection.onChange(() => setActiveTagId(selection.currentTag())), [selection]);

    const setActiveTag = (id: string) => {
        selection.replace(id);
        setActiveTagId(id);
    };

    // Imperative API: we store the FormApi ref captured from inside the FormProvider
    const formApiRef = useRef<ReturnType<typeof useFormApi>>();

    useImperativeHandle(
        ref,
        (): OrderFlowHandle => ({
            getActiveTag: () => activeTagId,
            selectTag: (id: string) => setActiveTag(id),
            getVisibleGroup: () => selection.visibleGroup(),
            getFormApi: () => formApiRef.current,
            getSelectionIds: () => Array.from(selection.all()),
            clearSelection: () => selection.clear(),
            refresh: () => setActiveTagId(selection.currentTag()),
        }),
        [activeTagId, selection]
    );

    // Build initial snapshot for FormProvider (values + selections)
    const initialFormValues = useMemo(
        () => init?.initialFormByFieldId ?? {},
        [init?.initialFormByFieldId]
    );
    const initialSelections = useMemo(
        () => init?.initialSelectionsByFieldId ?? {},
        [init?.initialSelectionsByFieldId]
    );

    return (
        <InputsProvider initialRegistry={registry}>
            <FormProvider initial={{values: initialFormValues, selections: initialSelections}}>
                {/* capture API once we are inside the provider */}
                <CaptureFormApi assign={(api) => {
                    formApiRef.current = api;
                }}/>
                <OrderFlowCtx.Provider value={{builder, selection, activeTagId, setActiveTag}}>
                    {children}
                </OrderFlowCtx.Provider>
            </FormProvider>
        </InputsProvider>
    );
});
```
---
`File: src/react/hooks/use-order-flow.ts`
```ts
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {Builder} from '../../core';
import type {ServiceProps, Field, Tag} from '../../schema';
import type {DgpServiceCapability, DgpServiceMap} from '../../schema/provider';
import type {OrderSnapshot, Scalar} from '../../schema/order';
import type {FallbackSettings} from '../../schema/validation';

import {Selection} from '../canvas/selection';
import {buildOrderSnapshot} from '../../utils/build-order-snapshot';
import {useOptionalFormApi} from '../inputs/FormContext';

/* ───────────────────────── public API ───────────────────────── */

export type UseOrderFlowInit = {
    mode?: 'prod' | 'dev';
    services: DgpServiceMap;
    fallback?: FallbackSettings;
    hydrateFrom?: OrderSnapshot;
    initialTagId?: string;
    hostDefaultQuantity?: number; // default 1
    resolveService?: (id: number | string) => DgpServiceCapability | undefined;
};

export type UseOrderFlowReturn = {
    activeTagId?: string;
    visibleFieldIds: string[];
    visibleFields: Field[];
    formValuesByFieldId: Record<string, Scalar | Scalar[]>;
    optionSelectionsByFieldId: Record<string, string[]>;
    quantityPreview: number;
    services: Array<string | number>;
    serviceMap: Record<string, Array<string | number>>;
    selectTag: (tagId: string) => void;
    toggleOption: (fieldId: string, optionId: string) => void;
    setValue: (fieldId: string, value: Scalar | Scalar[]) => void;
    clearField: (fieldId: string) => void;
    reset: () => void;
    buildSnapshot: () => OrderSnapshot;
    setFallbackPolicy: (next: FallbackSettings) => void;
};

/* ───────────────────────── implementation ───────────────────────── */

export function useOrderFlow(builder: Builder, init: UseOrderFlowInit): UseOrderFlowReturn {
    const mode: 'prod' | 'dev' = init.mode ?? 'prod';
    const hostDefaultQuantity: number = Number.isFinite(init.hostDefaultQuantity ?? 1)
        ? (init.hostDefaultQuantity as number)
        : 1;

    const propsRef = useRef<ServiceProps>(builder.getProps());
    useEffect(() => {
        propsRef.current = builder.getProps();
    });

    const [fallbackPolicy, setFallbackPolicy] = useState<FallbackSettings>(() => ({
        requireConstraintFit: true,
        ratePolicy: {kind: 'lte_primary'},
        selectionStrategy: 'priority',
        mode: mode === 'dev' ? 'dev' : 'strict',
        ...(init.fallback ?? {}),
    }));

    // Internal state (used only if no FormContext is present)
    const [formValuesByFieldId, setFormValuesByFieldId] = useState<Record<string, Scalar | Scalar[]>>({});
    const [optionSelectionsByFieldId, setOptionSelectionsByFieldId] = useState<Record<string, string[]>>({});

    // Optional Form Context (host-provided)
    const formApi = useOptionalFormApi();

    // Selection
    const selectionRef = useRef<Selection>();
    if (!selectionRef.current) {
        selectionRef.current = new Selection(builder, {
            env: 'client',
            rootTagId: 'root',
            resolveService: init.resolveService,
        });
    }
    const selection = selectionRef.current;

    // Default tag: hydrate → initial → root → first
    useEffect(() => {
        const props = propsRef.current;
        const tags = props.filters ?? [];

        const hydratedTag = init.hydrateFrom?.selection?.tag;
        const initialTag = init.hydrateFrom
            ? hydratedTag
            : (init.initialTagId ?? findDefaultTagId(tags));

        if (initialTag) {
            selection.replace(initialTag);
        } else if (tags.length) {
            selection.replace(tags[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Hydrate inputs (internal state only; FormContext has its own state)
    useEffect(() => {
        const snap = init.hydrateFrom;
        if (!snap) return;

        if (snap.inputs?.selections) setOptionSelectionsByFieldId(snap.inputs.selections);

        const byFieldId: Record<string, Scalar | Scalar[]> = {};
        if (snap.inputs?.form) {
            const fields = propsRef.current.fields ?? [];
            const nameToIds = new Map<string, string[]>();
            for (const f of fields) {
                if (!f.name) continue;
                const arr = nameToIds.get(f.name) ?? [];
                arr.push(f.id);
                nameToIds.set(f.name, arr);
            }
            for (const [name, value] of Object.entries(snap.inputs.form)) {
                for (const fid of (nameToIds.get(name) ?? [])) byFieldId[fid] = value as Scalar | Scalar[];
            }
        }
        setFormValuesByFieldId(byFieldId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track active tag
    const [activeTagId, setActiveTagId] = useState<string | undefined>(() => selection.currentTag());
    useEffect(() => {
        return selection.onChange(() => {
            setActiveTagId(selection.currentTag());
        });
    }, [selection]);

    // Selected option keys from internal state (used if no FormContext)
    const selectedOptionKeys: string[] = useMemo(() => {
        const keys: string[] = [];
        for (const [fid, oids] of Object.entries(optionSelectionsByFieldId)) {
            for (const oid of oids) keys.push(`${fid}::${oid}`);
        }
        return keys;
    }, [optionSelectionsByFieldId]);

    // Visible fields
    const {visibleFieldIds, visibleFields} = useMemo(() => {
        const tag = activeTagId;
        if (!tag) return {visibleFieldIds: [] as string[], visibleFields: [] as Field[]};

        const fallbackSelectionKeys = selectedOptionKeys;
        const ids = builder.visibleFields(tag, fallbackSelectionKeys);
        const byId = new Map((propsRef.current.fields ?? []).map(f => [f.id, f] as const));
        const fields = ids.map(id => byId.get(id)).filter((f): f is Field => !!f);
        return {visibleFieldIds: ids, visibleFields: fields};
    }, [builder, activeTagId, selectedOptionKeys]);

    // Merge values/selections: FormContext (if present) takes precedence for visible fields
    const effectiveMaps = useMemo(() => {
        const visible = new Set(visibleFieldIds);

        const fromFormValues: Record<string, Scalar | Scalar[]> = {};
        const fromFormSelections: Record<string, string[]> = {};

        if (formApi) {
            for (const fid of visible) {
                const v = formApi.get(fid);
                if (v !== undefined) fromFormValues[fid] = v;
                const sel = formApi.getSelections(fid);
                if (sel && sel.length) fromFormSelections[fid] = sel.slice();
            }
        }

        // fall back to internal state for fields that that are not present in formApi
        const mergedValues: Record<string, Scalar | Scalar[]> = {...formValuesByFieldId};
        for (const [fid, v] of Object.entries(fromFormValues)) mergedValues[fid] = v;

        const mergedSelections: Record<string, string[]> = {...optionSelectionsByFieldId};
        for (const [fid, arr] of Object.entries(fromFormSelections)) mergedSelections[fid] = arr;

        return {formValuesByFieldId: mergedValues, optionSelectionsByFieldId: mergedSelections};
    }, [formApi, formValuesByFieldId, optionSelectionsByFieldId, visibleFieldIds]);

    // Live preview snapshot (uses effectiveMaps)
    const previewSnapshot: OrderSnapshot = useMemo(() => {
        if (!activeTagId) {
            return {
                version: '1',
                mode,
                builtAt: new Date().toISOString(),
                selection: {tag: 'unknown', fields: []},
                inputs: {form: {}, selections: {}},
                quantity: Number(init.hostDefaultQuantity ?? 1) || 1,
                quantitySource: {kind: 'default', defaultedFromHost: true},
                services: [],
                serviceMap: {},
                meta: {
                    schema_version: propsRef.current.schema_version,
                    context: {
                        tag: 'unknown',
                        constraints: {},
                        nodeContexts: {},
                        policy: {ratePolicy: {kind: 'lte_primary'}, requireConstraintFit: true},
                    },
                },
            };
        }

        return buildOrderSnapshot(
            propsRef.current,
            builder,
            {
                activeTagId,
                formValuesByFieldId: effectiveMaps.formValuesByFieldId,
                optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
            },
            init.services,
            {
                mode,
                hostDefaultQuantity,
                fallback: fallbackPolicy,
            },
        );
    }, [activeTagId, builder, effectiveMaps.formValuesByFieldId, effectiveMaps.optionSelectionsByFieldId, fallbackPolicy, hostDefaultQuantity, init.services, mode]);

    /* ───────────────────────── mutators ───────────────────────── */

    const selectTag = useCallback((tagId: string) => {
        selection.replace(tagId);
    }, [selection]);

    const toggleOption = useCallback((fieldId: string, optionId: string) => {
        // If a FormContext exists, prefer using it; otherwise internal state
        if (formApi) {
            formApi.toggleSelection(fieldId, optionId);
            return;
        }
        setOptionSelectionsByFieldId(prev => {
            const cur = new Set(prev[fieldId] ?? []);
            if (cur.has(optionId)) cur.delete(optionId); else cur.add(optionId);
            return {...prev, [fieldId]: Array.from(cur)};
        });
    }, [formApi]);

    const setValue = useCallback((fieldId: string, value: Scalar | Scalar[]) => {
        if (formApi) {
            formApi.set(fieldId, value);
            return;
        }
        setFormValuesByFieldId(prev => ({...prev, [fieldId]: value}));
    }, [formApi]);

    const clearField = useCallback((fieldId: string) => {
        if (formApi) {
            formApi.set(fieldId, undefined as unknown as Scalar); // effectively clears
            formApi.setSelections(fieldId, []);
            return;
        }
        setFormValuesByFieldId(prev => {
            const next = {...prev};
            delete next[fieldId];
            return next;
        });
        setOptionSelectionsByFieldId(prev => {
            const next = {...prev};
            delete next[fieldId];
            return next;
        });
    }, [formApi]);

    const reset = useCallback(() => {
        const tags = propsRef.current.filters ?? [];
        const defaultTag = findDefaultTagId(tags) ?? tags[0]?.id;
        if (defaultTag) selection.replace(defaultTag);
        if (formApi) {
            // clear all known visible fields
            for (const fid of visibleFieldIds) {
                formApi.set(fid, undefined as unknown as Scalar);
                formApi.setSelections(fid, []);
            }
        } else {
            setFormValuesByFieldId({});
            setOptionSelectionsByFieldId({});
        }
    }, [formApi, selection, visibleFieldIds]);

    const buildSnapshot = useCallback((): OrderSnapshot => {
        const tagId = selection.currentTag();
        if (!tagId) throw new Error('OrderFlow: no active tag/context selected');

        return buildOrderSnapshot(
            propsRef.current,
            builder,
            {
                activeTagId: tagId,
                formValuesByFieldId: effectiveMaps.formValuesByFieldId,
                optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
            },
            init.services,
            {
                mode,
                hostDefaultQuantity,
                fallback: fallbackPolicy,
            },
        );
    }, [builder, effectiveMaps.formValuesByFieldId, effectiveMaps.optionSelectionsByFieldId, fallbackPolicy, hostDefaultQuantity, init.services, mode, selection]);

    /* ───────────────────────── return ───────────────────────── */

    return {
        activeTagId,
        visibleFieldIds,
        visibleFields,
        formValuesByFieldId: effectiveMaps.formValuesByFieldId,
        optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
        quantityPreview: previewSnapshot.quantity,
        services: previewSnapshot.services,
        serviceMap: previewSnapshot.serviceMap,

        selectTag,
        toggleOption,
        setValue,
        clearField,
        reset,

        buildSnapshot,
        setFallbackPolicy,
    };
}

/* ───────────────────────── helpers ───────────────────────── */

function findDefaultTagId(tags: Tag[]): string | undefined {
    if (!tags || !tags.length) return undefined;
    const hasRoot = tags.find(t => t.id === 'root');
    return hasRoot ? 'root' : tags[0].id;
}
```
---
`File: src/react/index.ts`
```ts
export * from '../schema/canvas-types';
export * from './canvas/events';
export * from './canvas/api';
export * from './canvas/context';
```
---
`File: src/react/inputs/FormContext.tsx`
```tsx
import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
} from "react";
import type { ReactNode } from "react";
import type { Scalar } from "../../schema/order";

export type FormSnapshot = {
    values: Record<string, Scalar | Scalar[]>;
    selections: Record<string, string[]>;
};

export type FormApi = {
    /** Scalar/array value by fieldId (non-option inputs) */
    get: (fieldId: string) => Scalar | Scalar[] | undefined;
    set: (fieldId: string, value: Scalar | Scalar[]) => void;

    /** Option selections by fieldId (array of optionIds) */
    getSelections: (fieldId: string) => string[];
    setSelections: (fieldId: string, optionIds: string[]) => void;
    toggleSelection: (fieldId: string, optionId: string) => void;

    /** Read-only snapshot for debugging */
    snapshot: () => FormSnapshot;

    /** Simple subscribe (re-render triggers) */
    subscribe: (fn: () => void) => () => void;
};

const FormCtx = createContext<FormApi | null>(null);

export function FormProvider({
    initial,
    children,
}: {
    initial?: Partial<FormSnapshot>;
    children: ReactNode;
}) {
    const [values, setValues] = useState<Record<string, Scalar | Scalar[]>>(
        initial?.values ?? {},
    );
    const [selections, setSelections] = useState<Record<string, string[]>>(
        initial?.selections ?? {},
    );
    const subsRef = useRef(new Set<() => void>());

    const publish = useCallback(() => {
        for (const fn of Array.from(subsRef.current)) {
            try {
                fn();
            } catch {
                /* noop */
            }
        }
    }, []);

    const api = useMemo<FormApi>(
        () => ({
            get: (fieldId) => values[fieldId],
            set: (fieldId, value) => {
                setValues((prev) => {
                    if (prev[fieldId] === value) return prev;
                    const next = { ...prev, [fieldId]: value };
                    return next;
                });
                publish();
            },

            getSelections: (fieldId) => selections[fieldId] ?? [],
            setSelections: (fieldId, optionIds) => {
                setSelections((prev) => {
                    const next = {
                        ...prev,
                        [fieldId]: Array.from(new Set(optionIds)),
                    };
                    return next;
                });
                publish();
            },
            toggleSelection: (fieldId, optionId) => {
                setSelections((prev) => {
                    const cur = new Set(prev[fieldId] ?? []);
                    if (cur.has(optionId)) cur.delete(optionId);
                    else cur.add(optionId);
                    return { ...prev, [fieldId]: Array.from(cur) };
                });
                publish();
            },

            snapshot: () => ({
                values: { ...values },
                selections: { ...selections },
            }),

            subscribe: (fn) => {
                subsRef.current.add(fn);
                return () => subsRef.current.delete(fn);
            },
        }),
        [publish, selections, values],
    );

    return <FormCtx.Provider value={api}>{children}</FormCtx.Provider>;
}

/** Strict hook (throws if no provider) */
export function useFormApi(): FormApi {
    const ctx = useContext(FormCtx);
    if (!ctx) throw new Error("useFormApi must be used within <FormProvider>");
    return ctx;
}

/** Optional hook (returns null if no provider) */
export function useOptionalFormApi(): FormApi | null {
    return useContext(FormCtx);
}

/** Field-scoped helpers */

export function useFormField(fieldId: string): {
    value: Scalar | Scalar[] | undefined;
    set: (value: Scalar | Scalar[]) => void;
} {
    const api = useFormApi();
    const value = api.get(fieldId);
    const set = (v: Scalar | Scalar[]) => api.set(fieldId, v);
    return { value, set };
}

export function useFormSelections(fieldId: string): {
    selected: string[];
    set: (optionIds: string[]) => void;
    toggle: (optionId: string) => void;
} {
    const api = useFormApi();
    return {
        selected: api.getSelections(fieldId),
        set: (arr: string[]) => api.setSelections(fieldId, arr),
        toggle: (oid: string) => api.toggleSelection(fieldId, oid),
    };
}
```
---
`File: src/react/inputs/InputRegistry.ts`
```ts
import type React from 'react';
import type {Scalar} from '../../schema/order';

/** Matches your InputWrapper’s expectations */
export type InputKind = string;               // e.g. "text", "number", "select", "custom:Rating"
export type InputVariant = 'default' | (string & {});

export type InputAdapter = {
    /** Prop name where the value goes on the host component (default: "value") */
    valueProp?: string;
    /** Prop name of the change handler on the host component (default: "onChange") */
    changeProp?: string;
    /**
     * Normalize the host's change payload into a Scalar | Scalar[] your form will store.
     * If omitted, `next as Scalar | Scalar[]` is used.
     */
    getValue?: (next: unknown, prev: unknown) => Scalar | Scalar[];
};

export type InputDescriptor = {
    Component: React.ComponentType<Record<string, unknown>>;
    adapter?: InputAdapter;
    defaultProps?: Record<string, unknown>;
};

type VariantMap = Map<InputVariant, InputDescriptor>;
type RegistryStore = Map<InputKind, VariantMap>;

export type InputRegistry = {
    get(kind: InputKind, variant?: InputVariant): InputDescriptor | undefined;
    register(kind: InputKind, descriptor: InputDescriptor, variant?: InputVariant): void;
    unregister(kind: InputKind, variant?: InputVariant): void;
    registerMany(entries: Array<{ kind: InputKind; descriptor: InputDescriptor; variant?: InputVariant }>): void;
    /** low-level escape hatch */
    _store: RegistryStore;
};

export function createInputRegistry(): InputRegistry {
    const store: RegistryStore = new Map();

    const get = (kind: InputKind, variant?: InputVariant): InputDescriptor | undefined => {
        const vm = store.get(kind);
        if (!vm) return undefined;
        const v = (variant ?? 'default') as InputVariant;
        return vm.get(v) ?? vm.get('default');
    };

    const register = (kind: InputKind, descriptor: InputDescriptor, variant?: InputVariant): void => {
        let vm = store.get(kind);
        if (!vm) {
            vm = new Map<InputVariant, InputDescriptor>();
            store.set(kind, vm);
        }
        vm.set((variant ?? 'default') as InputVariant, descriptor);
    };

    const unregister = (kind: InputKind, variant?: InputVariant): void => {
        const vm = store.get(kind);
        if (!vm) return;
        const key = (variant ?? 'default') as InputVariant;
        vm.delete(key);
        if (vm.size === 0) store.delete(kind);
    };

    const registerMany = (entries: Array<{ kind: InputKind; descriptor: InputDescriptor; variant?: InputVariant }>): void => {
        for (const e of entries) register(e.kind, e.descriptor, e.variant);
    };

    return { get, register, unregister, registerMany, _store: store };
}

/** Helper used by InputWrapper */
export function resolveInputDescriptor(
    registry: InputRegistry,
    kind: InputKind,
    variant?: InputVariant
): InputDescriptor | undefined {
    return registry.get(kind, variant);
}
```
---
`File: src/react/inputs/InputsProvider.tsx`
```tsx
import React, {createContext, useContext, useMemo} from 'react';
import type {ReactNode} from 'react';
import {createInputRegistry} from './InputRegistry';
import type {InputRegistry, InputDescriptor, InputKind, InputVariant} from './InputRegistry';

type InputsCtxValue = {
    registry: InputRegistry;
    register: (kind: InputKind, descriptor: InputDescriptor, variant?: InputVariant) => void;
    unregister: (kind: InputKind, variant?: InputVariant) => void;
    registerMany: (entries: Array<{ kind: InputKind; descriptor: InputDescriptor; variant?: InputVariant }>) => void;
};

const Ctx = createContext<InputsCtxValue | null>(null);

export function InputsProvider({
                                   children,
                                   initialRegistry,
                               }: {
    children: ReactNode;
    /** Optional pre-built registry (e.g., you registered built-ins/customs before mounting) */
    initialRegistry?: InputRegistry;
}) {
    const registry = useMemo(() => initialRegistry ?? createInputRegistry(), [initialRegistry]);

    const value = useMemo<InputsCtxValue>(() => ({
        registry,
        register: registry.register,
        unregister: registry.unregister,
        registerMany: registry.registerMany,
    }), [registry]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInputs(): InputsCtxValue {
    const v = useContext(Ctx);
    if (!v) throw new Error('useInputs() must be used within <InputsProvider>');
    return v;
}
```
---
`File: src/schema/canvas-types.ts`
```ts
import type {GraphSnapshot, GraphNode, GraphEdge, EdgeKind} from './graph';
import {CommentMessage, CommentThread} from "../react/canvas/comments";

export type Viewport = { x: number; y: number; zoom: number };

export type NodePos = { x: number; y: number };
export type NodePositions = Record<string, NodePos>;

export type DraftWire = { from: string; kind: EdgeKind };

export type CanvasState = {
    graph: GraphSnapshot;
    positions: NodePositions;
    selection: Set<string>;
    highlighted: Set<string>;
    hoverId?: string;
    viewport: Viewport;
    draftWire?: DraftWire;
    version: number; // bump on any state change
};

export type CanvasEvents = {
    'graph:update': GraphSnapshot;
    'state:change': CanvasState;
    'selection:change': { ids: string[] };
    'viewport:change': Viewport;
    'hover:change': { id?: string };
    'wire:preview': { from: string; to?: string; kind: EdgeKind };
    'wire:commit': { from: string; to: string; kind: EdgeKind };
    'wire:cancel': { from: string };
    'error': { message: string; code?: string; meta?: any };
    'comment:thread:create': { thread: CommentThread };
    'comment:thread:update': { thread: CommentThread };
    'comment:thread:delete': { threadId: string };
    'comment:message:create': { threadId: string; message: CommentMessage };
    'comment:resolve': { thread: CommentThread; resolved: boolean };
    'comment:move': { thread: CommentThread };
    'comment:select': { threadId?: string };
    'comment:sync': {
        op: 'create_thread' | 'add_message' | 'edit_message' | 'delete_message' | 'move_thread' | 'resolve_thread' | 'delete_thread';
        threadId: string;
        messageId?: string;
        status: 'scheduled' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';
        attempt: number;
        nextDelayMs?: number;
        error?: any;
    };
};

export type NodeView = GraphNode & { position?: NodePos };
export type EdgeView = GraphEdge;

export type CanvasOptions = {
    initialViewport?: Partial<Viewport>;
    autoEmitState?: boolean; // default true
};
```
---
`File: src/schema/editor.ts`
```ts
import type {ServiceProps} from './index';

export type CommentNode = {
    id: string;
    text: string;
    status: 'open' | 'resolved';
    anchor?: { kind: 'tag' | 'field' | 'option'; id: string };
    replies?: Array<{ id: string; text: string; created_at: string; author?: string }>;
    xy?: { x: number; y: number };
    meta?: Record<string, unknown>;
};

export type NodePosition = { id: string; x: number; y: number };
export type EdgeRoute = { id: string; points: Array<{ x: number; y: number }> };
export type LayoutState = { nodes: NodePosition[]; edges?: EdgeRoute[] };

export type EditorSnapshot = {
    props: ServiceProps;
    layout?: LayoutState;
    comments?: CommentNode[];
    meta?: Record<string, unknown>;
};
```
---
`File: src/schema/editor.types.ts`
```ts
import type {ServiceProps} from './index';

export type EditorEvents = {
    'editor:command': { name: string; payload?: any };
    'editor:change': { props: ServiceProps; reason: string; command?: string };
    'editor:undo': { stackSize: number; index: number };
    'editor:redo': { stackSize: number; index: number };
    'editor:error': { message: string; code?: string; meta?: any };
};

export type Command = {
    name: string;
    do(): void;
    undo(): void;
};

// wherever EditorOptions is declared
export type EditorOptions = {
    historyLimit?: number;
    validateAfterEach?: boolean;

    /** Sync existence check; return true if the service exists. */
    serviceExists?: (id: number) => boolean;

    /** Optional local index; used if serviceExists is not provided. */
    serviceMap?: Record<number, unknown>;

    /** Raw policies JSON; will be compiled on demand by filterServicesForVisibleGroup. */
    policiesRaw?: unknown;
};

export type ConnectKind = 'bind' | 'include' | 'exclude';
```
---
`File: src/schema/graph.ts`
```ts
export type NodeKind = "tag" | "field" | "comment" | "option";
export type EdgeKind =
    | "child"
    | "bind"
    | "include"
    | "exclude"
    | "error"
    | "anchor";

export type GraphNode = {
    id: string;
    kind: NodeKind;
    bind_type?: "bound" | "utility" | null; // for fields: bound vs unbound helper
    errors?: string[]; // node-local error codes
};

export type GraphEdge = {
    from: string;
    to: string;
    kind: EdgeKind;
    meta?: Record<string, unknown>;
};

export type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };
```
---
`File: src/schema/index.ts`
```ts
// persisted schema + shared types
export type PricingRole = "base" | "utility";
export type FieldType = "custom" | (string & {});

/** ── Marker types (live inside meta; non-breaking) ───────────────────── */
export type QuantityMark = {
    quantity?: {
        valueBy: "value" | "length" | "eval";
        code?: string;
        multiply?: number;
        clamp?: { min?: number; max?: number };
        fallback?: number;
    };
};

export type UtilityMark = {
    utility?: {
        rate: number;
        mode: "flat" | "per_quantity" | "per_value" | "percent";
        valueBy?: "value" | "length"; // only for per_value; default 'value'
        percentBase?: "service_total" | "base_service" | "all";
        label?: string;
    };
};

export type WithQuantityDefault = { quantityDefault?: number };

/** ---------------- Core schema (as you designed) ---------------- */

export interface BaseFieldUI {
    name?: string;
    label: string;
    required?: boolean;
    /** Host-defined prop names → typed UI nodes */
    ui?: Record<string, Ui>;
    /** Host-defined prop names → runtime default values (untyped base) */
    defaults?: Record<string, unknown>;
}

export type Ui = UiString | UiNumber | UiBoolean | UiAnyOf | UiArray | UiObject;

/** string */
export interface UiString {
    type: "string";
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
}

/** number */
export interface UiNumber {
    type: "number";
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
}

/** boolean */
export interface UiBoolean {
    type: "boolean";
}

/** enumerated choices */
export interface UiAnyOf {
    type: "anyOf";
    multiple?: boolean;
    items: Array<{
        type: "string" | "number" | "boolean";
        title?: string;
        description?: string;
        value: string | number | boolean;
    }>;
}

/** arrays: homogeneous (item) or tuple (items) */
export interface UiArray {
    type: "array";
    item?: Ui; // schema for each element (homogeneous)
    items?: Ui[]; // tuple form
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
}

/** objects: nested props */
export interface UiObject {
    type: "object";
    fields: Record<string, Ui>;
    required?: string[]; // nested required
    order?: string[]; // render hint
}

/** ---------------- Typed defaults helpers ---------------- */

/**
 * UiValue<U>: given a Ui node U, infer the runtime value type.
 */
export type UiValue<U extends Ui> =
    // primitives
    U extends { type: "string" }
        ? string
        : U extends { type: "number" }
          ? number
          : U extends { type: "boolean" }
            ? boolean
            : // anyOf
              U extends { type: "anyOf"; multiple: true }
              ? Array<U["items"][number]["value"]>
              : U extends { type: "anyOf" }
                ? U["items"][number]["value"]
                : // array (homogeneous vs tuple)
                  U extends { type: "array"; item: infer I extends Ui }
                  ? Array<UiValue<I>>
                  : U extends { type: "array"; items: infer T extends Ui[] }
                    ? { [K in keyof T]: UiValue<T[K]> }
                    : // object (nested fields)
                      U extends {
                            type: "object";
                            fields: infer F extends Record<string, Ui>;
                        }
                      ? { [K in keyof F]?: UiValue<F[K]> }
                      : unknown;

/**
 * FieldWithTypedDefaults<T>: same shape as BaseFieldUI, but:
 *  - ui is a concrete map T (propName → Ui node)
 *  - defaults are auto-typed from T via UiValue
 */
export type FieldWithTypedDefaults<T extends Record<string, Ui>> = Omit<
    BaseFieldUI,
    "ui" | "defaults"
> & {
    ui: T;
    defaults?: Partial<{ [K in keyof T]: UiValue<T[K]> }>;
};

export type FieldOption = {
    id: string;
    label: string;
    value?: string | number;
    service_id?: number;
    pricing_role?: PricingRole;
    meta?: Record<string, unknown> & UtilityMark & WithQuantityDefault;
};

export type Field = BaseFieldUI & {
    id: string;
    type: FieldType; // only 'custom' is reserved
    bind_id?: string | string[];
    name?: string; // omit if options map to services
    options?: FieldOption[];
    component?: string; // required if type === 'custom'
    pricing_role?: PricingRole; // default 'base'
    meta?: Record<string, unknown> & QuantityMark & UtilityMark;
} & (
        | {
              button?: false;
              service_id?: undefined;
          }
        | {
              button: true;
              service_id?: number;
          }
    );

export type FlagKey = "refill" | "cancel" | "dripfeed";
export type Tag = {
    id: string;
    label: string;
    bind_id?: string;
    service_id?: number;
    includes?: string[];
    excludes?: string[];
    meta?: Record<string, unknown> & WithQuantityDefault;
    /**
     * Which flags are set for this tag. If a flag is not set, it's inherited from the nearest ancestor with a value set.
     */
    constraints?: Partial<Record<FlagKey, boolean>>;
    /** Which ancestor defined the *effective* value for each flag (nearest source). */
    constraints_origin?: Partial<Record<FlagKey, string>>; // tagId

    /**
     * Present only when a child explicitly set a different value but was overridden
     * by an ancestor during normalisation.
     */
    constraints_overrides?: Partial<
        Record<
            FlagKey,
            { from: boolean; to: boolean; origin: string } // child explicit -> effective + where it came from
        >
    >;
};

export type ServiceProps = {
    order_for_tags?: Record<string, string[]>;
    filters: Tag[];
    fields: Field[];
    includes_for_buttons?: Record<string, string[]>;
    excludes_for_buttons?: Record<string, string[]>;
    schema_version?: string;
    fallbacks?: ServiceFallback;
};

// Ids
export type ServiceIdRef = number | string; // provider service id
export type NodeIdRef = string; // tag.id or option.id

export type ServiceFallback = {
    /** Node-scoped fallbacks: prefer these when that node’s primary service fails */
    nodes?: Record<NodeIdRef, ServiceIdRef[]>;
    /** Primary→fallback list used when no node-scoped entry is present */
    global?: Record<ServiceIdRef, ServiceIdRef[]>;
};
```
---
`File: src/schema/order.ts`
```ts
// src/schema/order.ts
import { UtilityMark, WithQuantityDefault } from "./index";

export interface ButtonValue {
    id: string; // option id OR field id (for option-less buttons)
    value: string | number; // host’s payload
    // Enrichment added by InputWrapper (not required from host):
    service_id?: number;
    pricing_role?: "base" | "utility";
    meta?: Record<string, unknown> & UtilityMark & WithQuantityDefault;
}
// Primitive values a client can send for form inputs and utility inputs.
export type Scalar = string | number | boolean | ButtonValue | null;

// How utility charges apply.
export type UtilityMode = "flat" | "per_quantity" | "per_value" | "percent";

// Quantity “marker” contract hosts can place under Field.meta.quantity.
export type QuantityRule = {
    valueBy: "value" | "length" | "eval";
    code?: string; // optional client-side evaluator (use with care / sandbox)
};

// One utility line item derived from a field/option marked as pricing_role: 'utility'.
export type UtilityLineItem = {
    nodeId: string; // fieldId or optionId that carries the utility marker
    mode: UtilityMode;
    rate: number; // finite number (validated)
    inputs: {
        quantity: number; // resolved snapshot quantity
        value?: Scalar | Scalar[]; // present for per_value modes (when applicable)
        valueBy?: "value" | "length" | "eval";
        evalCodeUsed?: boolean; // true if client executed an eval path
    };
};

// Fallbacks shape stored on ServiceProps (formalized).
export type ServiceFallbacks = {
    nodes?: Record<string, Array<string | number>>; // nodeId -> candidate service ids
    global?: Record<string | number, Array<string | number>>; // primary -> candidate service ids
};

// Dev-only diagnostics for pruned/flagged fallbacks.
export type FallbackDiagnostics = {
    scope: "node" | "global";
    nodeId?: string; // for scope:'node'
    primary: string | number;
    candidate: string | number;
    reasons: Array<
        | "rate_violation"
        | "constraint_mismatch"
        | "unknown_service"
        | "ambiguous_context"
    >;
};

// Single-tag evaluation context included in the snapshot meta.
export type SnapshotContext = {
    /** The single active tag id for this order */
    tag: string;

    /** Effective (post-propagation) constraints on that tag */
    constraints: Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>;

    /**
     * Per-node evaluation context:
     * - For the active tag node itself: the same tag id.
     * - For an option node: parent's field.bind_id must include this tag to be applicable; otherwise null.
     * - For a field node (optional to include later): same rule as option, derived from field.bind_id.
     */
    nodeContexts: Record<string /* nodeId */, string | null>;

    /** Client pruning policy used (so server can mirror/compare). */
    policy: {
        ratePolicy: { kind: "lte_primary" | "none"; thresholdPct?: number };
        requireConstraintFit: boolean; // node-level constraint enforcement on client
    };
};

// Stable order snapshot contract (client -> server).
export type OrderSnapshot = {
    version: "1";
    mode: "prod" | "dev";
    builtAt: string; // ISO timestamp

    // ── Single-context selection (the only active tag) ──
    selection: {
        tag: string; // tag id (context)
        fields: Array<{
            id: string; // field id
            type: string; // field.type at build time
            selectedOptions?: string[]; // option ids if option-based (always array if present)
        }>;
    };

    // ── Inputs for the backend ──
    inputs: {
        form: Record<string, Scalar | Scalar[]>; // name-keyed values for non-option fields
        selections: Record<string, string[]>; // fieldId -> option ids[]
    };

    // ── Resolved quantity (+ provenance) ──
    quantity: number;
    quantitySource: {
        kind: "field" | "tag" | "option" | "default";
        id?: string; // which field/tag/option provided it
        rule?: QuantityRule; // when kind === 'field'
        defaultedFromHost?: boolean; // true if host default used
    };

    // ── Selected primaries ──
    services: Array<string | number>; // deduped union of all primaries
    serviceMap: Record<string, Array<string | number>>; // nodeId -> primary ids[]

    // ── Client-pruned fallbacks (server will still do final pruning) ──
    fallbacks?: {
        nodes?: Record<string, Array<string | number>>; // only nodes present in this selection
        global?: Record<string | number, Array<string | number>>; // only primaries present in `services`
    };

    // ── Utility line items ──
    utilities?: UtilityLineItem[];

    // ── Dev-only warnings (safe to ignore server-side) ──
    warnings?: {
        utility?: Array<{ nodeId: string; reason: string }>;
        fallbacks?: FallbackDiagnostics[];
    };

    // ── Optional provenance and live context for server-side double-checks ──
    meta?: {
        schema_version?: string;
        workspaceId?: string;
        builder?: { commit?: string };
        context?: SnapshotContext;
    };
};
```
---
`File: src/schema/policies.ts`
```ts
// src/schema/policies.ts
import type { DynamicRule } from './validation';

/** Exported alias so the schema generator can target an array */
export type AdminPolicies = DynamicRule[];

// Re-export (optional convenience)
export type { DynamicRule };
```
---
`File: src/schema/provider.ts`
```ts
/** Minimal capability shape sourced from DgpService */
export type DgpServiceCapability = {
    id: number;
    name?: string;                    // human-friendly name
    key?: string;                     // provider key if relevant
    rate?: number;                    // canonical numeric rate
    min?: number;                     // min order qty
    max?: number;                     // max order qty
    dripfeed?: boolean;
    refill?: boolean;
    cancel?: boolean;
    estimate?: { start?: number | null; speed?: number | null; average?: number | null };
    meta?: Record<string, unknown>;
    [x: string]: any;
};

export type DgpServiceMap = Record<number, DgpServiceCapability>; // id -> capability
```
---
`File: src/schema/validation.ts`
```ts
import { DgpServiceMap } from "./provider";

export type ValidationCode =
    // structure
    | "root_missing"
    | "cycle_in_tags"
    | "bad_bind_reference"
    // identity & labels
    | "duplicate_id"
    | "duplicate_tag_label"
    | "duplicate_field_name"
    | "label_missing"
    // visibility & option maps
    | "duplicate_visible_label"
    | "bad_option_key"
    | "option_include_exclude_conflict"
    // service/input
    | "service_field_missing_service_id"
    | "user_input_field_has_service_option"
    // rates & pricing roles
    | "rate_mismatch_across_base"
    | "utility_without_base"
    // constraints
    | "unsupported_constraint"
    | "constraint_contradiction"
    // custom component
    | "custom_component_missing"
    | "policy_violation"
    | "field_unbound"
    | "constraint_overridden"
    | "unsupported_constraint_option" // option's service can't meet T's effective constraint
    | "custom_component_unresolvable"
    // utilities / quantity markers
    | "quantity_multiple_markers"
    | "utility_with_service_id"
    | "utility_missing_rate"
    | "utility_invalid_mode"
    // fallbacks
    | "fallback_bad_node"
    | "fallback_unknown_service"
    | "fallback_cycle"
    | "fallback_no_primary"
    | "fallback_rate_violation"
    | "fallback_constraint_mismatch"
    | "fallback_no_tag_context";

export type ValidationError = {
    code: ValidationCode;
    nodeId?: string; // tag/field/option id
    details?: Record<string, unknown>;
};

export type DynamicRule = {
    id: string;
    scope: "global" | "visible_group";
    subject: "services";
    filter?: {
        role?: "base" | "utility" | "both";
        handler_id?: number | number[];
        platform_id?: number | number[];
        tag_id?: string | string[];
        field_id?: string | string[];
    };
    projection?:
        | "service.type"
        | "service.key"
        | "service.rate"
        | "service.handler_id"
        | "service.platform_id"
        | "service.dripfeed"
        | string;
    op:
        | "all_equal"
        | "unique"
        | "no_mix"
        | "all_true"
        | "any_true"
        | "max_count"
        | "min_count";
    value?: number | boolean; // for max/min/all_true/any_true
    severity?: "error" | "warning";
    message?: string;
};

export type ValidatorOptions = {
    serviceMap?: DgpServiceMap;
    allowUnsafe?: boolean;
    selectedOptionKeys?: string[];
    globalUtilityGuard?: boolean;
    policies?: DynamicRule[]; // ← dynamic rules from super admin
    fallbackSettings?: FallbackSettings;
};

export type RatePolicy =
    | { kind: "lte_primary" }
    | { kind: "within_pct"; pct: number }
    | {
          kind: "at_least_pct_lower";
          pct: number;
      };

export type FallbackSettings = {
    /** Require fallbacks to satisfy tag constraints (dripfeed/refill/cancel) when a tag context is known. Default: true */
    requireConstraintFit?: boolean;
    /** Rate rule policy. Default: { kind: 'lte_primary' } i.e. candidate.rate <= primary.rate */
    ratePolicy?: RatePolicy;
    /** When multiple candidates remain, choose first (priority) or cheapest. Default: 'priority' */
    selectionStrategy?: "priority" | "cheapest";
    /** Validation mode: 'strict' → node-scoped violations reported as ValidationError; 'dev' → only collect diagnostics. Default: 'strict' */
    mode?: "strict" | "dev";
};
```
---
`File: src/utils/build-order-snapshot.ts`
```ts
// src/utils/build-order-snapshot.ts

import type {
    OrderSnapshot,
    Scalar,
    UtilityLineItem,
    UtilityMode,
    QuantityRule,
    FallbackDiagnostics,
    ServiceFallbacks,
} from "../schema/order";
import type { ServiceProps, Field, FieldOption, Tag } from "../schema";
import type { Builder } from "../core";
import type { DgpServiceMap } from "../schema/provider";
import { isMultiField } from "./index";
import type { PruneResult } from "./prune-fallbacks";
import { pruneInvalidNodeFallbacks } from "./prune-fallbacks";
import type { FallbackSettings } from "../schema/validation";
import { constraintFitOk, rateOk } from "./util";

/* ───────────────────────── Public types ───────────────────────── */

export type BuildOrderSnapshotSettings = {
    mode?: "prod" | "dev";
    hostDefaultQuantity?: number;
    /** Full fallback policy */
    fallback?: FallbackSettings;
    workspaceId?: string;
    builderCommit?: string;
};

export type BuildOrderSelection = {
    /** Single active context (one tag) coming from Selection */
    activeTagId: string;
    /** Non-option inputs, keyed by fieldId (will be remapped to field.name in the payload) */
    formValuesByFieldId: Record<string, Scalar | Scalar[]>;
    /** Option selections, keyed by fieldId → optionId[] */
    optionSelectionsByFieldId: Record<string, string[]>;
    /**
     * Selection visit order for options (optional, improves "first option wins primary" determinism).
     * If omitted, iteration order falls back to Object.entries(optionSelectionsByFieldId).
     */
    optionTraversalOrder?: Array<{ fieldId: string; optionId: string }>;
};

/* ───────────────────────── Entry point ───────────────────────── */

export function buildOrderSnapshot(
    props: ServiceProps,
    builder: Builder,
    selection: BuildOrderSelection,
    services: DgpServiceMap,
    settings: BuildOrderSnapshotSettings = {},
): OrderSnapshot {
    const mode: "prod" | "dev" = settings.mode ?? "prod";
    const hostDefaultQty: number = Number.isFinite(
        settings.hostDefaultQuantity ?? 1,
    )
        ? (settings.hostDefaultQuantity as number)
        : 1;

    // Default fallback policy (strict in prod; diagnostics in dev)
    const fbSettings: FallbackSettings = {
        requireConstraintFit: true,
        ratePolicy: { kind: "lte_primary" },
        selectionStrategy: "priority",
        mode: mode === "dev" ? "dev" : "strict",
        ...(settings.fallback ?? {}),
    };

    const builtAt: string = new Date().toISOString();
    const tagId: string = selection.activeTagId;

    // 1) Resolve visible fields for the single context
    const selectedOptionKeys: string[] = toSelectedOptionKeys(
        selection.optionSelectionsByFieldId,
    );
    const visibleFieldIds: string[] = builder.visibleFields(
        tagId,
        selectedOptionKeys,
    );

    // Indexes
    const tagById: Map<string, Tag> = new Map(
        (props.filters ?? []).map((t) => [t.id, t]),
    );
    const fieldById: Map<string, Field> = new Map(
        (props.fields ?? []).map((f) => [f.id, f]),
    );
    const tagConstraints:
        | Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>
        | undefined = tagById.get(tagId)?.constraints ?? undefined;

    // 2) Selection.fields (id, type, selectedOptions?)
    const selectionFields = visibleFieldIds
        .map((fid) => fieldById.get(fid))
        .filter((f): f is Field => !!f)
        .map((f) => {
            const optIds: string[] | undefined = isOptionBased(f)
                ? (selection.optionSelectionsByFieldId[f.id] ?? [])
                : undefined;
            return {
                id: f.id,
                type: String(f.type),
                ...(optIds && optIds.length ? { selectedOptions: optIds } : {}),
            };
        });

    // 3) Inputs (form by field.name, selections by fieldId)
    const { formValues, selections } = buildInputs(
        visibleFieldIds,
        fieldById,
        selection,
    );

    // 4) Quantity
    const qtyRes = resolveQuantity(
        visibleFieldIds,
        fieldById,
        selection,
        hostDefaultQty,
    );
    const quantity: number = qtyRes.quantity;
    const quantitySource = qtyRes.source;

    // 5) Services and serviceMap (UPDATED behavior: tag default is default; any option with service_id is included; first becomes primary)
    const { serviceMap, servicesList } = resolveServices(
        tagId,
        visibleFieldIds,
        selection,
        tagById,
        fieldById,
    );

    // 6) Fallbacks — client-side conservative prune (keeps only relevant-to-selection)
    const prunedFallbacks = pruneFallbacksConservative(
        props.fallbacks as unknown as ServiceFallbacks | undefined,
        { tagId, constraints: tagConstraints, serviceMap, servicesList },
        services,
        fbSettings,
    );

    // 7) Utilities — line items derived from utility fields/options
    const utilities = collectUtilityLineItems(
        visibleFieldIds,
        fieldById,
        selection,
        quantity,
    );

    // 8) Dev warnings (fallback diagnostics + form/utility hints)
    const warnings: OrderSnapshot["warnings"] | undefined =
        mode === "dev"
            ? buildDevWarnings(
                  props,
                  services,
                  tagId,
                  serviceMap,
                  prunedFallbacks.original,
                  prunedFallbacks.pruned,
                  fieldById,
                  visibleFieldIds,
                  selection,
              )
            : undefined;

    // 9) Meta.context (single-tag effective constraints + nodeContexts)
    const snapshotPolicy = toSnapshotPolicy(fbSettings);
    const meta = {
        schema_version: props.schema_version,
        workspaceId: settings.workspaceId,
        builder: settings.builderCommit
            ? { commit: settings.builderCommit }
            : undefined,
        context: {
            tag: tagId,
            constraints: (tagConstraints ?? {}) as Record<
                "refill" | "cancel" | "dripfeed",
                boolean | undefined
            >,
            nodeContexts: buildNodeContexts(
                tagId,
                visibleFieldIds,
                fieldById,
                selection,
            ),
            policy: snapshotPolicy,
        },
    };

    const snapshot: OrderSnapshot = {
        version: "1",
        mode,
        builtAt,
        selection: {
            tag: tagId,
            fields: selectionFields,
        },
        inputs: {
            form: formValues,
            selections,
        },
        quantity,
        quantitySource,
        services: servicesList,
        serviceMap,
        ...(prunedFallbacks.pruned
            ? { fallbacks: prunedFallbacks.pruned }
            : {}),
        ...(utilities.length ? { utilities } : {}),
        ...(warnings ? { warnings } : {}),
        meta,
    };

    return snapshot;
}

/* ───────────────────────── Helpers ───────────────────────── */

function isOptionBased(f: Field): boolean {
    const hasOptions: boolean =
        Array.isArray(f.options) && f.options.length > 0;
    return hasOptions || isMultiField(f);
}

function toSelectedOptionKeys(byField: Record<string, string[]>): string[] {
    const keys: string[] = [];
    for (const [fieldId, optionIds] of Object.entries(byField ?? {})) {
        for (const optId of optionIds ?? []) {
            keys.push(`${fieldId}::${optId}`);
        }
    }
    return keys;
}

function buildInputs(
    visibleFieldIds: string[],
    fieldById: Map<string, Field>,
    selection: BuildOrderSelection,
): {
    formValues: Record<string, Scalar | Scalar[]>;
    selections: Record<string, string[]>;
} {
    const formValues: Record<string, Scalar | Scalar[]> = {};
    const selections: Record<string, string[]> = {};

    for (const fid of visibleFieldIds) {
        const f: Field | undefined = fieldById.get(fid);
        if (!f) continue;

        const selOptIds: string[] | undefined =
            selection.optionSelectionsByFieldId[fid];
        if (selOptIds && selOptIds.length) {
            selections[fid] = [...selOptIds];
        }

        // Only non-option fields contribute to form values; key by field.name
        if (!isOptionBased(f)) {
            const name: string | undefined = f.name;
            const val: Scalar | Scalar[] | undefined =
                selection.formValuesByFieldId[fid];
            if (!name || val === undefined) continue;
            formValues[name] = val;
        }
    }

    return { formValues, selections };
}

/* ───────────────── Quantity ───────────────── */

function resolveQuantity(
    visibleFieldIds: string[],
    fieldById: Map<string, Field>,
    selection: BuildOrderSelection,
    hostDefault: number,
): { quantity: number; source: OrderSnapshot["quantitySource"] } {
    // Precedence:
    // 1) First visible field with a quantity rule -> evaluate
    // 2) (Future) tag/option defaults (not implemented yet)
    // 3) Host default
    for (const fid of visibleFieldIds) {
        const f: Field | undefined = fieldById.get(fid);
        if (!f) continue;
        const rule: QuantityRule | undefined = readQuantityRule(
            (f.meta as any)?.quantity,
        );
        if (!rule) continue;

        const raw: Scalar | Scalar[] | undefined =
            selection.formValuesByFieldId[fid];
        const evaluated = evaluateQuantityRule(rule, raw);
        if (Number.isFinite(evaluated) && (evaluated as number) > 0) {
            return {
                quantity: evaluated as number,
                source: { kind: "field", id: f.id, rule },
            };
        }
    }

    return {
        quantity: hostDefault,
        source: { kind: "default", defaultedFromHost: true },
    };
}

function readQuantityRule(v: unknown): QuantityRule | undefined {
    if (!v || typeof v !== "object") return undefined;
    const src = v as QuantityRule;
    if (
        src.valueBy !== "value" &&
        src.valueBy !== "length" &&
        src.valueBy !== "eval"
    )
        return undefined;
    const out: QuantityRule = { valueBy: src.valueBy };
    if (src.code && typeof src.code === "string") out.code = src.code;
    return out;
}

function evaluateQuantityRule(
    rule: QuantityRule,
    raw: Scalar | Scalar[] | undefined,
): number {
    switch (rule.valueBy) {
        case "value": {
            const n = Number(Array.isArray(raw) ? (raw as Scalar[])[0] : raw);
            return Number.isFinite(n) ? n : NaN;
        }
        case "length": {
            if (Array.isArray(raw)) return raw.length;
            if (typeof raw === "string") return raw.length;
            return NaN;
        }
        case "eval": {
            try {
                if (!rule.code || typeof rule.code !== "string") return NaN;
                // eslint-disable-next-line no-new-func
                const fn = new Function(
                    "value",
                    "values",
                    `return (function(){ ${rule.code}\n})()`,
                );
                const single = Array.isArray(raw) ? (raw as Scalar[])[0] : raw;
                const values = Array.isArray(raw)
                    ? (raw as Scalar[])
                    : raw !== undefined
                      ? [raw]
                      : [];
                const out = fn(single, values);
                const n = Number(out);
                return Number.isFinite(n) ? n : NaN;
            } catch {
                return NaN;
            }
        }
        default:
            return NaN;
    }
}

/* ───────────────── Services (UPDATED) ───────────────── */

function resolveServices(
    tagId: string,
    visibleFieldIds: string[],
    selection: BuildOrderSelection,
    tagById: Map<string, Tag>,
    fieldById: Map<string, Field>,
): {
    serviceMap: Record<string, Array<string | number>>;
    servicesList: Array<string | number>;
} {
    const serviceMap: Record<string, Array<string | number>> = {};
    const ordered: Array<string | number> = [];

    // 1) Tentative primary from tag default (if any) — default only.
    const tag = tagById.get(tagId);
    let primary: string | number | undefined;
    let primaryOrigin: "tag" | "option" | undefined;

    if (tag?.service_id !== undefined) {
        primary = tag.service_id;
        primaryOrigin = "tag";
        // We'll only record it in lists if it survives override.
    }

    // 2) Walk option selections in a deterministic order
    const optionVisit = buildOptionVisitOrder(selection, fieldById);

    for (const { fieldId, optionId } of optionVisit) {
        // only consider options whose field is visible in this group
        if (!visibleFieldIds.includes(fieldId)) continue;

        const f = fieldById.get(fieldId);
        if (!f || !Array.isArray(f.options)) continue;

        const opt = f.options.find((o) => o.id === optionId);
        if (!opt) continue;

        const role = (opt.pricing_role ?? "base") as
            | "base"
            | "utility"
            | string;
        const sid = opt.service_id;

        // Defensive: ignore if a (misconfigured) utility has service_id.
        if (role === "utility") continue;

        if (sid !== undefined) {
            // First option with service_id overrides tag default primary.
            if (primary === undefined || primaryOrigin === "tag") {
                primary = sid;
                primaryOrigin = "option";
                // Since primary owns index 0, push it first
                ordered.length = 0; // clear any tentative tag default
                ordered.push(primary);
            } else {
                // Additional option services append
                ordered.push(sid);
            }
            // Map origin node → sid
            pushService(serviceMap, optionId, sid);
        }
    }

    // 3) If no option established a primary, use tag default (if present)
    if (primaryOrigin !== "option" && primary !== undefined) {
        ordered.unshift(primary);
        pushService(serviceMap, tagId, primary);
    } else {
        // If overridden, we do NOT record tagId→default in serviceMap
    }

    const servicesList = dedupeByString(ordered);
    return { serviceMap, servicesList };
}

function buildOptionVisitOrder(
    selection: BuildOrderSelection,
    fieldById: Map<string, Field>,
): Array<{ fieldId: string; optionId: string }> {
    if (
        selection.optionTraversalOrder &&
        selection.optionTraversalOrder.length
    ) {
        return selection.optionTraversalOrder.slice();
    }
    // fallback: expand optionSelectionsByFieldId in insertion-ish order
    const out: Array<{ fieldId: string; optionId: string }> = [];
    for (const [fid, optIds] of Object.entries(
        selection.optionSelectionsByFieldId ?? {},
    )) {
        const f = fieldById.get(fid);
        if (!f) continue;
        for (const oid of optIds ?? [])
            out.push({ fieldId: fid, optionId: oid });
    }
    return out;
}

function pushService(
    map: Record<string, Array<string | number>>,
    nodeId: string,
    sid: string | number,
): void {
    if (!map[nodeId]) map[nodeId] = [];
    map[nodeId].push(sid);
}

function dedupeByString<T extends string | number>(arr: T[]): T[] {
    const s = new Set<string>();
    const out: T[] = [];
    for (const v of arr) {
        const key = String(v);
        if (s.has(key)) continue;
        s.add(key);
        out.push(v);
    }
    return out;
}

/* ───────────── Fallback pruning (client-conservative) ───────────── */

type PruneEnv = {
    tagId: string;
    constraints?: Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>;
    serviceMap: Record<string, Array<string | number>>;
    servicesList: Array<string | number>;
};

function pruneFallbacksConservative(
    fallbacks: ServiceFallbacks | undefined,
    env: PruneEnv,
    svcMap: DgpServiceMap,
    policy: FallbackSettings,
): { pruned?: ServiceFallbacks; original?: ServiceFallbacks } {
    if (!fallbacks) return { pruned: undefined, original: undefined };

    // Prefer shared helper (keeps behavior consistent with tests)
    try {
        const { props: prunedProps }: PruneResult = pruneInvalidNodeFallbacks(
            {
                filters: [],
                fields: [],
                schema_version: "1.0",
                fallbacks,
            } as unknown as ServiceProps,
            svcMap,
            policy,
        );
        return {
            pruned: prunedProps.fallbacks as unknown as
                | ServiceFallbacks
                | undefined,
            original: fallbacks,
        };
    } catch {
        // Minimal inline conservative prune (selection-aware)
        const out: ServiceFallbacks = {};
        const requireFit: boolean = policy.requireConstraintFit ?? true;

        // Nodes: keep only for nodes present in env.serviceMap; apply rate & (optional) constraints against tag
        if ((fallbacks as any).nodes) {
            const keptNodes: Record<string, Array<string | number>> = {};
            for (const [nodeId, candidates] of Object.entries(
                (fallbacks as any).nodes as Record<
                    string,
                    Array<string | number>
                >,
            )) {
                if (!env.serviceMap[nodeId]) continue;
                const primary = (env.serviceMap[nodeId] ?? [])[0];
                const kept: Array<string | number> = [];
                for (const cand of candidates ?? []) {
                    if (!rateOk(svcMap, cand, primary, policy)) continue;
                    if (
                        requireFit &&
                        env.constraints &&
                        !constraintFitOk(svcMap, cand, env.constraints)
                    )
                        continue;
                    kept.push(cand);
                }
                if (kept.length) keptNodes[nodeId] = kept;
            }
            if (Object.keys(keptNodes).length) (out as any).nodes = keptNodes;
        }

        // Global: keep only primaries that are present in selection; apply rate & (optional) constraints
        if ((fallbacks as any).global) {
            const keptGlobal: Record<
                string | number,
                Array<string | number>
            > = {};
            const present = new Set(env.servicesList.map((sid) => String(sid)));
            for (const [primary, cands] of Object.entries(
                (fallbacks as any).global as Record<
                    string | number,
                    Array<string | number>
                >,
            )) {
                if (!present.has(String(primary))) continue;
                const primId: string | number = isFiniteNumber(primary)
                    ? Number(primary)
                    : (primary as any);
                const kept: Array<string | number> = [];
                for (const cand of cands ?? []) {
                    if (!rateOk(svcMap, cand, primId, policy)) continue;
                    if (
                        requireFit &&
                        env.constraints &&
                        !constraintFitOk(svcMap, cand, env.constraints)
                    )
                        continue;
                    kept.push(cand);
                }
                if (kept.length) keptGlobal[primId] = kept;
            }
            if (Object.keys(keptGlobal).length)
                (out as any).global = keptGlobal;
        }

        return {
            pruned: Object.keys(out).length ? out : undefined,
            original: fallbacks,
        };
    }
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

/* ───────────────── Utilities collection ───────────────── */

type UtilityMarker = {
    mode: UtilityMode;
    rate: number;
    valueBy?: "value" | "length" | "eval";
    code?: string;
};

function collectUtilityLineItems(
    visibleFieldIds: string[],
    fieldById: Map<string, Field>,
    selection: BuildOrderSelection,
    quantity: number,
): UtilityLineItem[] {
    const items: UtilityLineItem[] = [];

    for (const fid of visibleFieldIds) {
        const f = fieldById.get(fid);
        if (!f) continue;

        const isUtilityField = (f.pricing_role ?? "base") === "utility";
        const marker = readUtilityMarker((f.meta as any)?.utility);

        // Field-based utility
        if (isUtilityField && marker) {
            const val: Scalar | Scalar[] | undefined =
                selection.formValuesByFieldId[f.id];
            const item = buildUtilityItemFromMarker(
                f.id,
                marker,
                quantity,
                val,
            );
            if (item) items.push(item);
        }

        // Option-based utility (only if selected)
        if (Array.isArray(f.options) && f.options.length) {
            const selectedOptIds =
                selection.optionSelectionsByFieldId[f.id] ?? [];
            if (selectedOptIds.length) {
                const optById = new Map<string, FieldOption>(
                    f.options.map((o) => [o.id, o]),
                );
                for (const oid of selectedOptIds) {
                    const opt = optById.get(oid);
                    if (!opt) continue;
                    if ((opt.pricing_role ?? "base") !== "utility") continue;
                    const om = readUtilityMarker((opt.meta as any)?.utility);
                    if (!om) continue;
                    // For per_value on options, we use the parent field's value as the base value
                    const parentVal: Scalar | Scalar[] | undefined =
                        selection.formValuesByFieldId[f.id];
                    const item = buildUtilityItemFromMarker(
                        opt.id,
                        om,
                        quantity,
                        parentVal,
                    );
                    if (item) items.push(item);
                }
            }
        }
    }

    return items;
}

function readUtilityMarker(v: unknown): UtilityMarker | undefined {
    if (!v || typeof v !== "object") return undefined;
    const src = v as UtilityMarker;
    if (!src.mode || typeof src.rate !== "number" || !Number.isFinite(src.rate))
        return undefined;
    if (
        src.mode !== "flat" &&
        src.mode !== "per_quantity" &&
        src.mode !== "per_value" &&
        src.mode !== "percent"
    )
        return undefined;
    const out: UtilityMarker = { mode: src.mode, rate: src.rate };
    if (
        src.valueBy === "value" ||
        src.valueBy === "length" ||
        src.valueBy === "eval"
    )
        out.valueBy = src.valueBy;
    if (src.code && typeof src.code === "string") out.code = src.code;
    return out;
}

function buildUtilityItemFromMarker(
    nodeId: string,
    marker: UtilityMarker,
    quantity: number,
    value: Scalar | Scalar[] | undefined,
): UtilityLineItem | undefined {
    const base: UtilityLineItem = {
        nodeId,
        mode: marker.mode,
        rate: marker.rate,
        inputs: { quantity },
    };
    if (marker.mode === "per_value") {
        base.inputs.valueBy = marker.valueBy ?? "value";
        if (marker.valueBy === "length") {
            base.inputs.value = Array.isArray(value)
                ? value.length
                : typeof value === "string"
                  ? value.length
                  : 0;
        } else if (marker.valueBy === "eval") {
            base.inputs.evalCodeUsed = true; // signal that client used eval
        } else {
            base.inputs.value = Array.isArray(value)
                ? (value[0] ?? null)
                : (value ?? null);
        }
    }
    return base;
}

/* ───────────────── meta.context helpers ──────────────── */

function buildNodeContexts(
    tagId: string,
    visibleFieldIds: string[],
    fieldById: Map<string, Field>,
    selection: BuildOrderSelection,
): Record<string, string | null> {
    const ctx: Record<string, string | null> = {};
    ctx[tagId] = tagId; // tag maps to itself

    for (const fid of visibleFieldIds) {
        const f = fieldById.get(fid);
        if (!f) continue;

        const binds = normalizeBindIds(f.bind_id);
        const applicable = binds.has(tagId);

        const selectedOptIds = selection.optionSelectionsByFieldId[fid] ?? [];
        for (const oid of selectedOptIds) {
            ctx[oid] = applicable ? tagId : null;
        }
    }

    return ctx;
}

function normalizeBindIds(bind: string | string[] | undefined): Set<string> {
    const out = new Set<string>();
    if (!bind) return out;
    if (Array.isArray(bind)) {
        for (const b of bind) if (b) out.add(String(b));
    } else {
        out.add(String(bind));
    }
    return out;
}

/* ───────────────── Dev warnings ───────────────── */

function buildDevWarnings(
    props: ServiceProps,
    svcMap: DgpServiceMap,
    _tagId: string,
    _snapshotServiceMap: Record<string, Array<string | number>>,
    originalFallbacks: ServiceFallbacks | undefined,
    _prunedFallbacks: ServiceFallbacks | undefined,
    fieldById: Map<string, Field>,
    visibleFieldIds: string[],
    selection: BuildOrderSelection,
): OrderSnapshot["warnings"] | undefined {
    const out: OrderSnapshot["warnings"] = {};

    // Fallback diagnostics (non-fatal). Call only if a global helper is present at runtime.
    const maybeCollectFailed:
        | ((
              p: ServiceProps,
              sm: DgpServiceMap,
              s: { mode: "dev" },
          ) => FallbackDiagnostics[])
        | undefined = (globalThis as any).collectFailedFallbacks;

    try {
        if (maybeCollectFailed && originalFallbacks) {
            const diags = maybeCollectFailed(
                {
                    ...props,
                    fallbacks: originalFallbacks,
                } as ServiceProps,
                svcMap,
                { mode: "dev" },
            );
            if (diags && diags.length) {
                out.fallbacks = diags;
            }
        }
    } catch {
        // ignore diagnostics failures in dev
    }

    // Utility/Form warnings: missing field.name while value present (only for non-option fields)
    const utilityWarnings: Array<{ nodeId: string; reason: string }> = [];
    for (const fid of visibleFieldIds) {
        const f = fieldById.get(fid);
        if (!f) continue;
        const hasVal = selection.formValuesByFieldId[fid] !== undefined;
        if (hasVal && !f.name && !isOptionBased(f)) {
            utilityWarnings.push({
                nodeId: fid,
                reason: "missing_field_name_for_form_value",
            });
        }
    }
    if (utilityWarnings.length) {
        (out as any).utility = utilityWarnings;
    }

    if (!(out as any).fallbacks && !(out as any).utility) return undefined;
    return out;
}

/* ───────────────── Mapping: internal settings → SnapshotContext.policy ───────────────── */

function toSnapshotPolicy(settings: FallbackSettings): {
    ratePolicy: { kind: "lte_primary" | "none"; thresholdPct?: number };
    requireConstraintFit: boolean;
} {
    const requireConstraintFit = settings.requireConstraintFit ?? true;
    const rp = settings.ratePolicy ?? { kind: "lte_primary" as const };

    // Map our richer rate policies to the wire-level policy your server expects
    switch (rp.kind) {
        case "lte_primary":
            return {
                ratePolicy: { kind: "lte_primary" },
                requireConstraintFit,
            };
        case "within_pct":
            return {
                ratePolicy: {
                    kind: "lte_primary",
                    thresholdPct: Math.max(0, rp.pct ?? 0),
                },
                requireConstraintFit,
            };
        case "at_least_pct_lower":
            // No direct encoding at wire-level; fall back to strict lte (server can still enforce stronger rule)
            return {
                ratePolicy: { kind: "lte_primary" },
                requireConstraintFit,
            };
        default:
            return {
                ratePolicy: { kind: "lte_primary" },
                requireConstraintFit,
            };
    }
}
```
---
`File: src/utils/index.ts`
```ts
import {Field} from "../schema";

/**
 * Heuristic: multi-select if type hints ('multiselect'|'checkbox') or meta.multi === true.
 * Hosts can rely on meta.multi if using custom type strings.
 */
export function isMultiField(f: Field): boolean {
    const t = (f.type || '').toLowerCase();
    const metaMulti = !!f.meta?.multi;
    return t === 'multiselect' || t === 'checkbox' || metaMulti;
}
```
---
`File: src/utils/prune-fallbacks.ts`
```ts
// src/utils/prune-fallbacks.ts
import type { ServiceProps, ServiceIdRef } from '../schema';
import type { DgpServiceMap } from '../schema/provider';
import type { FallbackSettings } from '../schema/validation';
import { collectFailedFallbacks } from '../core';

export type PrunedFallback = {
    nodeId: string;
    candidate: ServiceIdRef;
    reasons: string[];        // aggregated reasons that caused full-context failure
    contexts?: string[];      // tag contexts considered (for option nodes)
};

export type PruneResult = {
    props: ServiceProps;
    removed: PrunedFallback[];
};

/**
 * Remove node-scoped fallback candidates that fail in ALL relevant contexts.
 * - Tag node: single context (the tag itself)
 * - Option node: contexts = parent field's bind_id tags
 * - Global fallbacks are NEVER pruned here (soft by design)
 */
export function pruneInvalidNodeFallbacks(
    props: ServiceProps,
    services: DgpServiceMap,
    settings?: FallbackSettings
): PruneResult {
    const fb = props.fallbacks;
    if (!fb?.nodes || Object.keys(fb.nodes).length === 0) {
        return { props, removed: [] };
    }

    // 1) Build node → contexts (tag ids) and primary lookup
    const nodeContexts = new Map<string, string[]>();
    const nodePrimary = new Map<string, ServiceIdRef | undefined>();

    for (const nodeId of Object.keys(fb.nodes)) {
        const tag = props.filters.find(t => t.id === nodeId);
        if (tag) {
            nodeContexts.set(nodeId, [tag.id]);
            nodePrimary.set(nodeId, tag.service_id as any);
            continue;
        }
        // option node: locate parent field
        const field = props.fields.find(f => Array.isArray(f.options) && f.options.some(o => o.id === nodeId));
        if (field) {
            const contexts = toBindArray(field.bind_id);
            nodeContexts.set(nodeId, contexts);
            const opt = field.options!.find(o => o.id === nodeId)!;
            nodePrimary.set(nodeId, opt.service_id as any);
            continue;
        }
        // unknown node id → treat as no contexts & no primary
        nodeContexts.set(nodeId, []);
        nodePrimary.set(nodeId, undefined);
    }

    // 2) Gather diagnostics (per context). We use dev mode collection to get granular reasons.
    const diags = collectFailedFallbacks(props, services, { ...settings, mode: 'dev' });

    // 3) Decide which (nodeId, candidate) pairs fail in ALL contexts
    const failuresByPair = new Map<string, { reasons: Set<string>; contexts: Set<string> }>();
    const totalContextsByNode = new Map<string, number>();

    for (const [nodeId, ctxs] of nodeContexts.entries()) {
        totalContextsByNode.set(nodeId, Math.max(1, ctxs.length)); // at least 1 for tag/no-context cases
    }

    for (const d of diags) {
        if (d.scope !== 'node') continue;
        const key = `${d.nodeId}::${String(d.candidate)}`;
        let rec = failuresByPair.get(key);
        if (!rec) {
            rec = { reasons: new Set<string>(), contexts: new Set<string>() };
            failuresByPair.set(key, rec);
        }
        rec.reasons.add(d.reason);
        if (d.tagContext) rec.contexts.add(d.tagContext);
        // For node-level reasons not tied to a context, mark all contexts as failed by leaving contexts set empty;
        // we'll interpret empty-but-has-reasons as global failure later when totals == 1.
    }

    // 4) Build a pruned copy of fallbacks.nodes
    const prunedNodes: Record<string, ServiceIdRef[]> = {};
    const removed: PrunedFallback[] = [];

    for (const [nodeId, list] of Object.entries(fb.nodes)) {
        const contexts = nodeContexts.get(nodeId) ?? [];
        const totalContexts = Math.max(1, contexts.length);
        const keep: ServiceIdRef[] = [];

        for (const cand of list) {
            const key = `${nodeId}::${String(cand)}`;
            const rec = failuresByPair.get(key);

            // Not present in failures → keep
            if (!rec) {
                keep.push(cand);
                continue;
            }

            const failedContextsCount = rec.contexts.size > 0 ? rec.contexts.size : totalContexts;
            const failsAll = failedContextsCount >= totalContexts;

            if (failsAll) {
                removed.push({
                    nodeId,
                    candidate: cand,
                    reasons: Array.from(rec.reasons),
                    contexts: contexts.length ? contexts.slice() : undefined,
                });
            } else {
                keep.push(cand); // passes in at least one context
            }
        }

        if (keep.length) prunedNodes[nodeId] = keep;
    }

    const outProps: ServiceProps = {
        ...props,
        fallbacks: {
            ...(props.fallbacks?.global ? { global: props.fallbacks!.global } : {}),
            ...(Object.keys(prunedNodes).length ? { nodes: prunedNodes } : {}),
        }
    };

    return { props: outProps, removed };
}

/* ───────────────────────── helpers ───────────────────────── */

function toBindArray(bind: string | string[] | undefined): string[] {
    if (!bind) return [];
    return Array.isArray(bind) ? bind.slice() : [bind];
}
```
---
`File: src/utils/retry-queue.ts`
```ts
// noinspection JSIgnoredPromiseFromCall

export type RetryStatus = 'scheduled' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

export type RetryOptions = {
    enabled?: boolean;          // default true
    maxAttempts?: number;       // default 5
    baseDelayMs?: number;       // default 800
    maxDelayMs?: number;        // default 20_000
    jitter?: boolean;           // default true
    /** Run the first attempt immediately (no initial delay) */
    immediateFirst?: boolean;
};

export type RetryJob = {
    /** Stable id for de-duplication (e.g., "comments:create_thread:loc_abc") */
    id: string;
    /** Called on each attempt; return true to signal success, false/throw to retry */
    perform: (attempt: number) => Promise<boolean>;
    onStatus?: (status: RetryStatus, meta?: { attempt: number; nextDelayMs?: number; error?: unknown }) => void;
};

export class RetryQueue {
    private readonly opts: Required<RetryOptions>;
    private jobs = new Map<string, { job: RetryJob; attempt: number; timer?: any; cancelled?: boolean }>();
    private paused = false;

    constructor(opts: RetryOptions = {}) {
        this.opts = {
            enabled: opts.enabled ?? true,
            maxAttempts: opts.maxAttempts ?? 5,
            baseDelayMs: opts.baseDelayMs ?? 800,
            maxDelayMs: opts.maxDelayMs ?? 20_000,
            jitter: opts.jitter ?? true,
            immediateFirst: opts.immediateFirst ?? false,
        };
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.flush();
    }

    /** Enqueue or no-op if a job with same id already exists */
    enqueue(job: RetryJob): boolean {
        if (!this.opts.enabled) return false;
        if (this.jobs.has(job.id)) return false;
        this.jobs.set(job.id, {job, attempt: 0});
        job.onStatus?.('scheduled', {attempt: 0});
        this.kick(job.id);
        return true;
    }

    /** Force retry now (resets backoff); returns false if not found */
    triggerNow(id: string): boolean {
        const rec = this.jobs.get(id);
        if (!rec) return false;
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = undefined;
        this.kick(id, true);
        return true;
    }

    cancel(id: string): boolean {
        const rec = this.jobs.get(id);
        if (!rec) return false;
        if (rec.timer) clearTimeout(rec.timer);
        rec.cancelled = true;
        rec.job.onStatus?.('cancelled', {attempt: rec.attempt});
        this.jobs.delete(id);
        return true;
    }

    pendingIds(): string[] {
        return Array.from(this.jobs.keys());
    }

    size(): number {
        return this.jobs.size;
    }

    isQueued(id: string): boolean {
        return this.jobs.has(id);
    }

    drain(): void {
        for (const [id, rec] of this.jobs.entries()) {
            if (rec.timer) clearTimeout(rec.timer);
            rec.cancelled = true;
            rec.job.onStatus?.('cancelled', {attempt: rec.attempt});
            this.jobs.delete(id);
        }
    }

    private flush() {
        for (const id of this.jobs.keys()) this.kick(id);
    }

    private delayFor(attempt: number): number {
        const {baseDelayMs, maxDelayMs, jitter} = this.opts;
        const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
        if (!jitter) return exp;
        const r = Math.random() * 0.4 + 0.8; // 0.8x .. 1.2x
        return Math.min(maxDelayMs, Math.floor(exp * r));
    }

    private async kick(id: string, immediate = false) {
        const rec = this.jobs.get(id);
        if (!rec || rec.cancelled) return;

        if (this.paused && !immediate) return;

        const attempt = rec.attempt + 1;
        const run = async () => {
            if (rec.cancelled) return;
            rec.job.onStatus?.('retrying', {attempt});
            try {
                const ok = await rec.job.perform(attempt);
                if (ok) {
                    rec.job.onStatus?.('succeeded', {attempt});
                    this.jobs.delete(id);
                    return;
                }
            } catch (err) {
                // fallthrough to schedule next
                rec.job.onStatus?.('failed', {attempt, error: err});
            }

            if (attempt >= this.opts.maxAttempts) {
                rec.job.onStatus?.('failed', {attempt});
                this.jobs.delete(id);
                return;
            }

            rec.attempt = attempt;
            const delay = this.delayFor(attempt);
            rec.job.onStatus?.('scheduled', {attempt, nextDelayMs: delay});
            rec.timer = setTimeout(() => this.kick(id), delay);
        };

        if (immediate) await run();
        else {
            // First attempt: respect immediateFirst option; otherwise, schedule immediately
            const delay = this.opts.immediateFirst && attempt === 1 ? 0 : this.delayFor(attempt);

            if (delay) {
                rec.job.onStatus?.('scheduled', {attempt: 0, nextDelayMs: delay});
                rec.timer = setTimeout(run, delay);
            } else {
                void run();
            }
        }
    }
}
```
---
`File: src/utils/util.ts`
```ts
import type { DgpServiceMap, DgpServiceCapability } from "../schema/provider";
import type { FallbackSettings } from "../schema/validation";

/**
 * Safely convert unknown to a finite number. Returns NaN if not finite.
 */
export function toFiniteNumber(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Check if a candidate service satisfies the active tag constraints.
 * Only flags explicitly set to true are treated as required.
 */
export function constraintFitOk(
    svcMap: DgpServiceMap,
    candidate: string | number,
    constraints: Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>,
): boolean {
    const cap: DgpServiceCapability | undefined = svcMap[Number(candidate)];
    if (!cap) return false;

    if (constraints.dripfeed === true && !cap.dripfeed) return false;
    if (constraints.refill === true && !cap.refill) return false;
    return !(constraints.cancel === true && !cap.cancel);

}

/**
 * Evaluate candidate rate against primary according to the fallback rate policy.
 * If either service is missing or rates are not finite, returns false.
 */
export function rateOk(
    svcMap: DgpServiceMap,
    candidate: string | number,
    primary: string | number,
    policy: FallbackSettings,
): boolean {
    const cand = svcMap[Number(candidate)];
    const prim = svcMap[Number(primary)];
    if (!cand || !prim) return false;

    const cRate = toFiniteNumber(cand.rate);
    const pRate = toFiniteNumber(prim.rate);
    if (!Number.isFinite(cRate) || !Number.isFinite(pRate)) return false;

    const rp = policy.ratePolicy ?? { kind: "lte_primary" as const };
    switch (rp.kind) {
        case "lte_primary":
            return cRate <= pRate;
        case "within_pct": {
            const pct = Math.max(0, rp.pct ?? 0);
            return cRate <= pRate * (1 + pct / 100);
        }
        case "at_least_pct_lower": {
            const pct = Math.max(0, rp.pct ?? 0);
            return cRate <= pRate * (1 - pct / 100);
        }
        default:
            return false;
    }
}
```