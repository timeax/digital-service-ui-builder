// src/core/validate/steps/structure.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber } from "../shared";

export function validateStructure(v: ValidationCtx): void {
    const tags = v.tags;
    const fields = v.fields;

    // root present
    if (!tags.some((t) => t.id === "root")) {
        v.errors.push({ code: "root_missing" });
    }

    // cycles in tag parentage
    const visiting: Set<string> = new Set<string>();
    const visited: Set<string> = new Set<string>();

    const hasCycleFrom = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;

        visiting.add(id);

        const parent: string | undefined = v.tagById.get(id)?.bind_id;
        if (parent && v.tagById.has(parent) && hasCycleFrom(parent))
            return true;

        visiting.delete(id);
        visited.add(id);
        return false;
    };

    for (const t of tags) {
        if (hasCycleFrom(t.id)) {
            v.errors.push({ code: "cycle_in_tags", nodeId: t.id });
            break;
        }
    }

    // tag.bind_id must point to existing tag (if present)
    for (const t of tags) {
        if (t.bind_id && !v.tagById.has(t.bind_id)) {
            v.errors.push({
                code: "bad_bind_reference",
                nodeId: t.id,
                details: { ref: t.bind_id },
            });
        }
    }

    // field.bind_id must reference tags
    for (const f of fields) {
        const b = f.bind_id;

        if (Array.isArray(b)) {
            for (const id of b) {
                if (!v.tagById.has(id)) {
                    v.errors.push({
                        code: "bad_bind_reference",
                        nodeId: f.id,
                        details: { ref: id },
                    });
                }
            }
        } else if (typeof b === "string") {
            if (!v.tagById.has(b)) {
                v.errors.push({
                    code: "bad_bind_reference",
                    nodeId: f.id,
                    details: { ref: b },
                });
            }
        }
    }

    void isFiniteNumber; // keeps parity if you had helper usage in the original file
}
