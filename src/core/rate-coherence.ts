import { RatePolicy } from "../schema/validation";
import { Builder } from "./builder";
import { DgpServiceCapability, DgpServiceMap } from "../schema/provider";
import { Field, PricingRole, ServiceProps, Tag } from "../schema";

type BaseCandidate = {
    kind: "field" | "option";
    id: string;
    label?: string;
    service_id: number;
    rate: number;
};

/** Result for each violation discovered during deep simulation. */
export type RateCoherenceDiagnostic = {
    scope: "visible_group";
    tagId: string;
    /** The “primary” used for comparison in this simulation:
     *  anchor service if present; otherwise, the first base service among simulated candidates.
     *  (Tag service is never used as primary.)
     */
    primary: BaseCandidate;
    /** The item that violated the policy against the primary. */
    offender: {
        kind: "field" | "option";
        id: string;
        label?: string;
        service_id: number;
        rate: number;
    };
    policy: RatePolicy["kind"];
    policyPct?: number; // for within_pct / at_least_pct_lower
    message: string;
    /** Which button triggered this simulation */
    simulationAnchor: {
        kind: "field" | "option";
        id: string;
        fieldId: string;
        label?: string;
    };
};

/** Run deep rate-coherence validation by simulating each button selection in the active tag. */
export function validateRateCoherenceDeep(params: {
    builder: Builder;
    services: DgpServiceMap;
    tagId: string;
    /** Optional rate policy (defaults to { kind: 'lte_primary' }) */
    ratePolicy?: RatePolicy;
}): RateCoherenceDiagnostic[] {
    const { builder, services, tagId } = params;
    const ratePolicy: RatePolicy = params.ratePolicy ?? { kind: "lte_primary" };
    const props = builder.getProps() as ServiceProps;

    // Indexes
    const fields = props.fields ?? [];
    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const tagById = new Map((props.filters ?? []).map((t) => [t.id, t]));
    const tag: Tag | undefined = tagById.get(tagId);

    // Baseline visible fields (no selection)
    const baselineFieldIds = builder.visibleFields(tagId, []);
    const baselineFields = baselineFieldIds
        .map((fid) => fieldById.get(fid))
        .filter(Boolean) as Field[];

    // Build the list of *simulation anchors* = every button in the baseline group
    const anchors: Array<{
        kind: "field" | "option";
        id: string;
        fieldId: string;
        label?: string;
        service_id?: number;
    }> = [];

    for (const f of baselineFields) {
        if (!isButton(f)) continue;

        if (Array.isArray(f.options) && f.options.length) {
            // Option buttons → every option becomes an anchor (even if it has no base service)
            for (const o of f.options) {
                anchors.push({
                    kind: "option",
                    id: o.id,
                    fieldId: f.id,
                    label: o.label ?? o.id,
                    service_id: numberOrUndefined((o as any).service_id),
                });
            }
        } else {
            // Non-option button → the field itself is an anchor (even if it has no base service)
            anchors.push({
                kind: "field",
                id: f.id,
                fieldId: f.id,
                label: f.label ?? f.id,
                service_id: numberOrUndefined((f as any).service_id),
            });
        }
    }

    const diags: RateCoherenceDiagnostic[] = [];
    const seen = new Set<string>(); // dedupe across simulations

    for (const anchor of anchors) {
        // Build the simulated “selected keys” (how includes_for_buttons is addressed)
        const selectedKeys =
            anchor.kind === "option"
                ? [`${anchor.fieldId}::${anchor.id}`]
                : [anchor.fieldId];

        // Recompute the visible group under this simulation
        const vgFieldIds = builder.visibleFields(tagId, selectedKeys);
        const vgFields = vgFieldIds
            .map((fid) => fieldById.get(fid))
            .filter(Boolean) as Field[];

        // Collect base service candidates in this simulated group
        const baseCandidates: Array<BaseCandidate> = [];

        for (const f of vgFields) {
            if (!isButton(f)) continue;

            if (Array.isArray(f.options) && f.options.length) {
                for (const o of f.options) {
                    const sid = numberOrUndefined((o as any).service_id);
                    const role = normalizeRole(o.pricing_role, "base");
                    if (sid == null || role !== "base") continue;
                    const r = rateOf(services, sid);
                    if (!isFiniteNumber(r)) continue;
                    baseCandidates.push({
                        kind: "option",
                        id: o.id,
                        label: o.label ?? o.id,
                        service_id: sid,
                        rate: r!,
                    });
                }
            } else {
                const sid = numberOrUndefined((f as any).service_id);
                const role = normalizeRole((f as any).pricing_role, "base");
                if (sid == null || role !== "base") continue;
                const r = rateOf(services, sid);
                if (!isFiniteNumber(r)) continue;
                baseCandidates.push({
                    kind: "field",
                    id: f.id,
                    label: f.label ?? f.id,
                    service_id: sid,
                    rate: r!,
                });
            }
        }

        if (baseCandidates.length === 0) continue;

        // Choose the “primary” for this simulation:
        // 1) Anchor’s base service (if present),
        // 2) else first base candidate (deterministic).
        const anchorPrimary =
            anchor.service_id != null
                ? pickByServiceId(baseCandidates, anchor.service_id)
                : undefined;

        const primary = anchorPrimary ? anchorPrimary : baseCandidates[0]!;

        // Compare every *other* candidate against the primary using the configured policy
        for (const cand of baseCandidates) {
            if (sameService(primary, cand)) continue;

            if (!rateOkWithPolicy(ratePolicy, cand.rate, primary.rate)) {
                const key = dedupeKey(tagId, anchor, primary, cand, ratePolicy);
                if (seen.has(key)) continue;
                seen.add(key);

                diags.push({
                    scope: "visible_group",
                    tagId,
                    primary,
                    offender: {
                        kind: cand.kind,
                        id: cand.id,
                        label: cand.label,
                        service_id: cand.service_id,
                        rate: cand.rate,
                    },
                    policy: ratePolicy.kind,
                    policyPct: "pct" in ratePolicy ? ratePolicy.pct : undefined,
                    message: explainRateMismatch(
                        ratePolicy,
                        primary.rate,
                        cand.rate,
                        describeLabel(tag),
                    ),
                    simulationAnchor: {
                        kind: anchor.kind,
                        id: anchor.id,
                        fieldId: anchor.fieldId,
                        label: anchor.label,
                    },
                });
            }
        }
    }

    return diags;
}

