// src/core/validate/policies/where.ts
import type { WhereClause } from "../shared";
import { getByPath, includesValue, eqValue } from "../shared";

export function matchesWhere(
    svc: Record<string, unknown>,
    where: readonly WhereClause[] | undefined,
): boolean {
    if (!where || where.length === 0) return true;

    const root: Record<string, unknown> = { service: svc };

    for (const clause of where) {
        const path: string = clause.path;
        const op: string = clause.op ?? "eq";
        const value: unknown = clause.value;

        const cur: unknown = getByPath(root, path);

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

        if (!eqValue(cur, value)) return false;
    }

    return true;
}
