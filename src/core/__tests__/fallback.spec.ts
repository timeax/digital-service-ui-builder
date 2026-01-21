import { describe, it, expect } from "vitest";
import type { ServiceProps, Tag, Field, FieldOption } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";

import { collectFailedFallbacks } from "@/core";
import { pruneInvalidNodeFallbacks } from "@/utils/prune-fallbacks";

// ----------------------- fixtures -----------------------

const svc = (
    id: number,
    rate: number,
    flags?: Partial<
        Pick<NonNullable<DgpServiceMap[0]>, "dripfeed" | "refill" | "cancel">
    >,
) => ({
    id,
    name: `Service ${id}`,
    rate,
    flags,
});

const serviceMap: DgpServiceMap = {
    100: svc(100, 10, { dripfeed: false }), // base for T
    101: svc(101, 8, { dripfeed: false }), // cheaper, fits constraints
    102: svc(102, 12, { dripfeed: false }), // more expensive (rate violation)
    103: svc(103, 9, { dripfeed: true }), // cheaper but dripfeed true (constraint mismatch if tag wants false)
    104: svc(104, 7, { dripfeed: false }), // cheaper, fits constraints
    105: svc(105, 11, { dripfeed: false }), // option base
    106: svc(106, 9, { dripfeed: false }), // option base (multi-context)
};

function baseProps(): ServiceProps {
    const tags: Tag[] = [
        { id: "root", label: "Root" },
        // Single-context tag T
        {
            id: "T",
            label: "Group T",
            bind_id: "root",
            service_id: 100,
            // Effective constraints should be 'dripfeed:false'
            constraints: { dripfeed: false },
        },
        // Multi-context tags
        {
            id: "T1",
            label: "T1",
            bind_id: "root",
            constraints: { dripfeed: false },
        },
        {
            id: "T2",
            label: "T2",
            bind_id: "root",
            constraints: { dripfeed: true },
        },
    ];

    const fields: Field[] = [
        // Field bound to T, with an option that yields a service (optA)
        {
            id: "F_T",
            type: "select",
            label: "F_T",
            bind_id: "T",
            options: [
                {
                    id: "optA",
                    label: "A",
                    service_id: 105,
                    pricing_role: "base",
                } as FieldOption,
            ],
            pricing_role: "base",
        },
        // Field bound to both T1 & T2 (multi-context), with option optM yielding a service
        {
            id: "F_M",
            type: "select",
            label: "F_M",
            bind_id: ["T1", "T2"],
            options: [
                {
                    id: "optM",
                    label: "M",
                    service_id: 106,
                    pricing_role: "base",
                } as FieldOption,
            ],
            pricing_role: "base",
        },
    ];

    const props: ServiceProps = {
        filters: tags,
        fields,
        schema_version: "1.0",
        // Fallbacks shape we agreed: nodes + global
        fallbacks: {
            nodes: {
                // For tag T's base node
                T: [101, 102, 103],
                // For option optA (single-context)
                optA: [104],
                // For option optM (multi-context)
                optM: [103, 102],
            },
            // Global is soft (client does not prune)
            global: {
                100: [104, 102],
            },
        },
    };

    return props;
}

// Convenience to find reasons in diagnostics
function reasonsFor(
    diags: any[],
    where: Partial<{
        scope: string;
        nodeId: string | string[];
        candidate: number | string;
        tagContext: string;
    }>,
) {
    const wantedIds = Array.isArray(where.nodeId)
        ? where.nodeId
        : where.nodeId
          ? [where.nodeId]
          : undefined;
    return diags
        .filter((d) => {
            const scopeOk = where.scope ? d.scope === where.scope : true;
            const nodeOk = wantedIds
                ? wantedIds.some((id) => String(d.nodeId) === String(id))
                : true;
            const candOk =
                where.candidate !== undefined
                    ? String(d.candidate) === String(where.candidate)
                    : true;
            const ctxOk = where.tagContext
                ? d.tagContext === where.tagContext
                : true;
            return scopeOk && nodeOk && candOk && ctxOk;
        })
        .map((d) => d.reason)
        .sort();
}

// ----------------------- tests -----------------------

