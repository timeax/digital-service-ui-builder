// src/core/builder.ts
import {normalise} from './normalise';
import {validate} from './validate';

import type {
    ServiceProps,
    Tag,
    Field,
} from '../schema';
import type {
    GraphNode,
    GraphEdge,
    GraphSnapshot,
    NodeKind,
    EdgeKind,
} from '../schema/graph';
import type {
    DgpServiceMap,
} from '../schema/provider';
import type {
    ValidationError,
    ValidatorOptions,
} from '../schema/validation';

/** Options you can set on the builder (used for validation/visibility) */
export type BuilderOptions = Omit<ValidatorOptions, 'serviceMap'> & {
    serviceMap?: DgpServiceMap;
    /** max history entries for undo/redo */
    historyLimit?: number;
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
     */
    visibleFields(tagId: string, selectedOptionKeys?: string[]): string[];

    /** Update builder options (validator context etc.) */
    setOptions(patch: Partial<BuilderOptions>): void;

    /** History */
    undo(): boolean;

    redo(): boolean;

    /** Access the current props (already normalised) */
    getProps(): ServiceProps;

    /*  */
    getServiceMap(): DgpServiceMap
}

export function createBuilder(opts: BuilderOptions = {}): Builder {
    return new BuilderImpl(opts);
}

/* ────────────────────────────────────────────────────────────────────────── */

class BuilderImpl implements Builder {
    private props: ServiceProps = {filters: [], fields: [], schema_version: '1.0'};
    private tagById = new Map<string, Tag>();
    private fieldById = new Map<string, Field>();

    private options: BuilderOptions;
    private readonly history: ServiceProps[] = [];
    private readonly future: ServiceProps[] = [];
    private readonly historyLimit: number;

    constructor(opts: BuilderOptions = {}) {
        this.options = {...opts};
        this.historyLimit = opts.historyLimit ?? 50;
    }

    /* ───── lifecycle ─────────────────────────────────────────────────────── */

    load(raw: ServiceProps): void {
        const next = normalise(raw, {defaultPricingRole: 'base'});
        this.pushHistory(this.props);
        this.future.length = 0; // clear redo stack
        this.props = next;
        this.rebuildIndexes();
    }

    getProps(): ServiceProps {
        return this.props;
    }

    setOptions(patch: Partial<BuilderOptions>): void {
        this.options = {...this.options, ...patch};
    }

    getServiceMap(): DgpServiceMap {
        return this.options.serviceMap ?? {};
    }

    /* ───── querying ─────────────────────────────────────────────────────── */

    tree(): GraphSnapshot {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        // nodes: tags
        for (const t of this.props.filters) {
            nodes.push({
                id: t.id,
                kind: 'tag' as NodeKind,
            });
        }

        // tag hierarchy edges
        for (const t of this.props.filters) {
            if (t.bind_id) {
                edges.push({from: t.bind_id, to: t.id, kind: 'child' as EdgeKind});
            }
        }

        // nodes: fields
        for (const f of this.props.fields) {
            nodes.push({
                id: f.id,
                kind: 'field' as NodeKind,
                bind_type: f.pricing_role === 'utility' ? 'utility' : (f.bind_id ? 'bound' : null),
            });
        }

        // field binds
        for (const f of this.props.fields) {
            const b = f.bind_id;
            if (Array.isArray(b)) {
                for (const tagId of b) {
                    edges.push({from: tagId, to: f.id, kind: 'bind' as EdgeKind});
                }
            } else if (typeof b === 'string') {
                edges.push({from: b, to: f.id, kind: 'bind' as EdgeKind});
            }
        }

        // tag includes/excludes
        for (const t of this.props.filters) {
            for (const id of t.includes ?? []) {
                edges.push({from: t.id, to: id, kind: 'include' as EdgeKind});
            }
            for (const id of t.excludes ?? []) {
                edges.push({from: t.id, to: id, kind: 'exclude' as EdgeKind});
            }
        }

        return {nodes, edges};
    }

