// src/core/validate/steps/fallbacks.ts
import type { ValidationCtx } from "../shared";
import { withAffected } from "../shared";
import { collectFailedFallbacks } from "@/core";

function codeForReason(
    reason: string,
):
    | "fallback_unknown_service"
    | "fallback_no_primary"
    | "fallback_rate_violation"
    | "fallback_constraint_mismatch"
    | "fallback_cycle"
    | "fallback_bad_node" {
    switch (reason) {
        case "unknown_service":
            return "fallback_unknown_service";
        case "no_primary":
            return "fallback_no_primary";
        case "rate_violation":
            return "fallback_rate_violation";
        case "constraint_mismatch":
            return "fallback_constraint_mismatch";
        case "cycle":
            return "fallback_cycle";
        default:
            return "fallback_bad_node";
    }
}

function messageFor(
    code:
        | "fallback_unknown_service"
        | "fallback_no_primary"
        | "fallback_rate_violation"
        | "fallback_constraint_mismatch"
        | "fallback_cycle"
        | "fallback_bad_node",
    d: {
        nodeId?: string;
        primary?: unknown;
        candidate?: unknown;
        tagContext?: unknown;
        scope?: unknown;
    },
): string {
    const n = d.nodeId ? `node "${String(d.nodeId)}"` : "node";
    switch (code) {
        case "fallback_unknown_service":
            return `Fallback candidate "${String(
                d.candidate,
            )}" is unknown for ${n}.`;
        case "fallback_no_primary":
            return `Fallback rule has no primary service for ${n}.`;
        case "fallback_rate_violation":
            return `Fallback candidate "${String(
                d.candidate,
            )}" violates the base-rate rules for ${n}.`;
        case "fallback_constraint_mismatch":
            return `Fallback candidate "${String(
                d.candidate,
            )}" does not satisfy required constraints for ${n}.`;
        case "fallback_cycle":
            return `Fallback rules contain a cycle for ${n}.`;
        default:
            return `Fallback rule is invalid for ${n}.`;
    }
}

export function validateFallbacks(v: ValidationCtx): void {
    const mode: string = v.options.fallbackSettings?.mode ?? "strict";
    if (!v.props.fallbacks) return;

    // collect non-fatal diagnostics first
    const diags = collectFailedFallbacks(v.props, v.options.serviceMap ?? {}, {
        ...v.options.fallbackSettings,
        mode: "dev",
    });

    if (mode !== "strict") return;

    for (const d of diags) {
        if (d.scope === "global") continue;

        const code = codeForReason(
            String((d as any).reason ?? "fallback_bad_node"),
        );

        const nodeId: string | undefined = (d as any).nodeId
            ? String((d as any).nodeId)
            : undefined;

        // Best-effort affected ids:
        // - Always include nodeId (if present)
        // - Include tagContext if it looks like a tag id (string)
        const tagContext: unknown = (d as any).tagContext;
        const affectedIds: string[] = [];
        if (nodeId) affectedIds.push(nodeId);
        if (
            typeof tagContext === "string" &&
            tagContext &&
            tagContext !== nodeId
        )
            affectedIds.push(tagContext);

        v.errors.push({
            code,
            severity: "error",
            message: messageFor(code, {
                nodeId,
                primary: (d as any).primary,
                candidate: (d as any).candidate,
                tagContext,
                scope: (d as any).scope,
            }),
            nodeId,
            details: withAffected(
                {
                    primary: (d as any).primary,
                    candidate: (d as any).candidate,
                    tagContext,
                    scope: (d as any).scope,
                },
                affectedIds.length > 1 ? affectedIds : undefined,
            ),
        });
    }
}
