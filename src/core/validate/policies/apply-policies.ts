// src/core/validate/policies/apply-policies.ts
import type { ServiceProps, Tag, Field } from "@/schema";
import type { DgpServiceMap, IdType } from "@/schema/provider";
import type { DynamicRule, ValidationError } from "@/schema/validation";

import { getByPath } from "../shared";
import { collectServiceItems, type ServiceItem } from "./collect-service-items";
import { evalPolicyOp } from "./ops";

function uniq<T>(arr: readonly T[]): T[] {
    return Array.from(new Set<T>(arr));
}

function stableSeverity(
    s: DynamicRule["severity"] | undefined,
): "error" | "warning" | "info" {
    if (s === "warning") return "warning";
    if (s === "error") return "error";
    return "error";
}

function defaultPolicyMessage(rule: DynamicRule): string {
    if (typeof rule.message === "string" && rule.message.trim())
        return rule.message;
    if (typeof rule.label === "string" && rule.label.trim())
        return rule.label.trim();
    return `Policy "${rule.id}" violated`;
}

function affectedFromItems(items: readonly ServiceItem[]): string[] {
    const ids: string[] = [];
    for (const it of items) {
        for (const x of it.affectedIds ?? []) ids.push(x);
        ids.push(`service:${String(it.serviceId)}`);
    }
    return uniq(ids);
}

function visibleGroupNodeIds(tag: Tag, fields: readonly Field[]): string[] {
    const ids: string[] = [tag.id];

    for (const f of fields) {
        for (const o of f.options ?? []) {
            ids.push(o.id);
        }
    }

    return uniq(ids);
}

function visibleGroupPrimaries(tag: Tag, fields: readonly Field[]): IdType[] {
    const prim: IdType[] = [];

    const tagSid: unknown = (tag as any).service_id;
    if (
        typeof tagSid === "string" ||
        (typeof tagSid === "number" && Number.isFinite(tagSid))
    ) {
        prim.push(tagSid);
    }

    for (const f of fields) {
        const fsid: unknown = (f as any).service_id;
        if (
            typeof fsid === "string" ||
            (typeof fsid === "number" && Number.isFinite(fsid))
        ) {
            prim.push(fsid);
        }

        for (const o of f.options ?? []) {
            const osid: unknown = (o as any).service_id;
            if (
                typeof osid === "string" ||
                (typeof osid === "number" && Number.isFinite(osid))
            ) {
                prim.push(osid);
            }
        }
    }

    return uniq(prim);
}

export function applyPolicies(
    errors: ValidationError[],
    props: ServiceProps,
    serviceMap: DgpServiceMap,
    policies: DynamicRule[] | undefined,
    fieldsVisibleUnder: (tagId: string) => Field[],
    tags: Tag[],
): void {
    if (!policies?.length) return;

    const tagById: Map<string, Tag> = new Map<string, Tag>();
    for (const t of tags) tagById.set(t.id, t);

    for (const rule of policies) {
        const projPath: string = rule.projection ?? "service.id";
        const severity: "error" | "warning" | "info" = stableSeverity(
            rule.severity,
        );
        const message: string = defaultPolicyMessage(rule);

        // ────────────────────────────────────────────────────────────────
        // GLOBAL: "all services - everywhere, anywhere"
        // - includes tags, fields (field.service_id + option.service_id), fallbacks (nodes + global)
        // - if rule.filter.tag_id is present, global becomes "union of those visible groups"
        //   (still strict within the selected universe)
        // ────────────────────────────────────────────────────────────────
        if (rule.scope === "global") {
            const tagAllow: readonly string[] | undefined = Array.isArray(
                rule.filter?.tag_id,
            )
                ? (rule.filter?.tag_id as string[])
                : rule.filter?.tag_id
                  ? [rule.filter.tag_id as string]
                  : undefined;

            let items: ServiceItem[] = [];

            if (tagAllow && tagAllow.length) {
                // Union of selected visible-groups (including tag itself + group fallbacks)
                const merged: Map<string, ServiceItem> = new Map<
                    string,
                    ServiceItem
                >();

                for (const id of tagAllow) {
                    const t: Tag | undefined = tagById.get(id);
                    if (!t) continue;

                    const visibleFields: Field[] = fieldsVisibleUnder(t.id);
                    const nodeIds: string[] = visibleGroupNodeIds(
                        t,
                        visibleFields,
                    );
                    const primaries: IdType[] = visibleGroupPrimaries(
                        t,
                        visibleFields,
                    );

                    const sub: ServiceItem[] = collectServiceItems({
                        mode: "visible_group",
                        props,
                        serviceMap,
                        tag: t,
                        tagId: t.id,
                        fields: visibleFields,
                        filter: rule.filter,
                        visibleNodeIds: nodeIds,
                        visiblePrimaries: primaries,
                    });

                    for (const it of sub) {
                        const k: string = `${String(it.serviceId)}|${it.role}`;
                        const existing: ServiceItem | undefined = merged.get(k);
                        if (!existing) {
                            merged.set(k, it);
                        } else {
                            merged.set(k, {
                                ...existing,
                                affectedIds: uniq([
                                    ...existing.affectedIds,
                                    ...it.affectedIds,
                                ]),
                            });
                        }
                    }
                }

                items = Array.from(merged.values());
            } else {
                // Truly everything, anywhere:
                const allFields: Field[] = props.fields ?? [];

                items = collectServiceItems({
                    mode: "global",
                    props,
                    serviceMap,
                    tags,
                    fields: allFields,
                    filter: rule.filter,
                });
            }

            const values: unknown[] = items.map((it) =>
                getByPath(it as any, projPath),
            );

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: "policy_violation",
                    severity,
                    message,
                    nodeId: "global",
                    details: {
                        ruleId: rule.id,
                        scope: "global",
                        op: rule.op,
                        projection: projPath,
                        count: items.length,
                        affectedIds: affectedFromItems(items),
                    },
                });
            }

            continue;
        }

        // ────────────────────────────────────────────────────────────────
        // VISIBLE GROUP: "all current visible nodes under tagId including the tag"
        // + include node-scoped fallbacks for the tag + visible option ids
        // + include global fallbacks for primaries present in that group
        // ────────────────────────────────────────────────────────────────
        for (const t of tags) {
            const visibleFields: Field[] = fieldsVisibleUnder(t.id);

            const nodeIds: string[] = visibleGroupNodeIds(t, visibleFields);
            const primaries: IdType[] = visibleGroupPrimaries(t, visibleFields);

            const items: ServiceItem[] = collectServiceItems({
                mode: "visible_group",
                props,
                serviceMap,
                tag: t,
                tagId: t.id,
                fields: visibleFields,
                filter: rule.filter,
                visibleNodeIds: nodeIds,
                visiblePrimaries: primaries,
            });

            if (!items.length) continue;

            const values: unknown[] = items.map((it) =>
                getByPath(it as any, projPath),
            );

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: "policy_violation",
                    severity,
                    message,
                    nodeId: t.id,
                    details: {
                        ruleId: rule.id,
                        scope: "visible_group",
                        op: rule.op,
                        projection: projPath,
                        count: items.length,
                        affectedIds: affectedFromItems(items),
                    },
                });
            }
        }
    }
}
