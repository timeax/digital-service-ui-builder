// src/core/validate/steps/visibility.ts
import type { Field } from "@/schema";
import type { ValidationCtx } from "../shared";
import { isBoundTo, isFiniteNumber } from "../shared";

export function createFieldsVisibleUnder(
    v: ValidationCtx,
): (tagId: string) => Field[] {
    return (tagId: string): Field[] => {
        const tag = v.tagById.get(tagId);
        const includesTag: Set<string> = new Set<string>(tag?.includes ?? []);
        const excludesTag: Set<string> = new Set<string>(tag?.excludes ?? []);

        const incForOpt: Record<string, string[]> =
            v.props.includes_for_buttons ?? {};
        const excForOpt: Record<string, string[]> =
            v.props.excludes_for_buttons ?? {};

        const includesOpt: Set<string> = new Set<string>();
        const excludesOpt: Set<string> = new Set<string>();

        for (const key of v.selectedKeys) {
            for (const id of incForOpt[key] ?? []) includesOpt.add(id);
            for (const id of excForOpt[key] ?? []) excludesOpt.add(id);
        }

        const merged: Map<string, Field> = new Map<string, Field>();

        for (const f of v.fields) {
            if (isBoundTo(f, tagId)) merged.set(f.id, f);
            if (includesTag.has(f.id)) merged.set(f.id, f);
            if (includesOpt.has(f.id)) merged.set(f.id, f);
        }

        for (const id of excludesTag) merged.delete(id);
        for (const id of excludesOpt) merged.delete(id);

        return Array.from(merged.values());
    };
}

export function validateVisibility(v: ValidationCtx): void {
    // duplicate visible labels (selection-aware)
    for (const t of v.tags) {
        const visible: Field[] = v.fieldsVisibleUnder(t.id);
        const seen: Map<string, string> = new Map<string, string>();

        for (const f of visible) {
            const label: string = (f.label ?? "").trim();
            if (!label) continue;

            if (seen.has(label)) {
                v.errors.push({
                    code: "duplicate_visible_label",
                    nodeId: f.id,
                    details: { tagId: t.id, other: seen.get(label) },
                });
            } else {
                seen.set(label, f.id);
            }
        }
    }

    // Quantity marker rule: at most one marker per visible group (tag)
    for (const t of v.tags) {
        const visible: Field[] = v.fieldsVisibleUnder(t.id);
        const markers: string[] = [];

        for (const f of visible) {
            const q: unknown = (f.meta as any)?.quantity;
            if (q) markers.push(f.id);
        }

        if (markers.length > 1) {
            v.errors.push({
                code: "quantity_multiple_markers",
                nodeId: t.id,
                details: { tagId: t.id, markers },
            });
        }
    }

    // utility_without_base per visible tag group (selection-aware)
    for (const t of v.tags) {
        const visible: Field[] = v.fieldsVisibleUnder(t.id);

        let hasBase: boolean = false;
        let hasUtility: boolean = false;
        const utilityOptionIds: string[] = [];

        for (const f of visible) {
            for (const o of f.options ?? []) {
                if (!isFiniteNumber(o.service_id)) continue;

                const role: string = o.pricing_role ?? f.pricing_role ?? "base";
                if (role === "base") hasBase = true;
                else if (role === "utility") {
                    hasUtility = true;
                    utilityOptionIds.push(o.id);
                }
            }
        }

        if (hasUtility && !hasBase) {
            v.errors.push({
                code: "utility_without_base",
                nodeId: t.id,
                details: { utilityOptionIds },
            });
        }
    }
}
