import { DgpServiceMap } from "./provider";

export type ValidationCode =
    // structure
    | "root_missing"
    | "cycle_in_tags"
    | "bad_bind_reference"
    // identity & labels
    | "duplicate_id"
    | "duplicate_tag_label"
    | "duplicate_field_name"
    | "label_missing"
    // visibility & option maps
    | "duplicate_visible_label"
    | "bad_option_key"
    | "option_include_exclude_conflict"
    // service/input
    | "service_field_missing_service_id"
    | "user_input_field_has_service_option"
    // rates & pricing roles
    | "rate_mismatch_across_base"
    | "utility_without_base"
    // constraints
    | "unsupported_constraint"
    | "constraint_contradiction"
    // custom component
    | "custom_component_missing"
    | "policy_violation"
    | "field_unbound"
    | "constraint_overridden"
    | "unsupported_constraint_option" // option's service can't meet T's effective constraint
    | "custom_component_unresolvable"
    // utilities / quantity markers
    | "quantity_multiple_markers"
    | "utility_with_service_id"
    | "utility_missing_rate"
    | "utility_invalid_mode"
    // fallbacks
    | "fallback_bad_node"
    | "fallback_unknown_service"
    | "fallback_cycle"
    | "fallback_no_primary"
    | "fallback_rate_violation"
    | "fallback_constraint_mismatch"
    | "fallback_no_tag_context";

export type ValidationError = {
    code: ValidationCode;
    nodeId?: string; // tag/field/option id
    details?: Record<string, unknown> & {
        affectedIds?: string[];
    };
};

// add near DynamicRule (above it or just below ValidationError)

export type ServiceWhereOp =
    | "eq"
    | "neq"
    | "in"
    | "nin"
    | "exists"
    | "truthy"
    | "falsy";

/**
 * Host-extensible service filter clause.
 * `path` should usually be "service.<prop>" or "service.meta.<prop>" etc.
 */
export type ServiceWhereClause = {
    path: string;
    op?: ServiceWhereOp;
    value?: unknown;
};

export type DynamicRule = {
    id: string;
    scope: "global" | "visible_group";
    subject: "services";

    /**
     * Package-level filter surface:
     * - role/tag/field are core to the builder schema
     * - where[] allows hosts to filter against extra service properties (handler_id/platform_id/type/key/category_id/etc.)
     */
    filter?: {
        role?: "base" | "utility" | "both";
        tag_id?: string | string[];
        field_id?: string | string[];

        where?: ServiceWhereClause[];
    };

    /**
     * Projection is intentionally open:
     * hosts may project custom service properties.
     */
    projection?:
        | "service.id"
        | "service.name"
        | "service.rate"
        | "service.min"
        | "service.max"
        | "service.category"
        | string;

    op:
        | "all_equal"
        | "unique"
        | "no_mix"
        | "all_true"
        | "any_true"
        | "max_count"
        | "min_count";

    value?: number | boolean; // for max/min/all_true/any_true
    severity?: "error" | "warning";
    message?: string;
};

export type ValidatorOptions = {
    serviceMap?: DgpServiceMap;
    allowUnsafe?: boolean;
    selectedOptionKeys?: string[];
    globalUtilityGuard?: boolean;
    policies?: DynamicRule[]; // ← dynamic rules from super admin
    fallbackSettings?: FallbackSettings;
};

export type RatePolicy =
    | { kind: "lte_primary" }
    | { kind: "within_pct"; pct: number }
    | {
          kind: "at_least_pct_lower";
          pct: number;
      };

export type FallbackSettings = {
    /** Require fallbacks to satisfy tag constraints (dripfeed/refill/cancel) when a tag context is known. Default: true */
    requireConstraintFit?: boolean;
    /** Rate rule policy. Default: { kind: 'lte_primary' } i.e. candidate.rate <= primary.rate */
    ratePolicy?: RatePolicy;
    /** When multiple candidates remain, choose first (priority) or cheapest. Default: 'priority' */
    selectionStrategy?: "priority" | "cheapest";
    /** Validation mode: 'strict' → node-scoped violations reported as ValidationError; 'dev' → only collect diagnostics. Default: 'strict' */
    mode?: "strict" | "dev";
};