describe("fallbacks: node-scoped (rate + constraints)", () => {
    it("keeps a candidate that is cheaper and fits constraints", () => {
        const props = baseProps();

        const diags = collectFailedFallbacks(props, serviceMap, {
            mode: "dev",
        });
        // Tag T → candidate 101 should be fine (no failures for that pair)
        expect(reasonsFor(diags, { nodeId: "T", candidate: 101 })).toEqual([]);

        const { props: pruned, removed } = pruneInvalidNodeFallbacks(
            props,
            serviceMap,
            { requireConstraintFit: true },
        );
        expect(
            removed.find(
                (r) => r.nodeId === "T" && String(r.candidate) === "101",
            ),
        ).toBeFalsy();
        expect(pruned.fallbacks?.nodes?.T).toContain(101);
    });

    it("flags & prunes a rate violation (candidate more expensive than primary)", () => {
        const props = baseProps();

        const diags = collectFailedFallbacks(props, serviceMap, {
            mode: "dev",
        });
        expect(reasonsFor(diags, { nodeId: "T", candidate: 102 })).toContain(
            "rate_violation",
        );

        const { props: pruned, removed } = pruneInvalidNodeFallbacks(
            props,
            serviceMap,
            { requireConstraintFit: true },
        );
        // removed contains T::102
        expect(
            removed.some(
                (r) => r.nodeId === "T" && String(r.candidate) === "102",
            ),
        ).toBe(true);
        expect(pruned.fallbacks?.nodes?.T ?? []).not.toContain(102);
    });

    it("flags & prunes a constraint mismatch when the tag requires a flag (true) and the candidate lacks it", () => {
        const props = baseProps();

        // Make the tag require dripfeed=true so we actually have a requirement to check
        const t = props.filters.find((tt) => tt.id === "T")!;
        t.constraints = { dripfeed: true };

        const settings = {
            requireConstraintFit: true,
            ratePolicy: { kind: "lte_primary" as const },
        };

        // Candidate 101 has dripfeed: false (lacks the required capability) → mismatch
        const diags = collectFailedFallbacks(props, serviceMap, settings);
        expect(
            reasonsFor(diags, { nodeId: ["T", "tag:T"], candidate: 101 }),
        ).toContain("constraint_mismatch");

        const { props: pruned, removed } = pruneInvalidNodeFallbacks(
            props,
            serviceMap,
            settings,
        );
        expect(
            removed.some(
                (r) =>
                    (r.nodeId === "T" || r.nodeId === "tag:T") &&
                    String(r.candidate) === "101",
            ),
        ).toBe(true);
        expect(pruned.fallbacks?.nodes?.T ?? []).not.toContain(101);
    });
});

describe("fallbacks: option node with multi-tag context", () => {
    it("keeps a candidate that fails one context but passes another (fails-not-all rule)", () => {
        const props = baseProps();

        // Adjust contexts to actually require/passthrough
        const t1 = props.filters.find((tt) => tt.id === "T1")!;
        const t2 = props.filters.find((tt) => tt.id === "T2")!;
        t1.constraints = { dripfeed: true }; // requires true
        t2.constraints = { dripfeed: false }; // no requirement

        // Ensure optM fallbacks include a candidate that lacks dripfeed (to fail T1)
        // and one that is a rate violation (to be pruned).
        // service 101 -> dripfeed:false, service 102 -> rate 12 (violates lte_primary vs base 106=9)
        props.fallbacks!.nodes!.optM = [101, 102];

        const settings = {
            requireConstraintFit: true,
            ratePolicy: { kind: "lte_primary" as const },
        };

        const diags = collectFailedFallbacks(props, serviceMap, settings);

        // 101 should have at least one constraint failure (against T1)
        expect(
            reasonsFor(diags, { nodeId: ["optM"], candidate: 101 }),
        ).toContain("constraint_mismatch");

        // Prune only candidates that fail all contexts or violate rate policy
        const { props: pruned, removed } = pruneInvalidNodeFallbacks(
            props,
            serviceMap,
            settings,
        );

        // 101 kept (fails T1, passes T2)
        expect(pruned.fallbacks?.nodes?.optM).toContain(101);

        // 102 pruned (rate violation vs base 106=9)
        expect(
            removed.some(
                (r) => r.nodeId === "optM" && String(r.candidate) === "102",
            ),
        ).toBe(true);
        expect(pruned.fallbacks?.nodes?.optM ?? []).not.toContain(102);
    });
});

describe("fallbacks: global (soft)", () => {
    it("does not prune global fallbacks on the client", () => {
        const props = baseProps();
        const before = JSON.stringify(props.fallbacks?.global ?? {});
        const { props: pruned } = pruneInvalidNodeFallbacks(props, serviceMap, {
            requireConstraintFit: true,
        });
        const after = JSON.stringify(pruned.fallbacks?.global ?? {});
        expect(after).toBe(before); // untouched by design
    });
});
