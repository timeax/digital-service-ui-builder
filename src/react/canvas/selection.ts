// src/react/canvas/selection.ts
import type {Builder} from 'digital-service-ui-builder/core';
import type {ServiceProps, Tag, Field} from 'digital-service-ui-builder/schema';
import {DgpServiceCapability} from "../../schema/provider";

export type Env = 'client' | 'workspace';

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
    | { kind: 'single'; group: VisibleGroup }
    | { kind: 'multi'; groups: string[] };

type ChangeEvt = { ids: string[]; primary?: string };
type Listener = (e: ChangeEvt) => void;

const isTagId = (id: string) => typeof id === 'string' && id.startsWith('t:');
const isOptionId = (id: string) => typeof id === 'string' && id.startsWith('o:');

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
        private readonly opts: SelectionOptions = {}
    ) {
    }

    // ── Public mutators (explicit, no “mode” string) ────────────────────────────
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

    // ── Read APIs ───────────────────────────────────────────────────────────────
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

    // ── Main: visible group snapshot (env-aware) ────────────────────────────────
    visibleGroup(): VisibleGroupResult {
        const props = this.builder.getProps() as ServiceProps;

        // WORKSPACE: >1 tag selected → return raw selection set
        if ((this.opts.env ?? 'client') === 'workspace') {
            const tagIds = Array.from(this.set).filter(isTagId);
            if (tagIds.length > 1) {
                return {kind: 'multi', groups: Array.from(this.set)};
            }
        }

        const tagId = this.resolveTagContextId(props);
        if (!tagId) return {kind: 'single', group: {fields: [], fieldIds: []}};

        const group = this.computeGroupForTag(props, tagId);
        return {kind: 'single', group};
    }

    // ── Internals ───────────────────────────────────────────────────────────────
    private emit() {
        const payload: ChangeEvt = {ids: Array.from(this.set), primary: this.primaryId};
        for (const fn of this.onChangeFns) fn(payload);
    }

    private updateCurrentTagFrom(id: string) {
        const props = this.builder.getProps() as ServiceProps;
        const tags = props.filters ?? [];
        const fields = props.fields ?? [];

        if (tags.some(t => t.id === id)) {
            this.currentTagId = id;
            return;
        }
        const f = fields.find(x => x.id === id);
        if (f?.bind_id) {
            this.currentTagId = Array.isArray(f.bind_id) ? f.bind_id[0] : f.bind_id;
            return;
        }

        if (isOptionId(id)) {
            const host = fields.find(x => (x.options ?? []).some(o => o.id === id));
            if (host?.bind_id) {
                this.currentTagId = Array.isArray(host.bind_id) ? host.bind_id[0] : host.bind_id;
                return;
            }
        }

        if (id.includes('::')) {
            const [fid] = id.split('::');
            const host = fields.find(x => x.id === fid);
            if (host?.bind_id) {
                this.currentTagId = Array.isArray(host.bind_id) ? host.bind_id[0] : host.bind_id;
                return;
            }
        }
    }

    private resolveTagContextId(props: ServiceProps): string | undefined {
        if (this.currentTagId) return this.currentTagId;

        for (const id of this.set) if (isTagId(id)) return id;

        const fields = props.fields ?? [];
        for (const id of this.set) {
            const f = fields.find(x => x.id === id);
            if (f?.bind_id) return Array.isArray(f.bind_id) ? f.bind_id[0] : f.bind_id;
        }

        for (const id of this.set) {
            if (isOptionId(id)) {
                const host = fields.find(x => (x.options ?? []).some(o => o.id === id));
                if (host?.bind_id) return Array.isArray(host.bind_id) ? host.bind_id[0] : host.bind_id;
            }
            if (id.includes('::')) {
                const [fid] = id.split('::');
                const host = fields.find(x => x.id === fid);
                if (host?.bind_id) return Array.isArray(host.bind_id) ? host.bind_id[0] : host.bind_id;
            }
        }

        return this.opts.rootTagId;
    }

    private computeGroupForTag(props: ServiceProps, tagId: string): VisibleGroup {
        const tags = props.filters ?? [];
        const fields = props.fields ?? [];
        const tagById = new Map(tags.map(t => [t.id, t]));
        const tag = tagById.get(tagId);

        // selection-aware option include/exclude
        const selectedOptionIds = this.selectedOptionIds(props);
        const incForOpt = props.includes_for_options ?? {};
        const excForOpt = props.excludes_for_options ?? {};
        const optInclude = new Set<string>();
        const optExclude = new Set<string>();
        for (const oid of selectedOptionIds) {
            for (const id of incForOpt[oid] ?? []) optInclude.add(id);
            for (const id of excForOpt[oid] ?? []) optExclude.add(id);
        }

        const tagInclude = new Set(tag?.includes ?? []);
        const tagExclude = new Set(tag?.excludes ?? []);

        // field pool
        const pool = new Map<string, Field>();
        for (const f of fields) {
            if (this.isBoundTo(f, tagId)) pool.set(f.id, f);
            if (tagInclude.has(f.id)) pool.set(f.id, f);
            if (optInclude.has(f.id)) pool.set(f.id, f);
        }
        for (const id of tagExclude) pool.delete(id);
        for (const id of optExclude) pool.delete(id);

        // optional order_for_tags
        const order = props.order_for_tags?.[tagId];
        const visible = order
            ? (order.map(fid => pool.get(fid)).filter(Boolean) as Field[]).concat(
                // any left-overs not in order list
                Array.from(pool.values()).filter(f => !order.includes(f.id))
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
        const childrenTags = tags.filter(t => t.bind_id === tagId);

        // services: tag (unless overridden by base option) → options in selection order
        const services: DgpServiceCapability[] = [];
        const resolve = this.opts.resolveService;

        // 1) Start with tag base (if any)
        let baseAddedFromTag = false;
        if (tag?.service_id != null) {
            const cap = resolve?.(tag.service_id) ?? ({id: tag.service_id} as DgpServiceCapability);
            services.push(cap);
            baseAddedFromTag = true;
        }

        // 2) Walk selected ids in insertion order; if an option maps to a service, add it.
        //    If the FIRST base-role option is encountered, it overrides the tag base (if any).
        let baseOverridden = false;
        for (const selId of this.set) {
            // only options matter for service composition here
            const opt = this.findOptionById(fields, selId);
            if (!opt || opt.service_id == null) continue;

            const role = (opt.pricing_role ?? (opt as any).role ?? 'base') as 'base' | 'utility' | 'addon';
            const cap = resolve?.(opt.service_id) ?? ({id: opt.service_id} as DgpServiceCapability);

            if (role === 'base') {
                if (!baseOverridden) {
                    // override existing first element (if it originated from tag)
                    if (baseAddedFromTag && services.length > 0) {
                        services[0] = cap;
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
            fieldIds: visible.map(f => f.id),
            parentTags,
            childrenTags,
            services,
        };
    }

    private isBoundTo(f: Field, tagId: string): boolean {
        if (!f.bind_id) return false;
        return Array.isArray(f.bind_id) ? f.bind_id.includes(tagId) : f.bind_id === tagId;
    }

    private selectedOptionIds(props: ServiceProps): string[] {
        const out: string[] = [];
        const fields = props.fields ?? [];

        for (const id of this.set) {
            if (isOptionId(id)) {
                out.push(id);
                continue;
            }
            if (id.includes('::')) {
                const [fid, legacyOid] = id.split('::');
                if (!fid || !legacyOid) continue;
                const host = fields.find(x => x.id === fid);
                const global = host?.options?.find(o => o.id === legacyOid)?.id ?? legacyOid;
                out.push(global);
            }
        }
        return out;
    }

    private findOptionById(fields: Field[], selId: string) {
        if (isOptionId(selId)) {
            for (const f of fields) {
                const o = f.options?.find(x => x.id === selId);
                if (o) return o;
            }
        }
        if (selId.includes('::')) {
            const [fid, oid] = selId.split('::');
            const f = fields.find(x => x.id === fid);
            const o = f?.options?.find(x => x.id === oid || x.id === selId);
            if (o) return o;
        }
        return undefined;
    }
}