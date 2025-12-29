import { describe, it, expect } from "vitest";
import { validate } from "../validate";
import type { ServiceProps, Tag, Field, FieldOption } from "../../schema";

/* ───────────────────────── helpers & fixtures ───────────────────────── */

function rootOnly(): ServiceProps {
    const tags: Tag[] = [{ id: "root", label: "Root" }];
    return { filters: tags, fields: [], schema_version: "1.0" };
}

type Err = { code: string; nodeId?: string; details?: Record<string, unknown> };

function utilityErrors(all: Err[]): Err[] {
    return all.filter(
        (e: Err) => typeof e.code === "string" && e.code.startsWith("utility_"),
    );
}

function opt(id: string, patch?: Partial<FieldOption>): FieldOption {
    const base: FieldOption = {
        id,
        label: id,
        pricing_role: "utility" as const,
        meta: {},
    };
    return { ...base, ...(patch ?? {}) };
}

function field(id: string, patch?: Partial<Field>): Field {
    const base: Field = {
        id,
        type: "select",
        label: id,
        bind_id: "root",
        pricing_role: "utility",
        options: [],
        meta: {},
    };
    return { ...base, ...(patch ?? {}) } as Field;
}

/* ────────────────────────────── tests ─────────────────────────────── */

describe("utility validation", () => {
    it("flags an option marked as utility that also has a service_id (utility_with_service_id)", () => {
        const props: ServiceProps = rootOnly();

        const f = field("F1", {
            options: [
                opt("O1", {
                    pricing_role: "utility",
                    service_id: 999, // <-- not allowed for a utility option
                    // provide a seemingly valid utility meta to isolate the error under test
                    meta: { utility: { rate: 5, mode: "flat" } },
                }),
            ],
        });

        props.fields.push(f);

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(
            util.some(
                (e) =>
                    e.code === "utility_with_service_id" && e.nodeId === "O1",
            ),
        ).toBe(true);
    });

    it("flags an option marked as utility with missing/invalid rate (utility_missing_rate)", () => {
        const props: ServiceProps = rootOnly();

        props.fields.push(
            field("F2", {
                options: [
                    opt("O2", {
                        pricing_role: "utility",
                        meta: {
                            // @ts-expect-error
                            utility: {
                                /* rate missing */ mode: "per_quantity",
                            },
                        },
                    }),
                    opt("O3", {
                        pricing_role: "utility",
                        meta: { utility: { rate: Number.NaN, mode: "flat" } }, // invalid rate
                    }),
                ],
            }),
        );

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(
            util.some(
                (e) => e.code === "utility_missing_rate" && e.nodeId === "O2",
            ),
        ).toBe(true);
        expect(
            util.some(
                (e) => e.code === "utility_missing_rate" && e.nodeId === "O3",
            ),
        ).toBe(true);
    });

    it("flags an option marked as utility with invalid mode (utility_invalid_mode)", () => {
        const props: ServiceProps = rootOnly();

        props.fields.push(
            field("F3", {
                options: [
                    opt("O4", {
                        pricing_role: "utility",
                        meta: {
                            utility: {
                                rate: 2.5,
                                mode: "banana" as unknown as "flat",
                            },
                        }, // invalid
                    }),
                ],
            }),
        );

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(
            util.some(
                (e) => e.code === "utility_invalid_mode" && e.nodeId === "O4",
            ),
        ).toBe(true);
    });

    it("accepts a valid option-level utility (no service_id, finite rate, allowed mode)", () => {
        const props: ServiceProps = rootOnly();

        props.fields.push(
            field("F4", {
                options: [
                    opt("O5", {
                        pricing_role: "utility",
                        meta: { utility: { rate: 3.0, mode: "per_quantity" } },
                    }),
                ],
            }),
        );

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(util.find((e) => e.nodeId === "O5")).toBeUndefined();
    });

    it("accepts a valid field-level utility marker", () => {
        const props: ServiceProps = rootOnly();

        props.fields.push(
            field("UFEE", {
                pricing_role: "utility",
                // no options; this is a pure utility field (e.g., a checkbox/number/text)
                meta: { utility: { rate: 1.5, mode: "flat" } },
            }),
        );

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(util.find((e) => e.nodeId === "UFEE")).toBeUndefined();
    });

    it("accepts per_value utilities with or without valueBy", () => {
        const props: ServiceProps = rootOnly();

        props.fields.push(
            field("F5", {
                options: [
                    opt("O6", {
                        meta: {
                            utility: {
                                rate: 0.25,
                                mode: "per_value",
                                valueBy: "value",
                            },
                        },
                    }),
                    opt("O7", {
                        meta: { utility: { rate: 0.1, mode: "per_value" } }, // defaults are ok
                    }),
                ],
            }),
        );

        const errors: Err[] = validate(props, { allowUnsafe: true }) as any;
        const util = utilityErrors(errors);

        expect(util.find((e) => e.nodeId === "O6")).toBeUndefined();
        expect(util.find((e) => e.nodeId === "O7")).toBeUndefined();
    });
});
