// src/core/validate/policies/collect-service-items.ts
import type { ServiceProps, Tag, Field } from "@/schema";
import type {
    DgpServiceCapability,
    DgpServiceMap,
    IdType,
} from "@/schema/provider";
import type { DynamicRule } from "@/schema/validation";

import { getByPath } from "../shared";

export type ServiceItem = Readonly<{
    /** Scope tag context (only meaningful for visible_group / tag-filtered global) */
    tagId?: string;

    /** Reference metadata (used for affectedIds + debugging) */
    fieldId?: string;
    optionId?: string;
    nodeId?: string;

    /** Canonical service id reference */
    serviceId: IdType;

    /** Pricing role context */
    role: "base" | "utility";

    /** Projection target (always present with at least { id }) */
    service: Record<string, unknown>;

    /** Aggregated affected ids (node/service refs that contributed to this item) */
    affectedIds: string[];
}>;

type WhereClause = NonNullable<
    NonNullable<DynamicRule["filter"]>["where"]
>[number];

type CollectMode = "global" | "visible_group";

export type CollectServiceItemsArgs = Readonly<{
    mode: CollectMode;

    props: ServiceProps;
    serviceMap: DgpServiceMap;

    /** For global: pass all tags, and usually props.fields */
    tags?: readonly Tag[];
    fields?: readonly Field[];

    /** For visible_group */
    tag?: Tag;
    tagId?: string;

    /** Host-defined filter surface */
    filter?: DynamicRule["filter"];

    /**
     * visible_group fallbacks:
     * - include node-scoped fallbacks for these node ids (tag.id, option.id, etc.)
     */
    visibleNodeIds?: readonly string[];

    /**
     * visible_group fallbacks:
     * - include global fallbacks for these primary ids (services in the group)
     */
    visiblePrimaries?: readonly IdType[];
}>;

function asArray<T>(v: T | readonly T[] | undefined): readonly T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v as any];
}

function isServiceIdRef(v: unknown): v is IdType {
    return (
        typeof v === "string" || (typeof v === "number" && Number.isFinite(v))
    );
}

function jsonStable(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function eqValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    return jsonStable(a) === jsonStable(b);
}

function includesValue(arr: readonly unknown[], needle: unknown): boolean {
    for (const v of arr) {
        if (eqValue(v, needle)) return true;
    }
    return false;
}

function matchesWhere(
    svc: Record<string, unknown>,
    where: readonly WhereClause[] | undefined,
): boolean {
    if (!where || where.length === 0) return true;

    const root: Record<string, unknown> = { service: svc };

    for (const clause of where) {
        const path: string = clause.path;
        const op: string = clause.op ?? "eq";
        const value: unknown = clause.value;

        const cur: unknown = getByPath(root as any, path);

        if (op === "exists") {
            if (cur === undefined || cur === null) return false;
            continue;
        }
        if (op === "truthy") {
            if (!cur) return false;
            continue;
        }
        if (op === "falsy") {
            if (cur) return false;
            continue;
        }

        if (op === "in" || op === "nin") {
            const list: unknown[] = Array.isArray(value) ? value : [];
            const hit: boolean = includesValue(list, cur);
            if (op === "in" && !hit) return false;
            if (op === "nin" && hit) return false;
            continue;
        }

        if (op === "neq") {
            if (eqValue(cur, value)) return false;
            continue;
        }

        // default "eq"
        if (!eqValue(cur, value)) return false;
    }

    return true;
}

function svcSnapshot(
    serviceMap: DgpServiceMap,
    sid: IdType,
): Record<string, unknown> {
    const svc: DgpServiceCapability | undefined = (serviceMap as any)[sid];
    if (!svc) return { id: sid };

    const meta: Record<string, unknown> =
        svc.meta && typeof svc.meta === "object" ? (svc.meta as any) : {};

    return {
        ...svc,
        id: sid,
        ...meta,
    } as unknown as Record<string, unknown>;
}

function pushItem(
    out: Map<string, ServiceItem>,
    next: Readonly<{
        tagId?: string;
        fieldId?: string;
        optionId?: string;
        nodeId?: string;
        serviceId: IdType;
        role: "base" | "utility";
        affectedIds: readonly string[];
        service: Record<string, unknown>;
    }>,
): void {
    // dedupe by (serviceId, role) to preserve role semantics
    const key: string = `${String(next.serviceId)}|${next.role}`;

    const existing: ServiceItem | undefined = out.get(key);
    if (!existing) {
        out.set(key, {
            tagId: next.tagId,
            fieldId: next.fieldId,
            optionId: next.optionId,
            nodeId: next.nodeId,
            serviceId: next.serviceId,
            role: next.role,
            service: next.service,
            affectedIds: Array.from(new Set(next.affectedIds)),
        });
        return;
    }

    const mergedIds: string[] = Array.from(
        new Set<string>([...existing.affectedIds, ...next.affectedIds]),
    );

    // Prefer preserving an existing tagId if present; otherwise use new
    out.set(key, {
        ...existing,
        tagId: existing.tagId ?? next.tagId,
        affectedIds: mergedIds,
    });
}

