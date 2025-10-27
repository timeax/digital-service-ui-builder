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
