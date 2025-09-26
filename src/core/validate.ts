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
    const incMap = props.includes_for_options ?? {};
    const excMap = props.excludes_for_options ?? {};

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
        const incForOpt = props.includes_for_options ?? {};
        const excForOpt = props.excludes_for_options ?? {};

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
    const parentOf = (id: string | undefined): string | undefined => (id ? tagById.get(id)?.bind_id : undefined);
    const ancestorsOf = (id: string): string[] => {
        const out: string[] = [];
        let cur = tagById.get(id)?.bind_id;
        const guard = new Set<string>();
        while (cur && !guard.has(cur)) {
            out.push(cur);
            guard.add(cur);
            cur = parentOf(cur);
        }
        return out;
    };

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
        for (const arr of Object.values(props.includes_for_options ?? {})) {
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