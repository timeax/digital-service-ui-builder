import { describe, it, expect } from "vitest";
import { ServiceProps } from "@/schema";
import { DgpServiceMap } from "@/schema/provider";
import { BuilderOptions, createBuilder } from "@/core";
import { validateRateCoherenceDeep } from "@/core";

// Helpers
const svc = (id: number, rate: number) =>
    ({ id, rate, platform_id: 1, handler_id: 1 }) as any;

function makeBuilder(props: ServiceProps, services?: DgpServiceMap) {
    const opts: BuilderOptions = { serviceMap: services ?? {} };
    const b = createBuilder(opts);
    b.load(props);
    return b;
}

describe("validateRateCoherenceDeep", () => {
    it("no diagnostics when all base rates are equal", () => {
        const services: DgpServiceMap = {
            1000: svc(1000, 100),
            1001: svc(1001, 100),
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 1000 }],
            fields: [
                // non-option button with base service 100
                {
                    id: "f:btn",
                    type: "switch",
                    label: "Action",
                    bind_id: "t:root",
                    button: true,
                    pricing_role: "base",
                    // base service matches tag
                    service_id: 1001,
                },
                // option button with one base option 100
                {
                    id: "f:opts",
                    type: "select",
                    label: "Choice",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:one",
                            label: "One",
                            pricing_role: "base",
                            service_id: 1000,
                        },
                    ],
                },
            ],
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            // default lte_primary
        });

        expect(diags.length).toBe(0);
    });

    it("flags higher-rate candidate under lte_primary when simulated anchor has a lower primary", () => {
        const services: DgpServiceMap = {
            1000: svc(1000, 100), // tag base
            1001: svc(1001, 90), // low
            1002: svc(1002, 120), // high -> should trigger violation in some simulations
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 1000 }],
            fields: [
                // non-option button with base=90
                {
                    id: "f:btnLow",
                    type: "switch",
                    label: "Low Btn",
                    bind_id: "t:root",
                    button: true,
                    pricing_role: "base",
                    service_id: 1001,
                },
                // options: one high(120), one not needed
                {
                    id: "f:opts",
                    type: "select",
                    label: "Options",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:hi",
                            label: "Hi",
                            pricing_role: "base",
                            service_id: 1002,
                        },
                        {
                            id: "o:ok",
                            label: "Ok",
                            pricing_role: "base",
                            service_id: 1000,
                        },
                    ],
                },
            ],
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
        });

        // Expect at least one diagnostic where the offender is the high-rate service 1002
        const offenders = diags.filter((d) => d.offender.service_id === 1002);
        expect(offenders.length).toBeGreaterThan(0);

        // And messages should mention the policy and rates coherently
        expect(offenders[0].policy).toBe("lte_primary");
        expect(offenders[0].message).toMatch(/Rate coherence failed/);
    });

    it("within_pct policy: allows <=10% but flags beyond 10% (primary comes from a revealed base button, not the tag)", () => {
        const services: DgpServiceMap = {
            1100: { id: 1100, rate: 100 }, // will be the primary via a *button*, not via tag
            1101: { id: 1101, rate: 109 }, // within 9% of 100 => OK
            1102: { id: 1102, rate: 111 }, // 11% above 100 => should be flagged
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            // tag service exists but is *not* used as primary by validator
            filters: [{ id: "t:root", label: "Root", service_id: 1100 }],
            fields: [
                // Anchor (bound): selecting this reveals others in order
                { id: "f:reveal", type: "switch", label: "Reveal", bind_id: "t:root", button: true, pricing_role: "base" },

                // Base button carrying 100 (UNBOUND, only becomes visible via includes_for_buttons)
                { id: "f:base100", type: "switch", label: "Base100", button: true, pricing_role: "base", service_id: 1100 },

                // Option buttons carrying 109 and 111 (UNBOUND; also revealed via includes_for_buttons)
                {
                    id: "f:optA",
                    type: "select",
                    label: "A",
                    button: true, // option-based ⇒ normalized to true anyway
                    options: [{ id: "o:109", label: "109", pricing_role: "base", service_id: 1101 }],
                },
                {
                    id: "f:optB",
                    type: "select",
                    label: "B",
                    button: true,
                    options: [{ id: "o:111", label: "111", pricing_role: "base", service_id: 1102 }],
                },
            ],
            includes_for_buttons: {
                // Order matters: primary in the simulation becomes 100 (f:base100), then compare 109 and 111 to it
                "f:reveal": ["f:base100", "f:optA", "f:optB"],
            },
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "within_pct", pct: 10 },
        });

        // 111 should be flagged against primary 100
        const flagged111 = diags.filter((d) => d.offender.service_id === 1102);
        expect(flagged111.length).toBeGreaterThan(0);
        expect(flagged111.some((d) => d.simulationAnchor.id === "f:reveal")).toBe(true);

        // 109 should *not* be flagged against 100 under 10%
        const flagged109 = diags.filter((d) => d.offender.service_id === 1101);
        expect(flagged109.length).toBe(0);
    });

    it("ignores non-button fields (no button flag, no options)", () => {
        const services: DgpServiceMap = {
            2000: svc(2000, 100),
            2001: svc(2001, 130), // would be “bad” if considered
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2000 }],
            fields: [
                // Plain text field with a service_id by mistake — should be ignored by the deep validator
                // @ts-expect-error ensure it's ignored; not a button
                {
                    id: "f:text",
                    type: "text",
                    label: "Note",
                    bind_id: "t:root",
                    service_id: 2001,
                },
                // A real button but equal rate, to keep things calm
                {
                    id: "f:btn",
                    type: "switch",
                    label: "Do",
                    bind_id: "t:root",
                    button: true,
                    pricing_role: "base",
                    service_id: 2000,
                },
            ],
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
        });

        // No violations because the only real (button) base is equal to the tag base,
        // and the stray service on the text field is ignored.
        expect(diags.length).toBe(0);
    });

    it("ignores utility-role services for coherence checks", () => {
        const services: DgpServiceMap = {
            3000: svc(3000, 100), // tag base
            3001: svc(3001, 500), // utility rate — should be ignored in coherence
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 3000 }],
            fields: [
                {
                    id: "f:u",
                    type: "select",
                    label: "Util",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:u",
                            label: "U",
                            pricing_role: "utility",
                            service_id: 3001,
                        },
                    ],
                },
            ],
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
        });

        expect(diags.length).toBe(0);
    });
});
