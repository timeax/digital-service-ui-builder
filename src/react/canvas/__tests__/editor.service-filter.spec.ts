import { describe, it, expect } from "vitest";
import { createBuilder } from "@/core";
import { CanvasAPI } from "../api";
import type { ServiceProps } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { FallbackSettings } from "@/schema/validation";

function baseProps(): ServiceProps {
    return {
        schema_version: "1.0",
        filters: [{ id: "root", label: "Root" }],
        fields: [],
    };
}

const serviceMap: DgpServiceMap = {
    // primary used in tests
    100: {
        id: 100,
        rate: 10,
        dripfeed: true,
        refill: true,
        cancel: true,
        platform_id: "p1",
        handler_id: "h1",
    },

    // already-used (to verify exclusion)
    101: {
        id: 101,
        rate: 12,
        dripfeed: true,
        refill: true,
        cancel: true,
        platform_id: "p1",
        handler_id: "h1",
    },

    // cheaper than primary → passes rate
    102: {
        id: 102,
        rate: 8,
        dripfeed: true,
        refill: false,
        cancel: true,
        platform_id: "p1",
        handler_id: "h1",
    },

    // fails constraint (dripfeed false when tag requires true)
    103: {
        id: 103,
        rate: 9,
        dripfeed: false,
        refill: true,
        cancel: true,
        platform_id: "p1",
        handler_id: "h1",
    },

    // more expensive than primary → fails lte_primary
    104: {
        id: 104,
        rate: 15,
        dripfeed: true,
        refill: true,
        cancel: true,
        platform_id: "p1",
        handler_id: "h1",
    },

    // different platform to trigger a policy failure (no_mix platform_id)
    201: {
        id: 201,
        rate: 9,
        dripfeed: true,
        refill: true,
        cancel: true,
        platform_id: "p2",
        handler_id: "h1",
    },

    // same platform as primary → OK for no_mix(platform_id)
    202: {
        id: 202,
        rate: 9,
        dripfeed: true,
        refill: true,
        cancel: true,
        platform_id: "p1",
        handler_id: "h2",
    },
};

describe("Editor.filterServicesForVisibleGroup", () => {
    it("excludes already-used, checks constraints + rate + policies", () => {
        const b = createBuilder({ serviceMap });
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        const tagId = "root";
        const usedServiceIds = [100, 101]; // 101 also in candidates → excluded
        const effectiveConstraints = { dripfeed: true }; // require dripfeed:true
        const policies = [
            {
                id: "no_mix_platform",
                scope: "visible_group",
                subject: "services",
                op: "no_mix",
                projection: "service.platform_id",
                severity: "error",
            },
        ];

        const candidates = [101, 102, 103, 104, 201, 202];

        const checks = editor.filterServicesForVisibleGroup(candidates, {
            tagId,
            usedServiceIds,
            effectiveConstraints,
            policies,
            fallback: {
                ratePolicy: { kind: "lte_primary" },
            } as FallbackSettings,
        });

        const byId = new Map(checks.map((c) => [String(c.id), c]));

        // 101: excluded (already used)
        expect(byId.has("101")).toBe(false);

        // 102: cheaper, dripfeed true, same platform → OK
        const c102 = byId.get("102")!;
        expect(c102.ok).toBe(true);
        expect(c102.fitsConstraints).toBe(true);
        expect(c102.passesRate).toBe(true);
        expect(c102.passesPolicies).toBe(true);
        expect(c102.reasons).toEqual([]);

        // 103: fails constraint
        const c103 = byId.get("103")!;
        expect(c103.ok).toBe(false);
        expect(c103.fitsConstraints).toBe(false);
        expect(c103.reasons).toContain("constraint_mismatch");

        // 104: fails rate policy
        const c104 = byId.get("104")!;
        expect(c104.ok).toBe(false);
        expect(c104.passesRate).toBe(false);
        expect(c104.reasons).toContain("rate_policy");

        // 201: policy failure (no_mix platform with p2 against used p1)
        const c201 = byId.get("201")!;
        expect(c201.ok).toBe(false);
        expect(c201.passesPolicies).toBe(false);
        expect(c201.policyErrors).toContain("no_mix_platform");
        expect(c201.reasons).toContain("policy_error");

        // 202: same platform as primary → passes policy
        const c202 = byId.get("202")!;
        expect(c202.ok).toBe(true);
        expect(c202.passesPolicies).toBe(true);
    });

    it("passes rate by default when there is no primary (empty usedServiceIds)", () => {
        const b = createBuilder({ serviceMap });
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        const checks = editor.filterServicesForVisibleGroup([104], {
            tagId: "root",
            usedServiceIds: [], // no primary → rate check defaults to true
            effectiveConstraints: {},
            policies: [],
            fallback: { ratePolicy: { kind: "lte_primary" } },
        });

        expect(checks).toHaveLength(1);
        expect(checks[0].id).toBe(104);
        expect(checks[0].passesRate).toBe(true);
    });

    it("respects ratePolicy variants (at_least_pct_lower)", () => {
        const b = createBuilder({ serviceMap });
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        // primary 100 → rate 10; require at least 20% lower → candidate must be <= 8
        const checks = editor.filterServicesForVisibleGroup([102, 103, 104], {
            tagId: "root",
            usedServiceIds: [100],
            effectiveConstraints: {},
            policies: [],
            fallback: { ratePolicy: { kind: "at_least_pct_lower", pct: 20 } },
        });

        const byId = new Map(checks.map((c) => [String(c.id), c]));
        expect(byId.get("102")!.passesRate).toBe(true); // 8 OK
        expect(byId.get("103")!.passesRate).toBe(false); // 9 FAIL
        expect(byId.get("104")!.passesRate).toBe(false); // 15 FAIL
    });

    it("handles loose/unknown policy input but still evaluates", () => {
        const b = createBuilder({ serviceMap });
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        const checks = editor.filterServicesForVisibleGroup([102], {
            tagId: "root",
            usedServiceIds: [100],
            effectiveConstraints: {},
            // intentionally loose: compilePolicies should normalize
            policies: [
                { subject: "services", scope: "visible_group", op: "all_true" },
            ],
            fallback: { ratePolicy: { kind: "lte_primary" } },
        });

        expect(checks).toHaveLength(1);
        expect(checks[0].ok).toBe(true);
    });
});
