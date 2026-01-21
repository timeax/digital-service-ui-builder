// src/core/validate/steps/identity.ts
import type { ValidationCtx } from "../shared";
import { hasAnyServiceOption, withAffected } from "../shared";

export function validateIdentity(v: ValidationCtx): void {
    const tags = v.tags;
    const fields = v.fields;

    // duplicate ids across tags + fields
    {
        const firstSeen: Map<string, string> = new Map<string, string>(); // id -> first kind ("tag"|"field")
        const seen: Set<string> = new Set<string>();

        for (const t of tags) {
            if (seen.has(t.id)) {
                v.errors.push({
                    code: "duplicate_id",
                    severity: "error",
                    message: `Duplicate id "${t.id}" found (tag).`,
                    nodeId: t.id,
                    // we only know the id itself; no other id to point at
                });
            } else {
                seen.add(t.id);
                firstSeen.set(t.id, "tag");
            }
        }

        for (const f of fields) {
            if (seen.has(f.id)) {
                const kind: string = firstSeen.get(f.id) ?? "tag/field";
                v.errors.push({
                    code: "duplicate_id",
                    severity: "error",
                    message: `Duplicate id "${f.id}" found (field) — already used by a ${kind}.`,
                    nodeId: f.id,
                });
            } else {
                seen.add(f.id);
                firstSeen.set(f.id, "field");
            }
        }
    }

    // tag labels unique + required
    {
        const seen: Map<string, string> = new Map<string, string>(); // label -> tagId

        for (const t of tags) {
            if (!t.label || !t.label.trim()) {
                v.errors.push({
                    code: "label_missing",
                    severity: "error",
                    message: `Tag "${t.id}" is missing a label.`,
                    nodeId: t.id,
                    details: { kind: "tag" },
                });
                continue;
            }

            const k: string = t.label;

            if (seen.has(k)) {
                const otherId: string | undefined = seen.get(k);
                v.errors.push({
                    code: "duplicate_tag_label",
                    severity: "error",
                    message: `Duplicate tag label "${k}" found on tag "${t.id}".`,
                    nodeId: t.id,
                    details: withAffected(
                        { other: otherId, label: k },
                        otherId ? [t.id, otherId] : undefined,
                    ),
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
                    severity: "error",
                    message: `Field "${f.id}" is missing a label.`,
                    nodeId: f.id,
                    details: { kind: "field" },
                });
            }

            const isUserInput: boolean = !!f.name && !hasAnyServiceOption(f);

            if (isUserInput && f.name) {
                const k: string = f.name;

                if (seenNames.has(k)) {
                    const otherId: string | undefined = seenNames.get(k);
                    v.errors.push({
                        code: "duplicate_field_name",
                        severity: "error",
                        message: `Duplicate field name "${k}" found on field "${f.id}".`,
                        nodeId: f.id,
                        details: withAffected(
                            { other: otherId, name: k },
                            otherId ? [f.id, otherId] : undefined,
                        ),
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
                    severity: "error",
                    message: `Option "${o.id}" (field "${f.id}") is missing a label.`,
                    nodeId: o.id,
                    details: { kind: "option", fieldId: f.id },
                });
            }
        }
    }
}
