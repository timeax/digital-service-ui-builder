// src/core/validate/steps/rates.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber } from "../shared";
import { isMultiField } from "@/utils";

export function validateRates(v: ValidationCtx): void {
    for (const f of v.fields) {
        if (!isMultiField(f)) continue;

        const baseRates: Set<number> = new Set<number>();

        for (const o of f.options ?? []) {
            const role: string = o.pricing_role ?? f.pricing_role ?? "base";
            if (role !== "base") continue;

            const sid: unknown = o.service_id;
            if (!isFiniteNumber(sid)) continue;

            const rate: unknown = (v.serviceMap as any)[sid]?.rate;
            if (isFiniteNumber(rate)) baseRates.add(Number(rate));
        }

        if (baseRates.size > 1) {
            v.errors.push({ code: "rate_mismatch_across_base", nodeId: f.id });
        }
    }
}
