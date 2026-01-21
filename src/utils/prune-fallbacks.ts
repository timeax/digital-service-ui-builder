// src/utils/prune-fallbacks.ts
import type { ServiceProps, ServiceIdRef } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { FallbackSettings } from "@/schema/validation";
import { collectFailedFallbacks } from "@/core";

export type PrunedFallback = {
    nodeId: string;
    candidate: ServiceIdRef;
    reasons: string[];        // aggregated reasons that caused full-context failure
    contexts?: string[];      // tag contexts considered (for option nodes)
};

export type PruneResult = {
    props: ServiceProps;
    removed: PrunedFallback[];
};

/**
 * Remove node-scoped fallback candidates that fail in ALL relevant contexts.
 * - Tag node: single context (the tag itself)
 * - Option node: contexts = parent field's bind_id tags
 * - Global fallbacks are NEVER pruned here (soft by design)
 */
export function pruneInvalidNodeFallbacks(
    props: ServiceProps,
    services: DgpServiceMap,
    settings?: FallbackSettings
): PruneResult {
    const fb = props.fallbacks;
    if (!fb?.nodes || Object.keys(fb.nodes).length === 0) {
        return { props, removed: [] };
    }

    // 1) Build node → contexts (tag ids) and primary lookup
    const nodeContexts = new Map<string, string[]>();
    const nodePrimary = new Map<string, ServiceIdRef | undefined>();

    for (const nodeId of Object.keys(fb.nodes)) {
        const tag = props.filters.find(t => t.id === nodeId);
        if (tag) {
            nodeContexts.set(nodeId, [tag.id]);
            nodePrimary.set(nodeId, tag.service_id as any);
            continue;
        }
        // option node: locate parent field
        const field = props.fields.find(f => Array.isArray(f.options) && f.options.some(o => o.id === nodeId));
        if (field) {
            const contexts = toBindArray(field.bind_id);
            nodeContexts.set(nodeId, contexts);
            const opt = field.options!.find(o => o.id === nodeId)!;
            nodePrimary.set(nodeId, opt.service_id as any);
            continue;
        }
        // unknown node id → treat as no contexts & no primary
        nodeContexts.set(nodeId, []);
        nodePrimary.set(nodeId, undefined);
    }

    // 2) Gather diagnostics (per context). We use dev mode collection to get granular reasons.
    const diags = collectFailedFallbacks(props, services, { ...settings, mode: 'dev' });

    // 3) Decide which (nodeId, candidate) pairs fail in ALL contexts
    const failuresByPair = new Map<string, { reasons: Set<string>; contexts: Set<string> }>();
    const totalContextsByNode = new Map<string, number>();

    for (const [nodeId, ctxs] of nodeContexts.entries()) {
        totalContextsByNode.set(nodeId, Math.max(1, ctxs.length)); // at least 1 for tag/no-context cases
    }

    for (const d of diags) {
        if (d.scope !== 'node') continue;
        const key = `${d.nodeId}::${String(d.candidate)}`;
        let rec = failuresByPair.get(key);
        if (!rec) {
            rec = { reasons: new Set<string>(), contexts: new Set<string>() };
            failuresByPair.set(key, rec);
        }
        rec.reasons.add(d.reason);
        if (d.tagContext) rec.contexts.add(d.tagContext);
        // For node-level reasons not tied to a context, mark all contexts as failed by leaving contexts set empty;
        // we'll interpret empty-but-has-reasons as global failure later when totals == 1.
    }

    // 4) Build a pruned copy of fallbacks.nodes
    const prunedNodes: Record<string, ServiceIdRef[]> = {};
    const removed: PrunedFallback[] = [];

    for (const [nodeId, list] of Object.entries(fb.nodes)) {
        const contexts = nodeContexts.get(nodeId) ?? [];
        const totalContexts = Math.max(1, contexts.length);
        const keep: ServiceIdRef[] = [];

        for (const cand of list) {
            const key = `${nodeId}::${String(cand)}`;
            const rec = failuresByPair.get(key);

            // Not present in failures → keep
            if (!rec) {
                keep.push(cand);
                continue;
            }

            const failedContextsCount = rec.contexts.size > 0 ? rec.contexts.size : totalContexts;
            const failsAll = failedContextsCount >= totalContexts;

            if (failsAll) {
                removed.push({
                    nodeId,
                    candidate: cand,
                    reasons: Array.from(rec.reasons),
                    contexts: contexts.length ? contexts.slice() : undefined,
                });
            } else {
                keep.push(cand); // passes in at least one context
            }
        }

        if (keep.length) prunedNodes[nodeId] = keep;
    }

    const outProps: ServiceProps = {
        ...props,
        fallbacks: {
            ...(props.fallbacks?.global ? { global: props.fallbacks!.global } : {}),
            ...(Object.keys(prunedNodes).length ? { nodes: prunedNodes } : {}),
        }
    };

    return { props: outProps, removed };
}

/* ───────────────────────── helpers ───────────────────────── */

function toBindArray(bind: string | string[] | undefined): string[] {
    if (!bind) return [];
    return Array.isArray(bind) ? bind.slice() : [bind];
}