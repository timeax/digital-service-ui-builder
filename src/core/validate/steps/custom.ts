// src/core/validate/steps/custom.ts
import type { ValidationCtx } from "../shared";

export function validateCustomFields(v: ValidationCtx): void {
    for (const f of v.fields) {
        if (f.type !== "custom") continue;

        if (!f.component || !String(f.component).trim()) {
            v.errors.push({ code: "custom_component_missing", nodeId: f.id });
        }
    }
}