/* ───────────────────────── helpers ───────────────────────── */

function isButton(f: Field): boolean {
    // Buttons = explicit flag OR any option-based field
    if ((f as any).button === true) return true;
    return Array.isArray(f.options) && f.options.length > 0;
}

function normalizeRole(
    role: PricingRole | undefined,
    d: PricingRole,
): PricingRole {
    return role === "utility" || role === "base" ? role : d;
}

function numberOrUndefined(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function rateOf(
    map: DgpServiceMap,
    id: number | string | undefined,
): number | undefined {
    if (id === undefined || id === null) return undefined;
    const cap: DgpServiceCapability | undefined =
        map[Number(id)] ?? (map as any)[id];
    return cap?.rate;
}

function pickByServiceId<T extends BaseCandidate>(
    arr: T[],
    sid: number,
): T | undefined {
    return arr.find((x) => x.service_id === sid);
}

function sameService(a: { service_id: number }, b: { service_id: number }) {
    return a.service_id === b.service_id;
}

function rateOkWithPolicy(
    policy: RatePolicy,
    candRate: number,
    primaryRate: number,
): boolean {
    const rp = policy ?? { kind: "lte_primary" as const };
    switch (rp.kind) {
        case "lte_primary":
            return candRate <= primaryRate;
        case "within_pct": {
            const pct = Math.max(0, rp.pct ?? 0);
            return candRate <= primaryRate * (1 + pct / 100);
        }
        case "at_least_pct_lower": {
            const pct = Math.max(0, rp.pct ?? 0);
            return candRate <= primaryRate * (1 - pct / 100);
        }
        default:
            return candRate <= primaryRate;
    }
}

function describeLabel(tag?: Tag): string {
    const tagName = tag?.label ?? tag?.id ?? "tag";
    return `${tagName}`;
}

function explainRateMismatch(
    policy: RatePolicy,
    primary: number,
    candidate: number,
    where: string,
): string {
    switch (policy.kind) {
        case "lte_primary":
            return `Rate coherence failed (${where}): candidate ${candidate} must be ≤ primary ${primary}.`;
        case "within_pct":
            return `Rate coherence failed (${where}): candidate ${candidate} must be within ${policy.pct}% of primary ${primary}.`;
        case "at_least_pct_lower":
            return `Rate coherence failed (${where}): candidate ${candidate} must be at least ${policy.pct}% lower than primary ${primary}.`;
        default:
            return `Rate coherence failed (${where}): candidate ${candidate} mismatches primary ${primary}.`;
    }
}

function dedupeKey(
    tagId: string,
    anchor: { kind: "field" | "option"; id: string },
    primary: { service_id: number },
    cand: { service_id: number; id: string },
    rp: RatePolicy,
) {
    const rpKey =
        rp.kind +
        ("pct" in rp && typeof rp.pct === "number" ? `:${rp.pct}` : "");
    return `${tagId}|${anchor.kind}:${anchor.id}|p${primary.service_id}|c${cand.service_id}:${cand.id}|${rpKey}`;
}
