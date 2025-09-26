// src/core/normalise.ts
// noinspection UnnecessaryLocalVariableJS

import type {
    ServiceProps,
    Tag,
    Field,
    FieldOption,
    PricingRole,
} from '../schema';

export type NormaliseOptions = {
    /** default pricing role for fields/options when missing */
    defaultPricingRole?: PricingRole; // default: 'base'
};

/**
 * Coerce an arbitrary (possibly legacy) payload into the canonical ServiceProps shape.
 * - snake_case keys (bind_id, service_id, includes_for_options, excludes_for_options)
 * - injects a root tag if missing
 * - migrates legacy rootIncludes/rootExcludes -> root.includes/excludes
 * - normalises bind_id (string for single, string[] for multi)
 * - sets pricing_role default ('base') on fields & options
 */
export function normalise(input: unknown, opts: NormaliseOptions = {}): ServiceProps {
    const defRole: PricingRole = opts.defaultPricingRole ?? 'base';

    const obj = toObject(input);

    // pull top-level props (accept a few legacy aliases just in case)
    const legacyFilters = (obj as any).filters ?? (obj as any).tags ?? [];
    const legacyFields = (obj as any).fields ?? [];
    const legacyIncForOpts =
        (obj as any).includes_for_options ??
        (obj as any).includesForOptions ??
        undefined;
    const legacyExcForOpts =
        (obj as any).excludes_for_options ??
        (obj as any).excludeForOptions ??
        undefined;

    // 1) Tags
    let tags: Tag[] = Array.isArray(legacyFilters)
        ? legacyFilters.map(coerceTag)
        : [];

    // 2) Fields
    let fields: Field[] = Array.isArray(legacyFields)
        ? legacyFields.map((f) => coerceField(f, defRole))
        : [];

    // 3) Ensure root tag exists
    const hasRoot = tags.some((t) => t?.id === 'root');
    if (!hasRoot) {
        tags = [
            {
                id: 'root',
                label: 'Root',
                // service_id intentionally undefined here; author-time validator enforces if required
            },
            ...tags,
        ];
    }

    // 4) Migrate legacy rootIncludes/rootExcludes into root tag
    const rootIncludes: string[] = Array.isArray((obj as any).rootIncludes)
        ? (obj as any).rootIncludes.slice()
        : [];
    const rootExcludes: string[] = Array.isArray((obj as any).rootExcludes)
        ? (obj as any).rootExcludes.slice()
        : [];

    if (rootIncludes.length || rootExcludes.length) {
        tags = tags.map((t) => {
            if (t.id !== 'root') return t;
            const includes = dedupe([...(t.includes ?? []), ...rootIncludes]);
            const excludes = dedupe([...(t.excludes ?? []), ...rootExcludes]);

            // normaliser favors excludes over includes if the same id appears in both
            const exclSet = new Set(excludes);
            const filteredIncludes = includes.filter((id) => !exclSet.has(id));

            return {...t, includes: filteredIncludes, excludes};
        });
    }

    // 5) Option-level maps → snake_case
    const includes_for_options = toStringArrayMap(legacyIncForOpts);
    const excludes_for_options = toStringArrayMap(legacyExcForOpts);

    // 6) Return canonical payload (drop unknown top-level keys)
    const out: ServiceProps = {
        filters: tags,
        fields,
        ...(isNonEmpty(includes_for_options) && {includes_for_options}),
        ...(isNonEmpty(excludes_for_options) && {excludes_for_options}),
        schema_version: typeof (obj as any).schema_version === 'string' ? (obj as any).schema_version : '1.0',
    };

    propagateConstraints(out);

    return out;
}

// ───────────────────────── Constraint propagation ─────────────────────────

const FLAG_KEYS = ['refill', 'cancel', 'dripfeed'] as const;
type FlagKey = typeof FLAG_KEYS[number];

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

    // Build indices and children map
    const byId = new Map(tags.map(t => [t.id, t]));
    const children = new Map<string, Tag[]>();
    for (const t of tags) {
        const pid = t.bind_id;
        if (!pid || !byId.has(pid)) continue; // missing/invalid parent → treat as root
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid)!.push(t);
    }

    // Roots: no valid parent
    const roots = tags.filter(t => !t.bind_id || !byId.has(t.bind_id));

    type Inherited = Partial<Record<FlagKey, { val: boolean; origin: string }>>;

    const visit = (tag: Tag, inherited: Inherited) => {
        const local = tag.constraints ?? {};
        const next: Partial<Record<FlagKey, boolean>> = {...local}; // effective values (after override)
        const origin: Partial<Record<FlagKey, string>> = {};          // nearest origin for each effective flag
        const overrides: NonNullable<Tag['constraints_overrides']> = {};

        // Apply inherited values first (override child's local if different) and record provenance/overrides
        for (const k of FLAG_KEYS) {
            const inh = inherited[k];
            if (inh) {
                const prev = local[k];
                next[k] = inh.val;
                origin[k] = inh.origin;
                if (prev !== undefined && prev !== inh.val) {
                    overrides[k] = {from: prev as boolean, to: inh.val, origin: inh.origin};
                }
            } else if (local[k] !== undefined) {
                // No inherited value; a local explicit becomes its own origin
                origin[k] = tag.id;
            }
        }

        // Persist only when something is defined (keep JSON lean)
        tag.constraints = FLAG_KEYS.some(k => next[k] !== undefined) ? next : undefined;
        tag.constraints_origin = Object.keys(origin).length ? origin : undefined;
        tag.constraints_overrides = Object.keys(overrides).length ? overrides : undefined;

        // Children should inherit the **effective** values from this tag
        const passDown: Inherited = {...inherited};
        for (const k of FLAG_KEYS) {
            if (origin[k] !== undefined && next[k] !== undefined) {
                passDown[k] = {val: next[k] as boolean, origin: origin[k]!};
            }
        }

        // Recurse
        for (const c of children.get(tag.id) ?? []) visit(c, passDown);
    };

    for (const r of roots) visit(r, {});
}

