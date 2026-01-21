// src/core/validate/policies/apply-policies.ts
import type { ServiceProps, Tag, Field } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { DynamicRule, ValidationError } from "@/schema/validation";

import { getByPath } from "../shared";
import { collectServiceItems } from "./collect-service-items";
import { evalPolicyOp } from "./ops";

export function applyPolicies(
    errors: ValidationError[],
    props: ServiceProps,
    serviceMap: DgpServiceMap,
    policies: DynamicRule[] | undefined,
    fieldsVisibleUnder: (tagId: string) => Field[],
    tags: Tag[],
): void {
    if (!policies?.length) return;

    for (const rule of policies) {
        const projPath: string = rule.projection ?? "service.id";

        if (rule.scope === "global") {
            const allFields: Field[] = props.fields ?? [];
            const items = collectServiceItems(
                allFields,
                undefined,
                serviceMap,
                rule.filter,
            );
            const values: unknown[] = items.map((it) =>
                getByPath(it, projPath),
            );

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: "policy_violation",
                    nodeId: "global",
                    details: {
                        ruleId: rule.id,
                        scope: "global",
                        severity: rule.severity ?? "error",
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
            const visibleFields: Field[] = fieldsVisibleUnder(t.id);
            const items = collectServiceItems(
                visibleFields,
                t.id,
                serviceMap,
                rule.filter,
            );
            if (!items.length) continue;

            const values: unknown[] = items.map((it) =>
                getByPath(it, projPath),
            );

            if (!evalPolicyOp(rule.op, values, rule)) {
                errors.push({
                    code: "policy_violation",
                    nodeId: t.id,
                    details: {
                        ruleId: rule.id,
                        scope: "visible_group",
                        severity: rule.severity ?? "error",
                        op: rule.op,
                        projection: projPath,
                        count: items.length,
                    },
                });
            }
        }
    }
}