    cleanedProps(): ServiceProps {
        // 1) drop utility fields that are truly "unbound" and never included anywhere
        const includedByTag = new Set<string>();
        const includedByOption = new Set<string>();
        const referencedInOptionMaps = new Set<string>();
        const excludedAnywhere = new Set<string>();

        for (const t of this.props.filters) {
            for (const id of t.includes ?? []) includedByTag.add(id);
            for (const id of t.excludes ?? []) excludedAnywhere.add(id);
        }

        const incMap = this.props.includes_for_options ?? {};
        const excMap = this.props.excludes_for_options ?? {};
        for (const [k, arr] of Object.entries(incMap)) {
            for (const id of arr) {
                includedByOption.add(id);
                referencedInOptionMaps.add(id);
            }
            // record source field too (fieldId part)
            const fieldId = k.split('::')[0];
            if (fieldId) referencedInOptionMaps.add(fieldId);
        }
        for (const [k, arr] of Object.entries(excMap)) {
            for (const id of arr) {
                excludedAnywhere.add(id);
                referencedInOptionMaps.add(id);
            }
            const fieldId = k.split('::')[0];
            if (fieldId) referencedInOptionMaps.add(fieldId);
        }

        const boundIds = new Set<string>();
        for (const f of this.props.fields) {
            const b = f.bind_id;
            if (Array.isArray(b)) b.forEach(id => boundIds.add(id));
            else if (typeof b === 'string') boundIds.add(b);
        }

        const fields = this.props.fields.filter(f => {
            const isUtility = (f.pricing_role ?? 'base') === 'utility';
            if (!isUtility) return true;

            const bound = !!f.bind_id;
            const included = includedByTag.has(f.id) || includedByOption.has(f.id);
            const referenced = referencedInOptionMaps.has(f.id);
            const excluded = excludedAnywhere.has(f.id);

            // keep if bound OR included OR referenced by option maps (someone may pull it in)
            // drop if it's truly orphaned (unbound + not included + not referenced), or explicitly excluded everywhere
            return bound || included || referenced || !excluded;
        });

        // 2) prune option map keys/values pointing to missing fields
        const fieldIdSet = new Set(fields.map(f => f.id));
        const includes_for_options = pruneStringArrayMap(this.props.includes_for_options, fieldIdSet);
        const excludes_for_options = pruneStringArrayMap(this.props.excludes_for_options, fieldIdSet);

        // 3) return canonical object
        const out: ServiceProps = {
            filters: this.props.filters.slice(),
            fields,
            ...(includes_for_options && {includes_for_options}),
            ...(excludes_for_options && {excludes_for_options}),
            schema_version: this.props.schema_version ?? '1.0',
        };
        return out;
    }

    errors(): ValidationError[] {
        return validate(this.props, this.options);
    }

    visibleFields(tagId: string, selectedOptionKeys?: string[]): string[] {
        const selectedKeys = new Set(selectedOptionKeys ?? this.options.selectedOptionKeys ?? []);

        const tag = this.tagById.get(tagId);
        if (!tag) return [];

        const includesTag = new Set(tag.includes ?? []);
        const excludesTag = new Set(tag.excludes ?? []);

        const incForOpt = this.props.includes_for_options ?? {};
        const excForOpt = this.props.excludes_for_options ?? {};

        const includesOpt = new Set<string>();
        const excludesOpt = new Set<string>();
        for (const key of selectedKeys) {
            for (const id of incForOpt[key] ?? []) includesOpt.add(id);
            for (const id of excForOpt[key] ?? []) excludesOpt.add(id);
        }

        const merged = new Map<string, Field>();

        // bound to this tag
        for (const f of this.props.fields) {
            if (isBoundTo(f, tagId)) merged.set(f.id, f);
        }
        // explicit tag includes
        for (const id of includesTag) {
            const f = this.fieldById.get(id);
            if (f) merged.set(id, f);
        }
        // option-level includes
        for (const id of includesOpt) {
            const f = this.fieldById.get(id);
            if (f) merged.set(id, f);
        }

        // remove excludes
        for (const id of excludesTag) merged.delete(id);
        for (const id of excludesOpt) merged.delete(id);

        return Array.from(merged.keys());
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
        for (const t of this.props.filters) this.tagById.set(t.id, t);
        for (const f of this.props.fields) this.fieldById.set(f.id, f);
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

function pruneStringArrayMap(
    src: Record<string, string[]> | undefined,
    allow: Set<string>,
): Record<string, string[]> | undefined {
    if (!src) return undefined;
    const out: Record<string, string[]> = {};
    for (const [k, arr] of Object.entries(src)) {
        const cleaned = (arr ?? []).filter(id => allow.has(id));
        if (cleaned.length) out[k] = Array.from(new Set(cleaned));
    }
    return Object.keys(out).length ? out : undefined;
}

function structuredCloneSafe<T>(v: T): T {
    // node 18+: global structuredClone exists; fallback to JSON
    if (typeof (globalThis as any).structuredClone === 'function') {
        return (globalThis as any).structuredClone(v);
    }
    return JSON.parse(JSON.stringify(v));
}