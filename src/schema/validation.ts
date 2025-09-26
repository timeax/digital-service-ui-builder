import {DgpServiceMap} from "./provider";

export type ValidationCode =
// structure
    | 'root_missing'
    | 'cycle_in_tags'
    | 'bad_bind_reference'
    // identity & labels
    | 'duplicate_id'
    | 'duplicate_tag_label'
    | 'duplicate_field_name'
    | 'label_missing'
    // visibility & option maps
    | 'duplicate_visible_label'
    | 'bad_option_key'
    | 'option_include_exclude_conflict'
    // service/input
    | 'service_field_missing_service_id'
    | 'user_input_field_has_service_option'
    // rates & pricing roles
    | 'rate_mismatch_across_base'
    | 'utility_without_base'
    // constraints
    | 'unsupported_constraint'
    | 'constraint_contradiction'
    // custom component
    | 'custom_component_missing'
    | 'policy_violation'
    | 'field_unbound'
    | 'constraint_overridden'
    | 'unsupported_constraint_option' // option's service can't meet T's effective constraint
    | 'custom_component_unresolvable';

export type ValidationError = {
    code: ValidationCode;
    nodeId?: string;                  // tag/field/option id
    details?: Record<string, unknown>;
};

export type DynamicRule = {
    id: string;
    scope: 'global' | 'visible_group';
    subject: 'services';
    filter?: {
        role?: 'base' | 'utility' | 'both';
        handler_id?: number | number[];
        platform_id?: number | number[];
        tag_id?: string | string[];
        field_id?: string | string[];
    };
    projection?: 'service.type' | 'service.key' | 'service.rate' | 'service.handler_id' | 'service.platform_id' | 'service.dripfeed' | string;
    op: 'all_equal' | 'unique' | 'no_mix' | 'all_true' | 'any_true' | 'max_count' | 'min_count';
    value?: number | boolean;          // for max/min/all_true/any_true
    severity?: 'error' | 'warning';
    message?: string;
};

export type ValidatorOptions = {
    serviceMap?: DgpServiceMap;
    allowUnsafe?: boolean;
    selectedOptionKeys?: string[];
    globalUtilityGuard?: boolean;
    policies?: DynamicRule[];          // ← dynamic rules from super admin
};