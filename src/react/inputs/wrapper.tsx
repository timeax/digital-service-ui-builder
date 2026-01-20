import React, { useMemo } from "react";
import type {
    Field,
    FieldOption,
    UtilityMark,
    WithQuantityDefault,
} from "../../schema";
import type { ButtonValue, Scalar } from "../../schema/order";
import { useInputs } from "./provider";
import type { InputDescriptor, InputVariant, InputKind } from "./registry";
import { resolveInputDescriptor } from "./registry";
import { isMultiField } from "../../utils";
import { useOptionalFormApi } from "./FormContext";

export type InputWrapperProps = {
    field: Field;
    disabled?: boolean;
    /** Extra props to forward to the host component (low priority, overridden by adapter wiring). */
    extraProps?: Record<string, unknown>;
};

export type OnChangeValue = ButtonValue | ButtonValue[]; // multi-select allowed

function toKind(field: Field): InputKind {
    if (field.type === "custom") {
        const comp = (field.component ?? "").trim();
        return `custom:${comp}` as InputKind;
    }
    return field.type as InputKind;
}

function toVariant(field: Field): InputVariant | undefined {
    const v = (field as any).meta?.variant;
    return typeof v === "string" && v.trim() ? (v as InputVariant) : undefined;
}

export function Wrapper({
    field,
    disabled,
    extraProps,
}: InputWrapperProps) {
    const { registry } = useInputs();
    const form = useOptionalFormApi();

    const kind = toKind(field);
    const variant = toVariant(field);

    const descriptor: InputDescriptor | undefined = useMemo(
        () => resolveInputDescriptor(registry, kind, variant),
        [kind, registry, variant],
    );

    if (!descriptor) {
        // eslint-disable-next-line no-console
        console.warn("[InputWrapper] No descriptor for", {
            kind,
            variant,
            field,
        });
        return null;
    }

    const { Component, adapter, defaultProps } = descriptor;
    const valueProp = adapter?.valueProp ?? "value";
    const changeProp = adapter?.changeProp ?? "onChange";

    // Shape/intention
    const isOptionBased =
        Array.isArray(field.options) && field.options.length > 0;
    const multi = !!(isOptionBased && isMultiField(field));
    const isButton = field.button === true || isOptionBased;

    // Helpers
    const optionById = useMemo(() => {
        if (!isOptionBased) return new Map<string, FieldOption>();
        return new Map((field.options ?? []).map((o) => [o.id, o]));
    }, [isOptionBased, field.options]);

    const enrich = (bv: ButtonValue): ButtonValue => {
        // Option-based button → derive from option
        if (isOptionBased) {
            const opt = optionById.get(bv.id);
            if (opt) {
                const role = (opt.pricing_role ?? "base") as "base" | "utility";
                const sid = (opt as any).service_id as number | undefined;
                const meta = (opt.meta ?? field.meta) as
                    | (Record<string, unknown> &
                          UtilityMark &
                          WithQuantityDefault)
                    | undefined;

                // utility must not carry a service_id
                return {
                    ...bv,
                    pricing_role: role,
                    service_id: role === "utility" ? undefined : sid,
                    ...(meta ? { meta } : {}),
                };
            }
            // fallback: unknown option id → just return as-is
            return bv;
        }

        // Option-less button → derive from field
        const role = (field.pricing_role ?? "base") as "base" | "utility";
        const sid = (field as any).service_id as number | undefined;
        const meta = field.meta as
            | (Record<string, unknown> & UtilityMark & WithQuantityDefault)
            | undefined;

        return {
            ...bv,
            pricing_role: role,
            service_id: role === "utility" ? undefined : sid,
            ...(meta ? { meta } : {}),
        };
    };

    function normalizeToButtonValues(input: unknown): ButtonValue[] {
        const coerceOne = (v: unknown): ButtonValue | null => {
            if (v && typeof v === "object" && "id" in (v as any)) {
                const id = String((v as any).id);
                const valueRaw = (v as any).value;
                const value =
                    typeof valueRaw === "number" || typeof valueRaw === "string"
                        ? (valueRaw as number | string)
                        : 1; // default
                return enrich({ id, value });
            }
            // If host returned a primitive, assume it's the id; default value=1
            if (typeof v === "string" || typeof v === "number") {
                return enrich({ id: String(v), value: 1 });
            }
            return null;
        };

        if (Array.isArray(input)) {
            const arr: ButtonValue[] = [];
            for (const x of input) {
                const one = coerceOne(x);
                if (one) arr.push(one);
            }
            return arr;
        }
        const one = coerceOne(input);
        return one ? [one] : [];
    }

    // Current value bindings
    let current: Scalar | Scalar[] | undefined = undefined;
    let onChange: ((v: unknown) => void) | undefined = undefined;

    if (form) {
        if (isButton) {
            if (isOptionBased) {
                // For option buttons, current is the selected option ids (single or array)
                const selIds = form.getSelections(field.id);
                current = multi ? selIds : (selIds[0] ?? null);

                onChange = (next: unknown) => {
                    const normalized = adapter?.getValue
                        ? adapter.getValue(next, current)
                        : next;
                    const bvs = normalizeToButtonValues(normalized);
                    const ids = bvs.map((b) => b.id);

                    // Update selections with ids
                    form.setSelections(field.id, Array.from(new Set(ids)));

                    // Optionally store the value(s) for per_value utilities or quantity logic
                    const values = multi ? bvs : (bvs[0] ?? null);
                    form.set(field.id, values);
                };
            } else {
                // Option-less button (e.g., switch/checkbox acting as action button)
                // We keep a scalar "value" in form.values and maintain selection id presence for "active" state.
                const val = form.get(field.id);
                current = val;

                onChange = (next: unknown) => {
                    const normalized = adapter?.getValue
                        ? adapter.getValue(next, current)
                        : next;
                    const bvs = normalizeToButtonValues(normalized);
                    const first = bvs[0]; // single semantics for option-less button

                    // If host toggled "off", allow value = 0 or empty → clear selection
                    const active =
                        first &&
                        (typeof first.value === "number"
                            ? first.value !== 0
                            : String(first.value).length > 0);

                    if (active) {
                        form.setSelections(field.id, [field.id]);
                        form.set(field.id, first.value as Scalar);
                    } else {
                        form.setSelections(field.id, []);
                        form.set(field.id, null as unknown as Scalar);
                    }
                };
            }
        } else {
            // Non-button (plain input)
            current = form.get(field.id);
            onChange = (next: unknown) => {
                const normalized = adapter?.getValue
                    ? adapter.getValue(next, current)
                    : (next as Scalar | Scalar[]);
                form.set(field.id, normalized as Scalar | Scalar[]);
            };
        }
    }

    const hostProps: Record<string, unknown> = {
        id: field.id,
        field,
        disabled: !!disabled,
        ...(defaultProps ?? {}),
        ...(extraProps ?? {}),
        ...(isOptionBased ? { options: field.options as FieldOption[] } : {}),
    };

    if (form) {
        hostProps[valueProp] = current as unknown;
        hostProps[changeProp] = onChange as unknown;
    }

    return <Component {...hostProps} />;
}
