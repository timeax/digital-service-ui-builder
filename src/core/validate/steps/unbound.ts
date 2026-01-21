// src/core/validate/steps/unbound.ts
import type { ValidationCtx } from "../shared";

export function validateUnboundFields(v: ValidationCtx): void {
    const boundFieldIds: Set<string> = new Set<string>();

    for (const f of v.fields) {
        if (f.bind_id) boundFieldIds.add(f.id);
    }

    const includedByTag: Set<string> = new Set<string>();
    for (const t of v.tags) {
        for (const id of t.includes ?? []) includedByTag.add(id);
    }

    const includedByOption: Set<string> = new Set<string>();
    for (const arr of Object.values(v.props.includes_for_buttons ?? {})) {
        for (const id of arr ?? []) includedByOption.add(id);
    }

    for (const f of v.fields) {
        if (
            !boundFieldIds.has(f.id) &&
            !includedByTag.has(f.id) &&
            !includedByOption.has(f.id)
        ) {
            v.errors.push({ code: "field_unbound", nodeId: f.id });
        }
    }
}
