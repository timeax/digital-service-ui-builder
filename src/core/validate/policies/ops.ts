// src/core/validate/policies/ops.ts
import type { DynamicRule } from "@/schema/validation";

export function evalPolicyOp(
    op: DynamicRule["op"],
    values: unknown[],
    rule: DynamicRule,
): boolean {
    switch (op) {
        case "all_equal": {
            const set: Set<string> = new Set<string>(
                values.map((v) => JSON.stringify(v)),
            );
            return set.size <= 1;
        }
        case "no_mix": {
            const set: Set<string> = new Set<string>(
                values.map((v) => JSON.stringify(v)),
            );
            return set.size <= 1;
        }
        case "unique": {
            const seen: Set<string> = new Set<string>();
            for (const v of values) {
                const k: string = JSON.stringify(v);
                if (seen.has(k)) return false;
                seen.add(k);
            }
            return true;
        }
        case "all_true": {
            return values.every((v) => v === true);
        }
        case "any_true": {
            return values.some((v) => v === true);
        }
        case "max_count": {
            const limit: number =
                typeof rule.value === "number" ? rule.value : Infinity;
            return values.length <= limit;
        }
        case "min_count": {
            const min: number = typeof rule.value === "number" ? rule.value : 0;
            return values.length >= min;
        }
        default:
            return true;
    }
}