/* ───────────────────────────── helpers ───────────────────────────── */

function toObject(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') return input as Record<string, unknown>;
    throw new TypeError('normalise(): expected an object payload');
}

function coerceTag(src: any): Tag {
    if (!src || typeof src !== 'object') src = {};
    const id = str(src.id);
    const label = str(src.label);

    // legacy → snake_case
    const bind_id =
        str(src.bind_id) ||
        str(src.bindId) ||
        undefined;

    const service_id =
        toNumberOrUndefined(src.service_id ?? src.serviceId);

    const includes = toStringArray(src.includes);
    const excludes = toStringArray(src.excludes);

    const constraints =
        src.constraints && typeof src.constraints === 'object'
            ? {
                refill: bool((src.constraints as any).refill),
                cancel: bool((src.constraints as any).cancel),
                dripfeed: bool((src.constraints as any).dripfeed),
            }
            : undefined;

    const meta =
        src.meta && typeof src.meta === 'object' ? (src.meta as Record<string, unknown>) : undefined;

    // noinspection UnnecessaryLocalVariableJS
    const tag: Tag = {
        id: "", label: "",
        ...(id && {id}),
        ...(label && {label}),
        ...(bind_id && {bind_id}),
        ...(service_id !== undefined && {service_id}),
        ...(constraints && {constraints}),
        ...(includes.length && {includes: dedupe(includes)}),
        ...(excludes.length && {excludes: dedupe(excludes)}),
        ...(meta && {meta})
    };

    return tag;
}

function coerceField(src: any, defRole: PricingRole): Field {
    if (!src || typeof src !== 'object') src = {};

    // legacy → snake_case
    const bindRaw = src.bind_id ?? src.bind ?? undefined;
    const bind_id = normaliseBindId(bindRaw);

    const type = str(src.type) || 'text'; // generic safe default
    const id = str(src.id);
    const name = typeof src.name === 'string' ? src.name : undefined;

    // Base UI props (carry through; provide safe defaults)
    const label = str(src.label) || '';
    const placeholder = typeof src.placeholder === 'string' ? src.placeholder : '';
    const helperText = typeof src.helperText === 'string' ? src.helperText : '';
    const helperTextPos = 'bottom' as const;
    const labelClassName = typeof src.labelClassName === 'string' ? src.labelClassName : '';
    const required = !!src.required;
    const axis = src.axis === 'x' || src.axis === 'y' ? src.axis : 'y';
    const labelAxis = src.labelAxis === 'x' || src.labelAxis === 'y' ? src.labelAxis : 'x';
    const extra = 'extra' in src ? src.extra : undefined;

    const pricing_role: PricingRole =
        src.pricing_role === 'utility' || src.pricing_role === 'base'
            ? src.pricing_role
            : defRole;

    // options: convert serviceId -> service_id, set pricing_role default from field
    const options = Array.isArray(src.options)
        ? (src.options as any[]).map((o) => coerceOption(o, pricing_role))
        : undefined;

    const component = type === 'custom' ? str(src.component) || undefined : undefined;

    const meta = (src.meta && typeof src.meta === 'object') ? {...(src.meta as any)} : undefined;
    if (meta && 'multi' in meta) meta.multi = !!meta.multi; // normalize to boolean

    const field: Field = {
        id,
        type,
        ...(bind_id !== undefined && {bind_id}),
        ...(name && {name}),
        ...(options && options.length && {options}),
        ...(component && {component}),
        pricing_role,
        label,
        placeholder,
        helperText,
        helperTextPos,
        labelClassName,
        required,
        axis,
        labelAxis,
        ...(extra !== undefined && {extra}),
        ...(meta && {meta}),
    };

    return field;
}

function coerceOption(src: any, inheritRole: PricingRole): FieldOption {
    if (!src || typeof src !== 'object') src = {};
    const id = str(src.id);
    const label = str(src.label);

    const service_id = toNumberOrUndefined(src.service_id ?? src.serviceId);
    const value =
        typeof src.value === 'string' || typeof src.value === 'number'
            ? (src.value as string | number)
            : undefined;

    const pricing_role: PricingRole =
        src.pricing_role === 'utility' || src.pricing_role === 'base'
            ? src.pricing_role
            : inheritRole;

    const meta =
        src.meta && typeof src.meta === 'object' ? (src.meta as Record<string, unknown>) : undefined;

    const option: FieldOption = {
        id: "", label: "",
        ...(id && {id}),
        ...(label && {label}),
        ...(value !== undefined && {value}),
        ...(service_id !== undefined && {service_id}),
        pricing_role,
        ...(meta && {meta})
    };
    return option;
}

function normaliseBindId(bind: unknown): string | string[] | undefined {
    if (typeof bind === 'string' && bind.trim()) return bind.trim();
    if (Array.isArray(bind)) {
        const arr = dedupe(bind.map((b) => String(b).trim()).filter(Boolean));
        if (arr.length === 0) return undefined;
        if (arr.length === 1) return arr[0];
        return arr;
    }
    return undefined;
}

function toStringArrayMap(src: any): Record<string, string[]> | undefined {
    if (!src || typeof src !== 'object') return undefined;
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
    if (typeof v === 'string' && v.trim().length > 0) return v;
    return undefined;
}

function bool(v: any): boolean | undefined {
    if (v === undefined) return undefined;
    return !!v;
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

function isNonEmpty(obj: Record<string, any> | undefined): obj is Record<string, any> {
    return !!obj && Object.keys(obj).length > 0;
}