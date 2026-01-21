// src/core/utils/fallback.ts
import type {
    ServiceProps,
    ServiceFallback,
    ServiceIdRef,
    NodeIdRef,
} from "@/schema";
import type { DgpServiceCapability, DgpServiceMap } from "@/schema/provider";
import type { FallbackSettings } from "@/schema/validation";

export type FailedFallbackContext = {
    scope: "node" | "global";
    nodeId?: string; // when scope='node'
    primary: ServiceIdRef;
    candidate: ServiceIdRef;
    tagContext?: string; // tag.id when evaluating constraints
    reason:
        | "unknown_service"
        | "no_primary"
        | "rate_violation"
        | "constraint_mismatch"
        | "cycle"
        | "no_tag_context";
    details?: Record<string, unknown>;
};

const DEFAULT_SETTINGS: Required<FallbackSettings> = {
    requireConstraintFit: true,
    ratePolicy: { kind: "lte_primary" },
    selectionStrategy: "priority",
    mode: "strict",
};

export function resolveServiceFallback(params: {
    primary: ServiceIdRef;
    nodeId?: NodeIdRef; // prefer node-scoped first if provided
    tagId?: string; // constraints context (if known)
    services: DgpServiceMap;
    fallbacks?: ServiceFallback;
    settings?: FallbackSettings;
    props: ServiceProps;
}): ServiceIdRef | null {
    const s = { ...DEFAULT_SETTINGS, ...(params.settings ?? {}) };
    const { primary, nodeId, tagId, services } = params;
    const fb = params.fallbacks ?? {};
    const tried: ServiceIdRef[] = [];

    const lists: ServiceIdRef[][] = [];
    if (nodeId && fb.nodes?.[nodeId]) lists.push(fb.nodes[nodeId]);
    if (fb.global?.[primary]) lists.push(fb.global[primary]);

    const primaryRate = rateOf(services, primary);

    for (const list of lists) {
        for (const cand of list) {
            if (tried.includes(cand)) continue;
            tried.push(cand);

            const candCap = services[Number(cand)] ?? services[cand as any];
            if (!candCap) continue;

            if (!passesRate(s.ratePolicy, primaryRate, candCap.rate)) continue;
            if (s.requireConstraintFit && tagId) {
                const ok = satisfiesTagConstraints(tagId, params, candCap);
                if (!ok) continue;
            }
            return cand;
        }
    }
    return null;
}

export function collectFailedFallbacks(
    props: ServiceProps,
    services: DgpServiceMap,
    settings?: FallbackSettings,
): FailedFallbackContext[] {
    const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    const out: FailedFallbackContext[] = [];
    const fb = props.fallbacks ?? {};
    const primaryRate = (p: ServiceIdRef) => rateOf(services, p);

    // Node-scoped (tags or options)
    for (const [nodeId, list] of Object.entries(fb.nodes ?? {})) {
        const { primary, tagContexts } = primaryForNode(props, nodeId);
        if (!primary) {
            out.push({
                scope: "node",
                nodeId,
                primary: "" as any,
                candidate: "" as any,
                reason: "no_primary",
            });
            continue;
        }
        for (const cand of list) {
            const cap = getCap(services, cand);
            if (!cap) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "unknown_service",
                });
                continue;
            }
            if (String(cand) === String(primary)) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "cycle",
                });
                continue;
            }
            if (!passesRate(s.ratePolicy, primaryRate(primary), cap.rate)) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "rate_violation",
                });
                continue;
            }
            // Tag contexts
            if (tagContexts.length === 0) {
                out.push({
                    scope: "node",
                    nodeId,
                    primary,
                    candidate: cand,
                    reason: "no_tag_context",
                });
                continue;
            }
            let anyPass = false;
            let anyFail = false;
            for (const tagId of tagContexts) {
                const ok = s.requireConstraintFit
                    ? satisfiesTagConstraints(tagId, { services, props }, cap)
                    : true;
                if (ok) anyPass = true;
                else {
                    anyFail = true;
                    out.push({
                        scope: "node",
                        nodeId,
                        primary,
                        candidate: cand,
                        tagContext: tagId,
                        reason: "constraint_mismatch",
                    });
                }
            }
            // If none passed, we already added per-context mismatches above
            void anyPass;
            void anyFail;
        }
    }

    // Global (soft; no tag context)
    for (const [primary, list] of Object.entries(fb.global ?? {})) {
        for (const cand of list) {
            const cap = getCap(services, cand);
            if (!cap) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "unknown_service",
                });
                continue;
            }
            if (String(cand) === String(primary)) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "cycle",
                });
                continue;
            }
            if (!passesRate(s.ratePolicy, primaryRate(primary), cap.rate)) {
                out.push({
                    scope: "global",
                    primary,
                    candidate: cand,
                    reason: "rate_violation",
                });
            }
        }
    }
    return out;
}

/* ───────────────────────── helpers ───────────────────────── */

function rateOf(
    map: DgpServiceMap,
    id: ServiceIdRef | undefined,
): number | undefined {
    if (id === undefined || id === null) return undefined;
    const c = getCap(map, id);
    return c?.rate ?? undefined;
}

function passesRate(
    policy: Required<FallbackSettings>["ratePolicy"],
    primaryRate?: number,
    candRate?: number,
): boolean {
    if (typeof candRate !== "number" || !Number.isFinite(candRate))
        return false;
    if (typeof primaryRate !== "number" || !Number.isFinite(primaryRate))
        return false;
    switch (policy.kind) {
        case "lte_primary":
            return candRate <= primaryRate;
        case "within_pct":
            return candRate <= primaryRate * (1 + policy.pct / 100);
        case "at_least_pct_lower":
            return candRate <= primaryRate * (1 - policy.pct / 100);
    }
}

