import type { DgpServiceMap, DgpServiceCapability } from "../schema/provider";
import type { FallbackSettings } from "../schema/validation";

/**
 * Safely convert unknown to a finite number. Returns NaN if not finite.
 */
export function toFiniteNumber(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Check if a candidate service satisfies the active tag constraints.
 * Only flags explicitly set to true are treated as required.
 */
export function constraintFitOk(
    svcMap: DgpServiceMap,
    candidate: string | number,
    constraints: Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>,
): boolean {
    const cap: DgpServiceCapability | undefined = svcMap[Number(candidate)];
    if (!cap) return false;

    if (constraints.dripfeed === true && !cap.dripfeed) return false;
    if (constraints.refill === true && !cap.refill) return false;
    return !(constraints.cancel === true && !cap.cancel);

}

/**
 * Evaluate candidate rate against primary according to the fallback rate policy.
 * If either service is missing or rates are not finite, returns false.
 */
export function rateOk(
    svcMap: DgpServiceMap,
    candidate: string | number,
    primary: string | number,
    policy: FallbackSettings,
): boolean {
    const cand = svcMap[Number(candidate)];
    const prim = svcMap[Number(primary)];
    if (!cand || !prim) return false;

    const cRate = toFiniteNumber(cand.rate);
    const pRate = toFiniteNumber(prim.rate);
    if (!Number.isFinite(cRate) || !Number.isFinite(pRate)) return false;

    const rp = policy.ratePolicy ?? { kind: "lte_primary" as const };
    switch (rp.kind) {
        case "lte_primary":
            return cRate <= pRate;
        case "within_pct": {
            const pct = Math.max(0, rp.pct ?? 0);
            return cRate <= pRate * (1 + pct / 100);
        }
        case "at_least_pct_lower": {
            const pct = Math.max(0, rp.pct ?? 0);
            return cRate <= pRate * (1 - pct / 100);
        }
        default:
            return false;
    }
}
