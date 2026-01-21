// src/core/validate/policies/collect-service-items.ts
import type { Field } from "@/schema";
import type { DgpServiceCapability, DgpServiceMap } from "@/schema/provider";
import type { DynamicRule } from "@/schema/validation";

import type { WhereClause } from "../shared";
import { isFiniteNumber } from "../shared";
import { matchesWhere } from "./where";

export type ServiceItem = {
    tagId?: string;
    fieldId: string;
    optionId: string;
    serviceId: number;
    role: "base" | "utility";
    service?: Partial<DgpServiceCapability>;
};

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
}

export function collectServiceItems(
    fields: Field[],
    tagId: string | undefined,
    serviceMap: DgpServiceMap,
    filter?: DynamicRule["filter"],
): ServiceItem[] {
    const roleFilter: "base" | "utility" | "both" = filter?.role ?? "both";
    const fieldIdAllow: string[] | undefined = asArray(filter?.field_id);
    const tagIdAllow: string[] | undefined = asArray(filter?.tag_id);
    const where: readonly WhereClause[] | undefined = filter?.where;

    const out: ServiceItem[] = [];

    for (const f of fields) {
        if (fieldIdAllow && !fieldIdAllow.includes(f.id)) continue;

        for (const o of f.options ?? []) {
            const sid: unknown = o.service_id;
            if (!isFiniteNumber(sid)) continue;

            const role: "base" | "utility" = (o.pricing_role ??
                f.pricing_role ??
                "base") as "base" | "utility";

            if (roleFilter !== "both" && role !== roleFilter) continue;

            const svc: unknown = (serviceMap as any)[sid];
            if (
                where &&
                svc &&
                typeof svc === "object" &&
                !matchesWhere(svc as any, where)
            )
                continue;
            if (tagIdAllow && (!tagId || !tagIdAllow.includes(tagId))) continue;

            out.push({
                tagId,
                fieldId: f.id,
                optionId: o.id,
                serviceId: sid,
                role,
                service:
                    svc && typeof svc === "object" ? (svc as any) : undefined,
            });
        }
    }

    return out;
}
