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
                severity: "error",
                message: `Custom field "${f.id}" cannot map service options.`,
                nodeId: f.id,
                details: { reason: "custom_cannot_map_service" },
            });
        }

        if (!hasName) {
            // treated as service-backed → require at least one service option
            if (!anySvc) {
                v.errors.push({
                    code: "service_field_missing_service_id",
                    severity: "error",
                    message: `Service-backed field "${f.id}" has no "name" and must provide at least one option with a service_id.`,
                    nodeId: f.id,
                });
            }
        } else {
            // user-input → options must not carry service_id
            if (anySvc) {
                v.errors.push({
                    code: "user_input_field_has_service_option",
                    severity: "error",
                    message: `User-input field "${f.id}" has a name and must not include any options with service_id.`,
                    nodeId: f.id,
                });
            }
        }
    }
}
