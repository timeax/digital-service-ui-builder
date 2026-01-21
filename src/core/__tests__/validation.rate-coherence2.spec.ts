import { describe, it, expect } from "vitest";
import { ServiceProps } from "@/schema";
import { DgpServiceMap } from "@/schema/provider";
import { Builder, createBuilder } from "@/core";
import { validateRateCoherenceDeep } from "@/core";

/* helpers */
function svc(id: number, rate: number) {
    return { id, rate };
}
function makeBuilder(props: ServiceProps, services: DgpServiceMap): Builder {
    const b = createBuilder({ serviceMap: services });
    b.load(props);
    return b;
}

describe("validateRateCoherenceDeep (no tag-base primary)", () => {
    it("within_pct: anchor without base → first revealed base becomes primary; flags > 10% over primary", () => {
        const services: DgpServiceMap = {
            // tag base present but must not be used
            2100: svc(2100, 999),
            2101: svc(2101, 100), // will be chosen as primary (first revealed)
            2102: svc(2102, 112), // 12% above -> violation
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2100 }],
            fields: [
                {
                    id: "f:probe",
                    type: "switch",
                    label: "Probe",
                    bind_id: "t:root",
                    button: true,
                    pricing_role: "base",
                },
                // order matters: f:A before f:B to make 100 the primary
                {
                    id: "f:A",
                    type: "select",
                    label: "A",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:100",
                            label: "100",
                            pricing_role: "base",
                            service_id: 2101,
                        },
                    ],
                },
                {
                    id: "f:B",
                    type: "select",
                    label: "B",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:112",
                            label: "112",
                            pricing_role: "base",
                            service_id: 2102,
                        },
                    ],
                },
            ],
            includes_for_buttons: {
                "f:probe": ["f:A", "f:B"],
            },
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "within_pct", pct: 10 },
        });

        // offender 112 must be flagged; 100 is primary
        const flagged112 = diags.filter((d) => d.offender.service_id === 2102);
        expect(flagged112.length).toBeGreaterThan(0);
        expect(
            flagged112.some((d) => d.simulationAnchor.id === "f:probe"),
        ).toBe(true);

        const flagged100 = diags.filter((d) => d.offender.service_id === 2101);
        expect(flagged100.length).toBe(0);
    });

    it("lte_primary: when reveal shows 100 then 105, 105 violates vs primary 100", () => {
        const services: DgpServiceMap = {
            2200: { id: 2200, rate: 777 }, // tag base (ignored for primary)
            2201: { id: 2201, rate: 100 }, // primary candidate
            2202: { id: 2202, rate: 105 }, // offender
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2200 }],
            fields: [
                // Anchor (bound) – selecting this should reveal the two base candidates
                { id: "f:reveal", type: "switch", label: "Reveal", bind_id: "t:root", button: true, pricing_role: "base" },

                // Two base buttons (UNBOUND): only become visible during the simulation via includes_for_buttons
                { id: "f:ok",  type: "switch", label: "OK",  /* no bind_id */ button: true, pricing_role: "base", service_id: 2201 },
                { id: "f:aux", type: "switch", label: "Aux", /* no bind_id */ button: true, pricing_role: "base", service_id: 2202 },
            ],
            includes_for_buttons: {
                // selecting f:reveal reveals f:ok then f:aux (order matters; 100 becomes primary)
                "f:reveal": ["f:ok", "f:aux"],
            },
        };

        const b = createBuilder({ serviceMap: services });
        b.load(props);

        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "lte_primary" },
        });

        // 105 must be flagged against primary 100
        const flagged105 = diags.filter((d) => d.offender.service_id === 2202);
        expect(flagged105.length).toBeGreaterThan(0);
        expect(flagged105.some((d) => d.simulationAnchor.id === "f:reveal")).toBe(true);

        // 100 never flagged
        const flagged100 = diags.filter((d) => d.offender.service_id === 2201);
        expect(flagged100.length).toBe(0);
    });

    it("anchor with its own base uses itself as primary (no tag), other ≤10% is OK", () => {
        const services: DgpServiceMap = {
            2300: svc(2300, 999),
            2301: svc(2301, 109),
            2302: svc(2302, 111), // within ~1.83% of 109 -> OK
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2300 }],
            fields: [
                {
                    id: "f:opt",
                    type: "select",
                    label: "Opt",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:109",
                            label: "109",
                            pricing_role: "base",
                            service_id: 2301,
                        },
                        {
                            id: "o:111",
                            label: "111",
                            pricing_role: "base",
                            service_id: 2302,
                        },
                    ],
                },
            ],
            includes_for_buttons: {},
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "within_pct", pct: 10 },
        });

        expect(diags.length).toBe(0);
    });

    it("utility-role candidates are ignored as base even if they carry service_id", () => {
        const services: DgpServiceMap = {
            2400: svc(2400, 100),
            2401: svc(2401, 1000), // absurd, but utility → must be ignored
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2400 }],
            fields: [
                {
                    id: "f:u",
                    type: "select",
                    label: "Util",
                    bind_id: "t:root",
                    options: [
                        {
                            id: "o:util",
                            label: "Util",
                            pricing_role: "utility",
                            service_id: 2401 as any,
                        },
                    ],
                },
            ],
            includes_for_buttons: {
                "f:u::o:util": [],
            },
        };

        const b = makeBuilder(props, services);
        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "lte_primary" },
        });

        expect(diags.length).toBe(0);
    });

    it("at_least_pct_lower: primary=190 (first), 195 violates (not ≥5% lower)", () => {
        const services: DgpServiceMap = {
            2500: { id: 2500, rate: 777 }, // tag base (ignored for primary)
            2501: { id: 2501, rate: 190 }, // primary
            2502: { id: 2502, rate: 195 }, // offender
        };

        const props: ServiceProps = {
            schema_version: "1.0",
            filters: [{ id: "t:root", label: "Root", service_id: 2500 }],
            fields: [
                // Anchor (bound)
                { id: "f:probe", type: "switch", label: "Probe", bind_id: "t:root", button: true, pricing_role: "base" },

                // Two base buttons (UNBOUND), revealed (in order) by selecting the anchor
                { id: "f:A", type: "switch", label: "A", /* no bind_id */ button: true, pricing_role: "base", service_id: 2501 }, // first => primary
                { id: "f:B", type: "switch", label: "B", /* no bind_id */ button: true, pricing_role: "base", service_id: 2502 },
            ],
            includes_for_buttons: {
                "f:probe": ["f:A", "f:B"],
            },
        };

        const b = createBuilder({ serviceMap: services });
        b.load(props);

        const diags = validateRateCoherenceDeep({
            builder: b,
            services,
            tagId: "t:root",
            ratePolicy: { kind: "at_least_pct_lower", pct: 5 },
        });

        const bad = diags.filter((d) => d.offender.service_id === 2502);
        const good = diags.filter((d) => d.offender.service_id === 2501);

        expect(bad.length).toBeGreaterThan(0);
        expect(bad.some((d) => d.simulationAnchor.id === "f:probe")).toBe(true);
        expect(good.length).toBe(0);
    });
});
