// src/core/__tests__/normalise.test.ts
import { describe, it, expect } from "vitest";
import { normalise } from "@/core";
import type { Field } from "@/schema";

describe("normalise()", () => {
    it("injects a root tag (t:root) if missing", () => {
        const input = {
            filters: [{ id: "t1", label: "Tag 1" }],
            fields: [],
        };

        const out = normalise(input);

        // root is injected and placed first
        expect(out.filters[0]).toMatchObject({ id: "t:root", label: "Root" });

        // original tag remains
        expect(out.filters.some((t) => t.id === "t1")).toBe(true);
    });

    it("keeps only canonical top-level keys and ignores legacy/camelCase keys", () => {
        const input = {
            // canonical
            filters: [
                { id: "t1", label: "T1", bind_id: "t:root", service_id: 42 },
            ],
            fields: [
                {
                    id: "f1",
                    label: "Field 1",
                    type: "select",
                    bind_id: ["t1", "t:root"],
                    options: [
                        { id: "o1", label: "Opt 1", service_id: 1001 },
                        { id: "o2", label: "Opt 2" },
                    ],
                },
            ],
            includes_for_buttons: { o1: ["f2"] },
            excludes_for_buttons: { o2: ["f3"] },

            // legacy / non-canonical (should be ignored)
            tags: [
                {
                    id: "tLegacy",
                    label: "Legacy",
                    bindId: "root",
                    serviceId: 99,
                },
            ],
            includesForOptions: { "f1::o1": ["ghost"] },
            excludeForOptions: { "f1::o2": ["ghost2"] },
            foo: "bar",
        };

        const out = normalise(input);

        // canonical keys only (plus schema_version)
        expect(Object.keys(out).sort()).toEqual(
            [
                "excludes_for_buttons",
                "filters",
                "fields",
                "includes_for_buttons",
                "schema_version",
            ].sort(),
        );

        // root injected (even if not provided explicitly)
        expect(out.filters[0]).toMatchObject({ id: "t:root", label: "Root" });

        // tag coercion (canonical snake_case only)
        const t1 = out.filters.find((t) => t.id === "t1")!;
        expect(t1.bind_id).toBe("t:root");
        expect(t1.service_id).toBe(42);

        // field coercion
        const f1 = out.fields.find((f) => f.id === "f1")!;
        expect(f1.bind_id).toEqual(["t1", "t:root"]);

        // option coercion
        expect(f1.options?.[0].service_id).toBe(1001);

        // option maps (canonical keys)
        expect(out.includes_for_buttons).toEqual({ o1: ["f2"] });
        expect(out.excludes_for_buttons).toEqual({ o2: ["f3"] });

        // legacy keys are not kept
        expect((out as any).tags).toBeUndefined();
        expect((out as any).includesForOptions).toBeUndefined();
        expect((out as any).excludeForOptions).toBeUndefined();
        expect((out as any).foo).toBeUndefined();
    });

    it("normalises bind_id: single => string, multi => array, dedupes arrays", () => {
        const input = {
            filters: [
                { id: "root", label: "Root" },
                { id: "t1", label: "T1" },
                { id: "t2", label: "T2" },
            ],
            fields: [
                { id: "f_single", label: "A", type: "text", bind_id: "t1" },
                {
                    id: "f_multi",
                    label: "B",
                    type: "text",
                    bind_id: ["t2", "t2", "root"],
                },
                { id: "f_none", label: "C", type: "text" },
            ],
        };

        const out = normalise(input);
        const fSingle = out.fields.find((f) => f.id === "f_single")!;
        const fMulti = out.fields.find((f) => f.id === "f_multi")!;
        const fNone = out.fields.find((f) => f.id === "f_none")!;

        expect(typeof fSingle.bind_id).toBe("string");
        expect(fSingle.bind_id).toBe("t1");

        expect(Array.isArray(fMulti.bind_id)).toBe(true);
        expect(fMulti.bind_id).toEqual(["t2", "root"]); // deduped, order preserved

        expect(fNone.bind_id).toBeUndefined();
    });

    it('defaults pricing_role to "base" on fields and cascades to options', () => {
        const input = {
            filters: [{ id: "root", label: "Root" }],
            fields: [
                {
                    id: "f1",
                    label: "F1",
                    type: "select",
                    options: [
                        { id: "o1", label: "O1" },
                        { id: "o2", label: "O2" },
                    ],
                },
            ],
        };

        const out = normalise(input);
        const f1 = out.fields.find((f) => f.id === "f1")!;
        expect(f1.pricing_role).toBe("base");
        expect(f1.options?.map((o) => o.pricing_role)).toEqual([
            "base",
            "base",
        ]);
    });

    it("respects option-level pricing_role override", () => {
        const input = {
            filters: [{ id: "root", label: "Root" }],
            fields: [
                {
                    id: "f1",
                    label: "F1",
                    type: "select",
                    pricing_role: "base",
                    options: [
                        { id: "o1", label: "O1" }, // will inherit base
                        { id: "o2", label: "O2", pricing_role: "utility" }, // override
                    ],
                },
            ],
        };

        const out = normalise(input);
        const f1 = out.fields.find((f) => f.id === "f1")!;
        expect(f1.pricing_role).toBe("base");
        expect(f1.options?.map((o) => o.pricing_role)).toEqual([
            "base",
            "utility",
        ]);
    });

    it("keeps component only for custom fields", () => {
        const input = {
            filters: [{ id: "root", label: "Root" }],
            fields: [
                {
                    id: "f_custom",
                    label: "Custom",
                    type: "custom",
                    component: "ServiceForm/Thing",
                },
                {
                    id: "f_text",
                    label: "Text",
                    type: "text",
                    component: "ShouldBeIgnored",
                },
            ],
        };

        const out = normalise(input);
        const fCustom = out.fields.find((f) => f.id === "f_custom")!;
        const fText = out.fields.find((f) => f.id === "f_text")!;

        expect(fCustom.component).toBe("ServiceForm/Thing");
        expect((fText as Field).component).toBeUndefined();
    });

    it('sets schema_version default to "1.0" if missing, preserves if provided', () => {
        const out1 = normalise({ filters: [], fields: [] });
        expect(out1.schema_version).toBe("1.0");

        const out2 = normalise({
            filters: [],
            fields: [],
            schema_version: "2.0",
        });
        expect(out2.schema_version).toBe("2.0");
    });

    it("dedupes include/exclude arrays on tags", () => {
        const input = {
            filters: [
                {
                    id: "root",
                    label: "Root",
                    includes: ["a", "a", "b"],
                    excludes: ["x", "x", "y"],
                },
            ],
            fields: [],
        };

        const out = normalise(input);
        const root = out.filters[1];
        expect(root.includes).toEqual(["a", "b"]);
        expect(root.excludes).toEqual(["x", "y"]);
    });

    it("handles empty/invalid inputs gracefully with meaningful errors", () => {
        expect(() => normalise(null as unknown as object)).toThrowError(
            /expected an object payload/i,
        );
        expect(() => normalise(undefined as unknown as object)).toThrowError();
    });
});
