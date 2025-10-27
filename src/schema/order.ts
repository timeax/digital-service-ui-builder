// src/schema/order.ts
import { UtilityMark, WithQuantityDefault } from "./index";

export interface ButtonValue {
    id: string; // option id OR field id (for option-less buttons)
    value: string | number; // host’s payload
    // Enrichment added by InputWrapper (not required from host):
    service_id?: number;
    pricing_role?: "base" | "utility";
    meta?: Record<string, unknown> & UtilityMark & WithQuantityDefault;
}
// Primitive values a client can send for form inputs and utility inputs.
export type Scalar = string | number | boolean | ButtonValue | null;

// How utility charges apply.
export type UtilityMode = "flat" | "per_quantity" | "per_value" | "percent";

// Quantity “marker” contract hosts can place under Field.meta.quantity.
export type QuantityRule = {
    valueBy: "value" | "length" | "eval";
    code?: string; // optional client-side evaluator (use with care / sandbox)
};

// One utility line item derived from a field/option marked as pricing_role: 'utility'.
export type UtilityLineItem = {
    nodeId: string; // fieldId or optionId that carries the utility marker
    mode: UtilityMode;
    rate: number; // finite number (validated)
    inputs: {
        quantity: number; // resolved snapshot quantity
        value?: Scalar | Scalar[]; // present for per_value modes (when applicable)
        valueBy?: "value" | "length" | "eval";
        evalCodeUsed?: boolean; // true if client executed an eval path
    };
};

// Fallbacks shape stored on ServiceProps (formalized).
export type ServiceFallbacks = {
    nodes?: Record<string, Array<string | number>>; // nodeId -> candidate service ids
    global?: Record<string | number, Array<string | number>>; // primary -> candidate service ids
};

// Dev-only diagnostics for pruned/flagged fallbacks.
export type FallbackDiagnostics = {
    scope: "node" | "global";
    nodeId?: string; // for scope:'node'
    primary: string | number;
    candidate: string | number;
    reasons: Array<
        | "rate_violation"
        | "constraint_mismatch"
        | "unknown_service"
        | "ambiguous_context"
    >;
};

// Single-tag evaluation context included in the snapshot meta.
export type SnapshotContext = {
    /** The single active tag id for this order */
    tag: string;

    /** Effective (post-propagation) constraints on that tag */
    constraints: Partial<Record<"refill" | "cancel" | "dripfeed", boolean>>;

    /**
     * Per-node evaluation context:
     * - For the active tag node itself: the same tag id.
     * - For an option node: parent's field.bind_id must include this tag to be applicable; otherwise null.
     * - For a field node (optional to include later): same rule as option, derived from field.bind_id.
     */
    nodeContexts: Record<string /* nodeId */, string | null>;

    /** Client pruning policy used (so server can mirror/compare). */
    policy: {
        ratePolicy: { kind: "lte_primary" | "none"; thresholdPct?: number };
        requireConstraintFit: boolean; // node-level constraint enforcement on client
    };
};

// Stable order snapshot contract (client -> server).
export type OrderSnapshot = {
    version: "1";
    mode: "prod" | "dev";
    builtAt: string; // ISO timestamp

    // ── Single-context selection (the only active tag) ──
    selection: {
        tag: string; // tag id (context)
        fields: Array<{
            id: string; // field id
            type: string; // field.type at build time
            selectedOptions?: string[]; // option ids if option-based (always array if present)
        }>;
    };

    // ── Inputs for the backend ──
    inputs: {
        form: Record<string, Scalar | Scalar[]>; // name-keyed values for non-option fields
        selections: Record<string, string[]>; // fieldId -> option ids[]
    };

    // ── Resolved quantity (+ provenance) ──
    quantity: number;
    quantitySource: {
        kind: "field" | "tag" | "option" | "default";
        id?: string; // which field/tag/option provided it
        rule?: QuantityRule; // when kind === 'field'
        defaultedFromHost?: boolean; // true if host default used
    };

    // ── Selected primaries ──
    services: Array<string | number>; // deduped union of all primaries
    serviceMap: Record<string, Array<string | number>>; // nodeId -> primary ids[]

    // ── Client-pruned fallbacks (server will still do final pruning) ──
    fallbacks?: {
        nodes?: Record<string, Array<string | number>>; // only nodes present in this selection
        global?: Record<string | number, Array<string | number>>; // only primaries present in `services`
    };

    // ── Utility line items ──
    utilities?: UtilityLineItem[];

    // ── Dev-only warnings (safe to ignore server-side) ──
    warnings?: {
        utility?: Array<{ nodeId: string; reason: string }>;
        fallbacks?: FallbackDiagnostics[];
    };

    // ── Optional provenance and live context for server-side double-checks ──
    meta?: {
        schema_version?: string;
        workspaceId?: string;
        builder?: { commit?: string };
        context?: SnapshotContext;
    };
};