function fieldRoleOf(
    f: Field,
    o?: { pricing_role?: string | undefined },
): "base" | "utility" {
    const roleRaw: string | undefined =
        (o?.pricing_role as any) ?? (f.pricing_role as any) ?? "base";
    return roleRaw === "utility" ? "utility" : "base";
}

function applyFilterAllowLists(
    tagId: string | undefined,
    fieldId: string | undefined,
    filter: DynamicRule["filter"] | undefined,
): boolean {
    const tagAllow: readonly string[] | undefined = asArray(filter?.tag_id);
    const fieldAllow: readonly string[] | undefined = asArray(filter?.field_id);

    if (tagAllow) {
        if (!tagId) return false;
        if (!tagAllow.includes(tagId)) return false;
    }

    if (fieldAllow) {
        if (!fieldId) return false;
        if (!fieldAllow.includes(fieldId)) return false;
    }

    return true;
}

export function collectServiceItems(
    args: CollectServiceItemsArgs,
): ServiceItem[] {
    const filter: DynamicRule["filter"] | undefined = args.filter;
    const roleFilter: NonNullable<DynamicRule["filter"]>["role"] =
        (filter?.role as any) ?? "both";
    const where: readonly WhereClause[] | undefined = filter?.where;

    const out: Map<string, ServiceItem> = new Map<string, ServiceItem>();

    const addServiceRef = (
        ref: Readonly<{
            tagId?: string;
            fieldId?: string;
            optionId?: string;
            nodeId?: string;

            serviceId: IdType;
            role: "base" | "utility";

            affectedIds: readonly string[];
        }>,
    ): void => {
        if (roleFilter !== "both" && ref.role !== roleFilter) return;
        if (!applyFilterAllowLists(ref.tagId, ref.fieldId, filter)) return;

        const svc: DgpServiceCapability | undefined = (args.serviceMap as any)[
            ref.serviceId
        ];

        // IMPORTANT (per your 1:A): unknown services are INCLUDED; where-filter only applies when svc exists.
        if (where && svc && !matchesWhere(svc as any, where)) return;

        pushItem(out, {
            ...ref,
            service: svcSnapshot(args.serviceMap, ref.serviceId),
        });
    };

    // ────────────────────────────────────────────────────────────────
    // 1) TAG SERVICES (tag.service_id)
    // ────────────────────────────────────────────────────────────────
    if (args.mode === "global") {
        for (const t of args.tags ?? []) {
            const sid: unknown = (t as any).service_id;
            if (!isServiceIdRef(sid)) continue;

            addServiceRef({
                tagId: t.id,
                serviceId: sid,
                role: "base",
                affectedIds: [`tag:${t.id}`, `service:${String(sid)}`],
            });
        }
    } else if (args.mode === "visible_group") {
        const t: Tag | undefined = args.tag;
        const sid: unknown = t ? (t as any).service_id : undefined;

        if (t && isServiceIdRef(sid)) {
            addServiceRef({
                tagId: t.id,
                serviceId: sid,
                role: "base",
                affectedIds: [`tag:${t.id}`, `service:${String(sid)}`],
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 2) FIELD SERVICES (field.service_id) + OPTION SERVICES
    //    - fields can be button fields with service_id
    //    - multi-field options can map to services
    // ────────────────────────────────────────────────────────────────
    const fields: readonly Field[] = args.fields ?? [];

    for (const f of fields) {
        // field.service_id (button field)
        const fSid: unknown = (f as any).service_id;
        if (isServiceIdRef(fSid)) {
            addServiceRef({
                tagId: args.tagId,
                fieldId: f.id,
                serviceId: fSid,
                role: "base",
                affectedIds: [`field:${f.id}`, `service:${String(fSid)}`],
            });
        }

        // option services
        for (const o of f.options ?? []) {
            const oSid: unknown = (o as any).service_id;
            if (!isServiceIdRef(oSid)) continue;

            const role: "base" | "utility" = fieldRoleOf(f, o);

            addServiceRef({
                tagId: args.tagId,
                fieldId: f.id,
                optionId: o.id,
                serviceId: oSid,
                role,
                affectedIds: [
                    `field:${f.id}`,
                    `option:${o.id}`,
                    `service:${String(oSid)}`,
                ],
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // 3) FALLBACK SERVICES (node + global)
    //    Global: include ALL fallbacks everywhere
    //    Visible group: include:
    //      - nodes fallbacks for visibleNodeIds (tag + visible option ids)
    //      - global fallbacks for visiblePrimaries (primary ids in group)
    // ────────────────────────────────────────────────────────────────
    const fb: ServiceProps["fallbacks"] | undefined = args.props.fallbacks;
    if (!fb) return Array.from(out.values());

    const includeAllFallbacks: boolean = args.mode === "global";
    const includeGroupFallbacks: boolean = args.mode === "visible_group";

    // node-scoped fallbacks
    const nodes: Record<string, IdType[] | undefined> | undefined =
        fb.nodes && typeof fb.nodes === "object"
            ? (fb.nodes as any)
            : undefined;

    if (nodes) {
        if (includeAllFallbacks) {
            for (const [nodeId, list] of Object.entries(nodes)) {
                const arr: readonly unknown[] = Array.isArray(list) ? list : [];
                for (const cand of arr) {
                    if (!isServiceIdRef(cand)) continue;

                    addServiceRef({
                        tagId: args.tagId,
                        nodeId,
                        serviceId: cand,
                        role: "base",
                        affectedIds: [
                            `fallback-node:${nodeId}`,
                            `service:${String(cand)}`,
                        ],
                    });
                }
            }
        } else if (includeGroupFallbacks) {
            const allowNodes: Set<string> = new Set<string>(
                Array.isArray(args.visibleNodeIds)
                    ? (args.visibleNodeIds as string[])
                    : [],
            );

            for (const nodeId of allowNodes) {
                const list: unknown = (nodes as any)[nodeId];
                const arr: readonly unknown[] = Array.isArray(list) ? list : [];
                for (const cand of arr) {
                    if (!isServiceIdRef(cand)) continue;

                    addServiceRef({
                        tagId: args.tagId,
                        nodeId,
                        serviceId: cand,
                        role: "base",
                        affectedIds: [
                            `fallback-node:${nodeId}`,
                            `service:${String(cand)}`,
                        ],
                    });
                }
            }
        }
    }

    // global fallbacks: primary -> candidates
    const globalFb: Record<string, IdType[] | undefined> | undefined =
        fb.global && typeof fb.global === "object"
            ? (fb.global as any)
            : undefined;

    if (globalFb) {
        if (includeAllFallbacks) {
            for (const [primaryKey, list] of Object.entries(globalFb)) {
                // Include the primary itself (object key is a service ref too)
                const primaryId: IdType = primaryKey;

                addServiceRef({
                    tagId: args.tagId,
                    nodeId: primaryKey,
                    serviceId: primaryId,
                    role: "base",
                    affectedIds: [
                        `fallback-global-primary:${primaryKey}`,
                        `service:${String(primaryId)}`,
                    ],
                });

                const arr: readonly unknown[] = Array.isArray(list) ? list : [];
                for (const cand of arr) {
                    if (!isServiceIdRef(cand)) continue;

                    addServiceRef({
                        tagId: args.tagId,
                        nodeId: primaryKey,
                        serviceId: cand,
                        role: "base",
                        affectedIds: [
                            `fallback-global:${primaryKey}`,
                            `service:${String(cand)}`,
                        ],
                    });
                }
            }
        } else if (includeGroupFallbacks) {
            const allowPrimaries: Set<string> = new Set<string>(
                (args.visiblePrimaries ?? []).map((x) => String(x)),
            );

            for (const primaryKey of allowPrimaries) {
                const list: unknown = (globalFb as any)[primaryKey];
                if (list === undefined) continue;

                const primaryId: IdType = primaryKey;

                addServiceRef({
                    tagId: args.tagId,
                    nodeId: primaryKey,
                    serviceId: primaryId,
                    role: "base",
                    affectedIds: [
                        `fallback-global-primary:${primaryKey}`,
                        `service:${String(primaryId)}`,
                    ],
                });

                const arr: readonly unknown[] = Array.isArray(list) ? list : [];
                for (const cand of arr) {
                    if (!isServiceIdRef(cand)) continue;

                    addServiceRef({
                        tagId: args.tagId,
                        nodeId: primaryKey,
                        serviceId: cand,
                        role: "base",
                        affectedIds: [
                            `fallback-global:${primaryKey}`,
                            `service:${String(cand)}`,
                        ],
                    });
                }
            }
        }
    }

    return Array.from(out.values());
}
