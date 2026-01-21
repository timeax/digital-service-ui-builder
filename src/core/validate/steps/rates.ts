// src/core/validate/steps/rates.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber, withAffected } from "../shared";
import { isMultiField } from "@/utils";

export function validateRates(v: ValidationCtx): void {
    for (const f of v.fields) {
        if (!isMultiField(f)) continue;

        const baseRates: Set<number> = new Set<number>();
        const contributingOptionIds: Set<string> = new Set<string>();

        for (const o of f.options ?? []) {
            const role: string = o.pricing_role ?? f.pricing_role ?? "base";
            if (role !== "base") continue;

            const sid: unknown = o.service_id;
            if (!isFiniteNumber(sid)) continue;

            const rate: unknown = (v.serviceMap as any)[sid]?.rate;
            if (isFiniteNumber(rate)) {
                baseRates.add(Number(rate));
                contributingOptionIds.add(o.id);
            }
        }

        if (baseRates.size > 1) {
            const affectedIds: string[] = [
                f.id,
                ...Array.from(contributingOptionIds),
            ];

            v.errors.push({
                code: "rate_mismatch_across_base",
                severity: "error",
                message: `Base options under field "${f.id}" resolve to different service rates.`,
                nodeId: f.id,
                details: withAffected(
                    {
                        fieldId: f.id,
                        rates: Array.from(baseRates.values()),
                        optionIds: Array.from(contributingOptionIds.values()),
                    },
                    affectedIds.length > 1 ? affectedIds : undefined,
                ),
            });
        }
    }
}
