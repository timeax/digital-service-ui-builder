// src/core/validate/steps/global-utility-guard.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber } from "../shared";

export function validateGlobalUtilityGuard(v: ValidationCtx): void {
    if (!v.options.globalUtilityGuard) return;

    let hasUtility: boolean = false;
    let hasBase: boolean = false;

    for (const f of v.fields) {
        for (const o of f.options ?? []) {
            if (!isFiniteNumber(o.service_id)) continue;

            const role: string = o.pricing_role ?? f.pricing_role ?? "base";
            if (role === "base") hasBase = true;
            else if (role === "utility") hasUtility = true;

            if (hasUtility && hasBase) break;
        }

        if (hasUtility && hasBase) break;
    }

    if (hasUtility && !hasBase) {
        v.errors.push({
            code: "utility_without_base",
            nodeId: "global",
            details: { scope: "global" },
        });
    }
}
