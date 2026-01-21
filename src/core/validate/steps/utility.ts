// src/core/validate/steps/utility.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber, withAffected } from "../shared";

export function validateUtilityMarkers(v: ValidationCtx): void {
    const ALLOWED_UTILITY_MODES: Set<string> = new Set<string>([
        "flat",
        "per_quantity",
        "per_value",
        "percent",
    ]);

    // option-level
    for (const f of v.fields) {
        const optsArr = Array.isArray(f.options) ? f.options : [];
        for (const o of optsArr) {
            const role: string = o.pricing_role ?? f.pricing_role ?? "base";
            const hasService: boolean = isFiniteNumber(o.service_id);
            const util: unknown = (o.meta as any)?.utility;

            if (role === "utility" && hasService) {
                v.errors.push({
                    code: "utility_with_service_id",
                    severity: "error",
                    message: `Utility-priced option "${o.id}" (field "${f.id}") must not reference a service_id.`,
                    nodeId: o.id,
                    details: withAffected(
                        {
                            fieldId: f.id,
                            optionId: o.id,
                            service_id: o.service_id,
                        },
                        [f.id, o.id],
                    ),
                });
            }

            if (util) {
                const mode: unknown = (util as any).mode;
                const rate: unknown = (util as any).rate;

                if (!isFiniteNumber(rate)) {
                    v.errors.push({
                        code: "utility_missing_rate",
                        severity: "error",
                        message: `Utility definition for option "${o.id}" (field "${f.id}") is missing a valid rate.`,
                        nodeId: o.id,
                        details: withAffected(
                            { fieldId: f.id, optionId: o.id },
                            [f.id, o.id],
                        ),
                    });
                }

                if (!ALLOWED_UTILITY_MODES.has(String(mode))) {
                    v.errors.push({
                        code: "utility_invalid_mode",
                        severity: "error",
                        message: `Utility definition for option "${o.id}" (field "${f.id}") has invalid mode "${String(
                            mode,
                        )}".`,
                        nodeId: o.id,
                        details: withAffected(
                            { fieldId: f.id, optionId: o.id, mode },
                            [f.id, o.id],
                        ),
                    });
                }
            }
        }
    }

    // field-level
    for (const f of v.fields) {
        const util: unknown = (f.meta as any)?.utility;
        if (!util) continue;

        const mode: unknown = (util as any).mode;
        const rate: unknown = (util as any).rate;

        if (!isFiniteNumber(rate)) {
            v.errors.push({
                code: "utility_missing_rate",
                severity: "error",
                message: `Utility definition for field "${f.id}" is missing a valid rate.`,
                nodeId: f.id,
                details: withAffected({ fieldId: f.id }, [f.id]),
            });
        }

        if (!ALLOWED_UTILITY_MODES.has(String(mode))) {
            v.errors.push({
                code: "utility_invalid_mode",
                severity: "error",
                message: `Utility definition for field "${f.id}" has invalid mode "${String(
                    mode,
                )}".`,
                nodeId: f.id,
                details: withAffected({ fieldId: f.id, mode }, [f.id]),
            });
        }
    }
}