function getCap(
    map: DgpServiceMap,
    id: ServiceIdRef,
): DgpServiceCapability | undefined {
    // Keep the old behavior, but avoid NaN poisoning lookups.
    const direct: DgpServiceCapability | undefined = (map as any)[id];
    if (direct) return direct;

    const strKey: string = String(id);
    const byStr: DgpServiceCapability | undefined = (map as any)[strKey];
    if (byStr) return byStr;

    const n: number =
        typeof id === "number"
            ? id
            : typeof id === "string"
              ? Number(id)
              : Number.NaN;

    if (Number.isFinite(n)) {
        const byNum: DgpServiceCapability | undefined = (map as any)[n];
        if (byNum) return byNum;
    }

    return undefined;
}

function isCapFlagEnabled(cap: DgpServiceCapability, flagId: string): boolean {
    // New structure: flags[flagId].enabled
    const fromFlags: boolean | undefined = cap.flags?.[flagId]?.enabled;
    if (fromFlags === true) return true;
    if (fromFlags === false) return false;

    // Soft-compat during migration: if legacy boolean exists on cap, respect it.
    const legacy: unknown = (cap as any)[flagId];
    return legacy === true;
}

function satisfiesTagConstraints(
    tagId: string,
    ctx: Readonly<{ props: ServiceProps; services: DgpServiceMap }>,
    cap: DgpServiceCapability,
): boolean {
    const tag = ctx.props.filters.find((t) => t.id === tagId);
    const eff: Record<string, unknown> | undefined = tag?.constraints as any; // effective constraints (propagated)
    if (!eff) return true;

    // Enforce only keys explicitly set TRUE at the tag; false/undefined => no requirement.
    for (const [key, value] of Object.entries(eff)) {
        if (value === true && !isCapFlagEnabled(cap, key)) {
            return false;
        }
    }

    return true;
}

function primaryForNode(
    props: ServiceProps,
    nodeId: string,
): {
    primary?: ServiceIdRef;
    tagContexts: string[];
    reasonNoPrimary?: string;
} {
    // Tag node?
    const tag = props.filters.find((t) => t.id === nodeId);
    if (tag) {
        return { primary: tag.service_id as any, tagContexts: [tag.id] };
    }
    // Option node: locate its parent field
    const field = props.fields.find(
        (f) =>
            Array.isArray(f.options) && f.options.some((o) => o.id === nodeId),
    );
    if (!field) return { tagContexts: [], reasonNoPrimary: "no_parent_field" };
    const opt = field.options!.find((o) => o.id === nodeId)!;
    const contexts = bindIdsToArray(field.bind_id);
    return { primary: opt.service_id as any, tagContexts: contexts };
}

function bindIdsToArray(bind: string | string[] | undefined): string[] {
    if (!bind) return [];
    return Array.isArray(bind) ? bind.slice() : [bind];
}

/**
 * Return all fallback candidates that are eligible for the given primary,
 * respecting:
 *  - node-scoped list first (if nodeId provided), then global list for `primary`
 *  - rate policy vs. primary
 *  - (optional) tag constraint fit, only when tagId is provided and requireConstraintFit=true
 *  - excludes (including primary automatically)
 *  - selectionStrategy: 'priority' keeps list order, 'cheapest' sorts by rate asc
 *  - unique (dedupe) and optional limit
 */
export function getEligibleFallbacks(params: {
    primary: ServiceIdRef;
    nodeId?: NodeIdRef; // prefer node-scoped list first
    tagId?: string; // constraints context (if known)
    services: DgpServiceMap;
    fallbacks?: ServiceFallback;
    settings?: FallbackSettings;
    props: ServiceProps;
    exclude?: Array<ServiceIdRef>; // additional ids to ignore
    unique?: boolean; // default true
    limit?: number; // optional cap
}): ServiceIdRef[] {
    const s = { ...DEFAULT_SETTINGS, ...(params.settings ?? {}) };
    const { primary, nodeId, tagId, services } = params;
    const fb = params.fallbacks ?? {};
    const excludes = new Set<string>((params.exclude ?? []).map(String));
    excludes.add(String(primary)); // never return the primary itself
    const unique = params.unique ?? true;

    // Gather source lists: node → global
    const lists: ServiceIdRef[][] = [];
    if (nodeId && fb.nodes?.[nodeId]) lists.push(fb.nodes[nodeId]);
    if (fb.global?.[primary]) lists.push(fb.global[primary]);

    if (!lists.length) return [];

    const primaryRate = rateOf(services, primary);
    const seen = new Set<string>();
    const eligible: ServiceIdRef[] = [];

    for (const list of lists) {
        for (const cand of list) {
            const key = String(cand);
            if (excludes.has(key)) continue;
            if (unique && seen.has(key)) continue;
            seen.add(key);

            const cap = getCap(services, cand);
            if (!cap) continue;

            // Rate policy must pass
            if (!passesRate(s.ratePolicy, primaryRate, cap.rate)) continue;

            // Tag constraint fit is only enforced if we know tagId and setting requires it
            if (s.requireConstraintFit && tagId) {
                const ok = satisfiesTagConstraints(
                    tagId,
                    { props: params.props, services },
                    cap,
                );
                if (!ok) continue;
            }

            eligible.push(cand);
        }
    }

    // Selection strategy
    if (s.selectionStrategy === "cheapest") {
        eligible.sort((a, b) => {
            const ra = rateOf(services, a) ?? Infinity;
            const rb = rateOf(services, b) ?? Infinity;
            return ra - rb;
        });
    }
    // 'priority' keeps original order

    // Optional limit
    if (typeof params.limit === "number" && params.limit >= 0) {
        return eligible.slice(0, params.limit);
    }
    return eligible;
}
