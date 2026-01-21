// src/core/validate/shared.ts
import type { ServiceProps, Tag, Field } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { ValidationError, ValidatorOptions } from "@/schema/validation";

export interface ValidationCtx {
    readonly props: ServiceProps;
    readonly options: ValidatorOptions;

    readonly errors: ValidationError[];

    readonly serviceMap: DgpServiceMap;
    readonly selectedKeys: Set<string>;

    readonly tags: Tag[];
    readonly fields: Field[];

    readonly tagById: Map<string, Tag>;
    readonly fieldById: Map<string, Field>;

    fieldsVisibleUnder: (tagId: string) => Field[];
}

export function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

export function hasAnyServiceOption(f: Field): boolean {
    return (f.options ?? []).some((o) => isFiniteNumber(o.service_id));
}

export function isBoundTo(f: Field, tagId: string): boolean {
    const b: string | string[] | undefined = f.bind_id;
    if (!b) return false;
    return Array.isArray(b) ? b.includes(tagId) : b === tagId;
}

export function getByPath(obj: unknown, path: string | undefined): unknown {
    if (!path) return undefined;

    const parts: string[] = path.split(".");
    let cur: any = obj;

    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }

    return cur;
}

export type WhereClause = NonNullable<
    NonNullable<import("@/schema/validation").DynamicRule["filter"]>["where"]
>[number];

export function jsonStable(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

export function eqValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    return jsonStable(a) === jsonStable(b);
}

export function includesValue(
    arr: readonly unknown[],
    needle: unknown,
): boolean {
    for (const v of arr) {
        if (eqValue(v, needle)) return true;
    }
    return false;
}

export function serviceFlagState(
    svc: Record<string, unknown>,
    flagId: string,
): boolean | undefined {
    const flags: unknown = (svc as any).flags;
    const entry: unknown =
        flags && typeof flags === "object" ? (flags as any)[flagId] : undefined;

    const enabled: unknown =
        entry && typeof entry === "object" ? (entry as any).enabled : undefined;

    if (enabled === true) return true;
    if (enabled === false) return false;

    return undefined;
}

export function isServiceFlagEnabled(
    svc: Record<string, unknown>,
    flagId: string,
): boolean {
    return serviceFlagState(svc, flagId) === true;
}
