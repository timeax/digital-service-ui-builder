// src/core/validate/steps/fallbacks.ts
import type { ValidationCtx } from "../shared";
import { collectFailedFallbacks } from "../../fallback";

export function validateFallbacks(v: ValidationCtx): void {
    const mode: string = v.options.fallbackSettings?.mode ?? "strict";
    if (!v.props.fallbacks) return;

    const diags = collectFailedFallbacks(v.props, v.options.serviceMap ?? {}, {
        ...v.options.fallbackSettings,
        mode: "dev",
    });

    if (mode !== "strict") return;

    for (const d of diags) {
        if (d.scope === "global") continue;

        const code =
            d.reason === "unknown_service"
                ? "fallback_unknown_service"
                : d.reason === "no_primary"
                  ? "fallback_no_primary"
                  : d.reason === "rate_violation"
                    ? "fallback_rate_violation"
                    : d.reason === "constraint_mismatch"
                      ? "fallback_constraint_mismatch"
                      : d.reason === "cycle"
                        ? "fallback_cycle"
                        : "fallback_bad_node";

        v.errors.push({
            code: code as any,
            nodeId: d.nodeId,
            details: {
                primary: d.primary,
                candidate: d.candidate,
                tagContext: d.tagContext,
                scope: d.scope,
            },
        });
    }
}
