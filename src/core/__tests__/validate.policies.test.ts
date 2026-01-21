import { describe, it, expect } from "vitest";
import { validate } from "@/core";
import type { ServiceProps } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { DynamicRule } from "@/schema/validation";

describe("validate() dynamic policies", () => {
    const baseProps: ServiceProps = {
        filters: [
            { id: "root", label: "Root" },
            { id: "A", label: "A", bind_id: "root" },
        ],
        fields: [
            {
                id: "f1",
                label: "Base A",
                type: "select",
                bind_id: "A",
                options: [
                    {
                        id: "o1",
                        label: "S-1",
                        service_id: 1,
                        pricing_role: "base",
                    },
                    {
                        id: "o2",
                        label: "S-2",
                        service_id: 2,
                        pricing_role: "base",
                    },
                ],
            },
            {
                id: "f2",
                label: "Util A",
                type: "select",
                bind_id: "A",
                options: [
                    {
                        id: "u1",
                        label: "U-1",
                        service_id: 3,
                        pricing_role: "utility",
                    },
                ],
            },
        ],
    };

    // NOTE:
    // - These include the required ServiceDefinition bits: name/rate/min/max
    // - Extra host props (handler_id/platform_id/key/dripfeed via flags/meta) are fine
    const serviceMap: DgpServiceMap = {
        1: {
            id: 1,
            name: "S1",
            rate: 10,
            min: 1,
            max: 1000,
            key: "k1" as any,
            handler_id: 9 as any,
            platform_id: 100 as any,
            flags: {
                dripfeed: {
                    enabled: true,
                    description: "Supports dripfeed",
                },
            },
            meta: { type: "alpha" } as any,
        },
        2: {
            id: 2,
            name: "S2",
            rate: 10,
            min: 1,
            max: 1000,
            key: "k2" as any,
            handler_id: 9 as any,
            platform_id: 100 as any,
            flags: {
                dripfeed: {
                    enabled: true,
                    description: "Supports dripfeed",
                },
            },
            meta: { type: "alpha" } as any,
        },
        3: {
            id: 3,
            name: "U1",
            rate: 5,
            min: 1,
            max: 1000,
            key: "k1" as any, // duplicate globally with service 1
            handler_id: 7 as any,
            platform_id: 200 as any,
            flags: {
                dripfeed: {
                    enabled: false,
                    description: "No dripfeed",
                },
            },
            meta: { type: "beta" } as any,
        },
    };

    it("visible_group: all_equal on service type passes when equal", () => {
        const rules: DynamicRule[] = [
            {
                id: "grp-type-eq",
                scope: "visible_group",
                subject: "services",
                filter: { role: "base" },
                projection: "service.type", // comes from meta.type (merged into service)
                op: "all_equal",
                message: "Base services in a group must share the same type",
            },
        ];

        const out = validate(baseProps, { serviceMap, policies: rules });

        expect(
            out.some(
                (e) =>
                    e.code === "policy_violation" &&
                    (e.details as any)?.ruleId === "grp-type-eq",
            ),
        ).toBe(false);
    });

    it("visible_group: no_mix handler_id fails when handlers differ", () => {
        const props: ServiceProps = JSON.parse(JSON.stringify(baseProps));
        // swap one BASE service to service 3 (handler 7 vs 9)
        (props.fields[0].options![1] as any).service_id = 3;

        const rules: DynamicRule[] = [
            {
                id: "grp-no-mix-handler",
                scope: "visible_group",
                subject: "services",
                filter: { role: "base" },
                projection: "service.handler_id",
                op: "no_mix",
                message: "Do not mix providers in one group",
            },
        ];

        const out = validate(props, { serviceMap, policies: rules });

        expect(
            out.some(
                (e) =>
                    e.code === "policy_violation" &&
                    e.nodeId === "A" &&
                    (e.details as any)?.ruleId === "grp-no-mix-handler",
            ),
        ).toBe(true);
    });

    it("global: unique key fails if duplicate provider keys exist", () => {
        const rules: DynamicRule[] = [
            {
                id: "global-unique-key",
                scope: "global",
                subject: "services",
                projection: "service.key",
                op: "unique",
                message: "Provider keys must be unique globally",
            },
        ];

        const out = validate(baseProps, { serviceMap, policies: rules });

        expect(
            out.some(
                (e) =>
                    e.code === "policy_violation" &&
                    e.nodeId === "global" &&
                    (e.details as any)?.ruleId === "global-unique-key",
            ),
        ).toBe(true);
    });

    it("visible_group: all_true dripfeed fails if any is false", () => {
        const rules: DynamicRule[] = [
            {
                id: "grp-dripfeed-alltrue",
                scope: "visible_group",
                subject: "services",
                projection: "service.flags.dripfeed.enabled",
                filter: { role: "both" },
                op: "all_true",
            },
        ];

        const out = validate(baseProps, { serviceMap, policies: rules });

        // service 3 (utility) has dripfeed.enabled false → violation on tag A
        expect(
            out.some(
                (e) =>
                    e.code === "policy_violation" &&
                    e.nodeId === "A" &&
                    (e.details as any)?.ruleId === "grp-dripfeed-alltrue",
            ),
        ).toBe(true);
    });

    it("visible_group: max_count base=1 fails with two base items", () => {
        const rules: DynamicRule[] = [
            {
                id: "grp-max-one-base",
                scope: "visible_group",
                subject: "services",
                filter: { role: "base" },
                op: "max_count",
                value: 1,
            },
        ];

        const out = validate(baseProps, { serviceMap, policies: rules });

        expect(
            out.some(
                (e) =>
                    e.code === "policy_violation" &&
                    e.nodeId === "A" &&
                    (e.details as any)?.ruleId === "grp-max-one-base",
            ),
        ).toBe(true);
    });
});
