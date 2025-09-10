// persisted schema + shared types
export type PricingRole = 'base' | 'utility';
export type FieldType = 'custom' | (string & {});

export interface BaseFieldUI {
    helperText: string;
    helperTextPos: 'bottom';
    name?: string;
    placeholder: string;
    label: string;
    labelClassName: string;
    required: boolean;
    axis: 'y' | 'x';
    labelAxis: 'x' | 'y';
    extra: any;
}

export type FieldOption = {
    id: string;
    label: string;
    value?: string | number;
    service_id?: number;
    pricing_role?: PricingRole;
    meta?: Record<string, unknown>;
};

export type Field = BaseFieldUI & {
    id: string;
    type: FieldType;                 // only 'custom' is reserved
    bind_id?: string | string[];
    name?: string;                   // omit if options map to services
    options?: FieldOption[];
    component?: string;              // required if type === 'custom'
    pricing_role?: PricingRole;      // default 'base'
    meta?: Record<string, unknown>;
};

export type Tag = {
    id: string;
    label: string;
    bind_id?: string;
    service_id?: number;
    constraints?: { refill?: boolean; cancel?: boolean; dripfeed?: boolean };
    includes?: string[];
    excludes?: string[];
    meta?: Record<string, unknown>;
};

export type ServiceProps = {
    filters: Tag[];
    fields: Field[];
    includes_for_options?: Record<string, string[]>;
    excludes_for_options?: Record<string, string[]>;
    schema_version?: string;
};