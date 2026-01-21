// src/core/validate/steps/identity.ts
import type { ValidationCtx } from "../shared";
import { hasAnyServiceOption } from "../shared";

export function validateIdentity(v: ValidationCtx): void {
    const tags = v.tags;
    const fields = v.fields;

    // duplicate ids across tags + fields
    {
        const seen: Set<string> = new Set<string>();

        for (const t of tags) {
            if (seen.has(t.id))
                v.errors.push({ code: "duplicate_id", nodeId: t.id });
            seen.add(t.id);
        }

        for (const f of fields) {
            if (seen.has(f.id))
                v.errors.push({ code: "duplicate_id", nodeId: f.id });
            seen.add(f.id);
        }
    }

    // tag labels unique + required
    {
        const seen: Map<string, string> = new Map<string, string>(); // label -> tagId

        for (const t of tags) {
            if (!t.label || !t.label.trim()) {
                v.errors.push({
                    code: "label_missing",
                    nodeId: t.id,
                    details: { kind: "tag" },
                });
            }

            const k: string = t.label;
            if (seen.has(k)) {
                v.errors.push({
                    code: "duplicate_tag_label",
                    nodeId: t.id,
                    details: { other: seen.get(k) },
                });
            } else {
                seen.set(k, t.id);
            }
        }
    }

    // field labels required; names unique among user-input fields
    {
        const seenNames: Map<string, string> = new Map<string, string>(); // name -> fieldId

        for (const f of fields) {
            if (!f.label || !f.label.trim()) {
                v.errors.push({
                    code: "label_missing",
                    nodeId: f.id,
                    details: { kind: "field" },
                });
            }

            const isUserInput: boolean = !!f.name && !hasAnyServiceOption(f);
            if (isUserInput && f.name) {
                const k: string = f.name;
                if (seenNames.has(k)) {
                    v.errors.push({
                        code: "duplicate_field_name",
                        nodeId: f.id,
                        details: { other: seenNames.get(k) },
                    });
                } else {
                    seenNames.set(k, f.id);
                }
            }
        }
    }

    // option labels required
    for (const f of fields) {
        for (const o of f.options ?? []) {
            if (!o.label || !o.label.trim()) {
                v.errors.push({
                    code: "label_missing",
                    nodeId: o.id,
                    details: { kind: "option", fieldId: f.id },
                });
            }
        }
    }
}
