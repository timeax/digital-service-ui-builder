// src/core/validate/steps/constraints.ts
import type { ValidationCtx } from "../shared";
import { isFiniteNumber, isServiceFlagEnabled } from "../shared";

type ConstraintBag = Record<string, boolean | undefined>;

function constraintKeysInChain(v: ValidationCtx, tagId: string): string[] {
    const keys: string[] = [];
    const seenKeys: Set<string> = new Set<string>();

    let cur: string | undefined = tagId;
    const seenTags: Set<string> = new Set<string>();

    while (cur && !seenTags.has(cur)) {
        seenTags.add(cur);

        const t = v.tagById.get(cur);
        const c: unknown = t?.constraints;

        if (c && typeof c === "object") {
            for (const k of Object.keys(c as any)) {
                if (!seenKeys.has(k)) {
                    seenKeys.add(k);
                    keys.push(k);
                }
            }
        }

        cur = t?.bind_id;
    }

    return keys;
}

function effectiveConstraints(v: ValidationCtx, tagId: string): ConstraintBag {
    const out: ConstraintBag = {};
    const keys: string[] = constraintKeysInChain(v, tagId);

    for (const key of keys) {
        let cur: string | undefined = tagId;
        const seen: Set<string> = new Set<string>();

        while (cur && !seen.has(cur)) {
            seen.add(cur);

            const t = v.tagById.get(cur);
            const val: unknown = (t?.constraints as any)?.[key];

            if (val === true || val === false) {
                out[key] = val;
                break;
            }

            cur = t?.bind_id;
        }
    }

    return out;
}

export function validateConstraints(v: ValidationCtx): void {
    // Enforce tag constraints on visible options' services
    for (const t of v.tags) {
        const eff: ConstraintBag = effectiveConstraints(v, t.id);
        const hasAnyRequired: boolean = Object.values(eff).some(
            (x) => x === true,
        );
        if (!hasAnyRequired) continue;

        const visible = v.fieldsVisibleUnder(t.id);

        for (const f of visible) {
            for (const o of f.options ?? []) {
                if (!isFiniteNumber(o.service_id)) continue;

                const svc: unknown = (v.serviceMap as any)[o.service_id];
                if (!svc || typeof svc !== "object") continue;

                for (const [k, val] of Object.entries(eff)) {
                    if (val === true && !isServiceFlagEnabled(svc as any, k)) {
                        v.errors.push({
                            code: "unsupported_constraint",
                            nodeId: t.id,
                            details: { flag: k, serviceId: o.service_id },
                        });
                    }
                }
            }
        }
    }

    // Unsupported constraint vs tag's mapped service capabilities
    for (const t of v.tags) {
        const sid: unknown = t.service_id;
        if (!isFiniteNumber(sid)) continue;

        const svc: unknown = (v.serviceMap as any)[Number(sid)];
        if (!svc || typeof svc !== "object") continue;

        const eff: ConstraintBag = effectiveConstraints(v, t.id);

        for (const [k, val] of Object.entries(eff)) {
            if (val === true && !isServiceFlagEnabled(svc as any, k)) {
                v.errors.push({
                    code: "unsupported_constraint",
                    nodeId: t.id,
                    details: { flag: k, serviceId: sid },
                });
            }
        }
    }

    // constraint_overridden diagnostics
    for (const t of v.tags) {
        const ov: unknown = t.constraints_overrides;
        if (!ov || typeof ov !== "object") continue;

        for (const k of Object.keys(ov as Record<string, unknown>)) {
            const row: any = (ov as any)[k];
            if (!row) continue;

            const from: boolean = !!row.from;
            const to: boolean = !!row.to;
            const origin: string = String(row.origin ?? "");

            v.errors.push({
                code: "constraint_overridden",
                nodeId: t.id,
                details: { flag: k, from, to, origin, severity: "warning" },
            } as any);
        }
    }
}
