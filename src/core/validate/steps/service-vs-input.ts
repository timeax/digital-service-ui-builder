// src/core/validate/steps/service-vs-input.ts
import type { ValidationCtx } from "../shared";
import { hasAnyServiceOption } from "../shared";

export function validateServiceVsUserInput(v: ValidationCtx): void {
    for (const f of v.fields) {
        const anySvc: boolean = hasAnyServiceOption(f);
        const hasName: boolean = !!(f.name && f.name.trim());

        if (f.type === "custom" && anySvc) {
            v.errors.push({
                code: "user_input_field_has_service_option",
                nodeId: f.id,
                details: { reason: "custom_cannot_map_service" },
            });
        }

        if (!hasName) {
            if (!anySvc) {
                v.errors.push({
                    code: "service_field_missing_service_id",
                    nodeId: f.id,
                });
            }
        } else {
            if (anySvc) {
                v.errors.push({
                    code: "user_input_field_has_service_option",
                    nodeId: f.id,
                });
            }
        }
    }
}
