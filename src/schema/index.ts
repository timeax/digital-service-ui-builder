// persisted schema + shared types
export type PricingRole = "base" | "utility";
export type FieldType = "custom" | (string & {});

/** ── Marker types (live inside meta; non-breaking) ───────────────────── */
export type QuantityMark = {
    quantity?: {
        valueBy: "value" | "length" | "eval";
        code?: string;
        multiply?: number;
        clamp?: { min?: number; max?: number };
        fallback?: number;
    };
};

export type UtilityMark = {
    utility?: {
        rate: number;
        mode: "flat" | "per_quantity" | "per_value" | "percent";
        valueBy?: "value" | "length"; // only for per_value; default 'value'
        percentBase?: "service_total" | "base_service" | "all";
        label?: string;
    };
};

export type WithQuantityDefault = { quantityDefault?: number };

/** ---------------- Core schema (as you designed) ---------------- */

export interface BaseFieldUI {
    name?: string;
    label: string;
    required?: boolean;
    /** Host-defined prop names → typed UI nodes */
    ui?: Record<string, Ui>;
    /** Host-defined prop names → runtime default values (untyped base) */
    defaults?: Record<string, unknown>;
}

const ui: Record<string, Ui> = {
    multiselect: {
        type: "boolean",
    },
    search: {
        type: "boolean",
    },
    autocomplete: {
        type: "boolean",
    },

    autocompleteItems: {
        type: "array",
        item: {
            type: "string",
        }
    }
}

export type Ui = UiString | UiNumber | UiBoolean | UiAnyOf | UiArray | UiObject;

/** string */
export interface UiString {
    type: "string";
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
}

/** number */
export interface UiNumber {
    type: "number";
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
}

/** boolean */
export interface UiBoolean {
    type: "boolean";
}

/** enumerated choices */
export interface UiAnyOf {
    type: "anyOf";
    multiple?: boolean;
    items: Array<{
        type: "string" | "number" | "boolean";
        title?: string;
        description?: string;
        value: string | number | boolean;
    }>;
}

/** arrays: homogeneous (item) or tuple (items) */
export interface UiArray {
    type: "array";
    item?: Ui; // schema for each element (homogeneous)
    items?: Ui[]; // tuple form
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
}

/** objects: nested props */
export interface UiObject {
    type: "object";
    fields: Record<string, Ui>;
    required?: string[]; // nested required
    order?: string[]; // render hint
}

/** ---------------- Typed defaults helpers ---------------- */

/**
 * UiValue<U>: given a Ui node U, infer the runtime value type.
 */
export type UiValue<U extends Ui> =
    // primitives
    U extends { type: "string" }
        ? string
        : U extends { type: "number" }
          ? number
          : U extends { type: "boolean" }
            ? boolean
            : // anyOf
              U extends { type: "anyOf"; multiple: true }
              ? Array<U["items"][number]["value"]>
              : U extends { type: "anyOf" }
                ? U["items"][number]["value"]
                : // array (homogeneous vs tuple)
                  U extends { type: "array"; item: infer I extends Ui }
                  ? Array<UiValue<I>>
                  : U extends { type: "array"; items: infer T extends Ui[] }
                    ? { [K in keyof T]: UiValue<T[K]> }
                    : // object (nested fields)
                      U extends {
                            type: "object";
                            fields: infer F extends Record<string, Ui>;
                        }
                      ? { [K in keyof F]?: UiValue<F[K]> }
                      : unknown;

/**
 * FieldWithTypedDefaults<T>: same shape as BaseFieldUI, but:
 *  - ui is a concrete map T (propName → Ui node)
 *  - defaults are auto-typed from T via UiValue
 */
export type FieldWithTypedDefaults<T extends Record<string, Ui>> = Omit<
    BaseFieldUI,
    "ui" | "defaults"
> & {
    ui: T;
    defaults?: Partial<{ [K in keyof T]: UiValue<T[K]> }>;
};

export type FieldOption = {
    id: string;
    label: string;
    value?: string | number;
    service_id?: number;
    pricing_role?: PricingRole;
    meta?: Record<string, unknown> & UtilityMark & WithQuantityDefault;
};

export type Field = BaseFieldUI & {
    id: string;
    type: FieldType; // only 'custom' is reserved
    bind_id?: string | string[];
    name?: string; // omit if options map to services
    options?: FieldOption[];
    component?: string; // required if type === 'custom'
    pricing_role?: PricingRole; // default 'base'
    meta?: Record<string, unknown> & QuantityMark & UtilityMark;
} & (
        | {
              button?: false;
              service_id?: undefined;
          }
        | {
              button: true;
              service_id?: number;
          }
    );

export type FlagKey = "refill" | "cancel" | "dripfeed";
export type Tag = {
    id: string;
    label: string;
    bind_id?: string;
    service_id?: number;
    includes?: string[];
    excludes?: string[];
    meta?: Record<string, unknown> & WithQuantityDefault;
    /**
     * Which flags are set for this tag. If a flag is not set, it's inherited from the nearest ancestor with a value set.
     */
    constraints?: Partial<Record<FlagKey, boolean>>;
    /** Which ancestor defined the *effective* value for each flag (nearest source). */
    constraints_origin?: Partial<Record<FlagKey, string>>; // tagId

    /**
     * Present only when a child explicitly set a different value but was overridden
     * by an ancestor during normalisation.
     */
    constraints_overrides?: Partial<
        Record<
            FlagKey,
            { from: boolean; to: boolean; origin: string } // child explicit -> effective + where it came from
        >
    >;
};

export type ServiceProps = {
    order_for_tags?: Record<string, string[]>;
    filters: Tag[];
    fields: Field[];
    includes_for_buttons?: Record<string, string[]>;
    excludes_for_buttons?: Record<string, string[]>;
    schema_version?: string;
    fallbacks?: ServiceFallback;
};

// Ids
export type ServiceIdRef = number | string; // provider service id
export type NodeIdRef = string; // tag.id or option.id

export type ServiceFallback = {
    /** Node-scoped fallbacks: prefer these when that node’s primary service fails */
    nodes?: Record<NodeIdRef, ServiceIdRef[]>;
    /** Primary→fallback list used when no node-scoped entry is present */
    global?: Record<ServiceIdRef, ServiceIdRef[]>;
};
