// playground/src/data.ts
import { ServiceProps } from "digital-service-ui-builder";

/** Minimal service capability shape for the demo */
type DgpServiceMap = Record<
    number,
    {
        id: number;
        name: string;
        rate: number;
        refill?: boolean;
        cancel?: boolean;
        dripfeed?: boolean;
    }
>;

/** --- Demo data (expanded to showcase richer schema) ----------------------- */
const initialProps: ServiceProps = {
    // TAGS (filters)
    filters: [
        { id: "t:root", label: "Root" },
        { id: "t:T", label: "Site Builder", bind_id: "t:root" },
        {
            id: "t:Extras",
            label: "Extras",
            bind_id: "t:root",
            constraints: { cancel: true },
        },
        // Additional branches
        {
            id: "t:CMS",
            label: "Content Management",
            bind_id: "t:T",
            constraints: { cancel: false },
        },
        {
            id: "t:Ecom",
            label: "E-commerce",
            bind_id: "t:T",
            constraints: { cancel: true },
        },
    ],

    // FIELDS
    fields: [
        // Toggle (reveals base + util under T when "on")
        {
            id: "f:toggle",
            label: "Enable site package",
            type: "radio",
            bind_id: "t:T",
            ui: {
                tooltip: { type: "string", maxLength: 120 },
                emphasize: { type: "boolean" },
            },
            defaults: {
                tooltip: "Turn on to configure your site",
                emphasize: true,
            },
            options: [
                { id: "o:on", label: "On" },
                { id: "o:off", label: "Off" },
            ],
        },

        // Base service field (becomes visible when toggle:on)
        {
            id: "f:base",
            label: "Site Type",
            type: "select",
            bind_id: "t:T",
            pricing_role: "base", // default role for its options unless overridden
            ui: {
                helpText: { type: "string", maxLength: 240 },
            },
            defaults: {
                helpText: "Choose the foundation for your project",
            },
            options: [
                { id: "o:starter", label: "Starter (basic)", service_id: 1 }, // role inherits 'base'
                { id: "o:cms", label: "CMS Site", service_id: 8 },
                { id: "o:store", label: "Online Store", service_id: 7 },
            ],
        },

        // Theme utility (also revealed by toggle:on)
        {
            id: "f:theme",
            label: "Theme",
            type: "select",
            bind_id: "t:T",
            ui: {
                showPreview: { type: "boolean" },
            },
            defaults: { showPreview: true },
            options: [
                {
                    id: "o:free",
                    label: "Free Theme",
                    service_id: 2,
                    pricing_role: "utility",
                },
                {
                    id: "o:pro",
                    label: "Pro Theme",
                    service_id: 3,
                    pricing_role: "utility",
                },
            ],
        },

        // Hosting utilities
        {
            id: "f:hosting",
            label: "Hosting",
            type: "select",
            bind_id: "t:T",
            options: [
                {
                    id: "o:basic",
                    label: "Basic",
                    service_id: 5,
                    pricing_role: "utility",
                },
                {
                    id: "o:pro",
                    label: "Pro",
                    service_id: 6,
                    pricing_role: "utility",
                },
            ],
        },

        // Feature bundle that reveals nested backup plan when selected
        {
            id: "f:addons",
            label: "Add-ons",
            type: "select",
            bind_id: "t:Extras",
            ui: {
                description: { type: "string", maxLength: 200 },
                allowMultiple: { type: "boolean" },
            },
            defaults: {
                description: "Optional enhancements",
                allowMultiple: false,
            },
            options: [
                { id: "o:none", label: "None" },
                {
                    id: "o:support",
                    label: "Priority Support",
                    service_id: 9,
                    pricing_role: "utility",
                },
                { id: "o:backup", label: "Backups", pricing_role: "utility" },
                {
                    id: "o:seo",
                    label: "SEO Package",
                    service_id: 12,
                    pricing_role: "utility",
                },
            ],
        },
        {
            id: "f:backup_plan",
            label: "Backup Plan",
            type: "select",
            bind_id: "t:Extras",
            options: [
                {
                    id: "o:daily",
                    label: "Daily",
                    service_id: 10,
                    pricing_role: "utility",
                    meta: {
                        utility: {
                            rate: 8,
                            mode: "flat",
                            label: "Daily backup",
                        },
                    },
                },
                {
                    id: "o:hourly",
                    label: "Hourly",
                    service_id: 11,
                    pricing_role: "utility",
                    meta: {
                        utility: {
                            rate: 20,
                            mode: "flat",
                            label: "Hourly backup",
                        },
                    },
                },
            ],
        },

        // A user-input field (to show mixed field types)
        {
            id: "f:site_name",
            label: "Site Name",
            type: "text",
            bind_id: "t:T",
            name: "site_name",
            ui: {
                placeholder: { type: "string", maxLength: 60 },
                slugify: { type: "boolean" },
            },
            defaults: { placeholder: "e.g. acme-co", slugify: true },
        },

        // Page count influences quantity in pricing
        {
            id: "f:pages",
            label: "Estimated Pages",
            type: "number",
            bind_id: "t:T",
            name: "pages",
            meta: {
                quantity: {
                    valueBy: "value",
                    multiply: 1,
                    clamp: { min: 1, max: 500 },
                    fallback: 5,
                },
            },
            ui: {
                min: { type: "number", minimum: 1 },
                max: { type: "number", maximum: 1000 },
            },
            defaults: { min: 1, max: 100 },
        },

        // Something bound under CMS branch
        {
            id: "f:cms_features",
            label: "CMS Features",
            type: "select",
            bind_id: "t:CMS",
            options: [
                {
                    id: "o:analytics",
                    label: "Analytics",
                    service_id: 13,
                    pricing_role: "utility",
                },
                { id: "o:drafts", label: "Drafts" },
            ],
        },

        // Something bound under E-commerce branch
        {
            id: "f:ecom_features",
            label: "Store Features",
            type: "select",
            bind_id: "t:Ecom",
            options: [
                { id: "o:coupons", label: "Coupons" },
                {
                    id: "o:abandoned_cart",
                    label: "Abandoned Cart",
                    service_id: 7,
                    pricing_role: "utility",
                },
            ],
        },

        // Example of a custom component field with nested UI schema
        {
            id: "f:branding",
            label: "Branding",
            type: "custom",
            component: "BrandingEditor",
            bind_id: "t:T",
            ui: {
                palette: {
                    type: "object",
                    fields: {
                        primary: { type: "string" },
                        secondary: { type: "string" },
                        darkMode: { type: "boolean" },
                    },
                    required: ["primary"],
                    order: ["primary", "secondary", "darkMode"],
                },
                logo: { type: "string" },
            },
            defaults: {
                palette: {
                    primary: "#0055ff",
                    secondary: "#00cc88",
                    darkMode: false,
                },
                logo: "",
            },
        },

        // Something bound under Extras to show another branch
        {
            id: "f:extras_field",
            label: "Maintenance Plan",
            type: "select",
            bind_id: "t:Extras",
            options: [
                { id: "o:none", label: "None" },
                {
                    id: "o:monthly",
                    label: "Monthly",
                    service_id: 4,
                    pricing_role: "utility",
                },
            ],
        },

        // --- Non option-based BUTTON fields (actions) ---
        {
            id: "f:btn_generate",
            label: "Generate Draft",
            type: "button",
            bind_id: "t:T",
            ui: {
                style: { type: "string", enum: ["primary", "secondary"] },
                icon: { type: "string" },
            },
            defaults: { style: "primary", icon: "Sparkles" },
            meta: { action: "generate_draft" },
        },
        {
            id: "f:btn_publish",
            label: "Publish",
            type: "button",
            bind_id: "t:T",
            ui: {
                style: {
                    type: "string",
                    enum: ["danger", "primary", "secondary"],
                },
                confirm: { type: "boolean" },
            },
            defaults: { style: "danger", confirm: true },
            meta: { action: "publish" },
        },
    ],

    // Option-level visibility (buttons map) — keys are just the OPTION IDs (no field prefix)
    includes_for_buttons: {
        // selecting "on" reveals core configuration (and shows the new action buttons)
        "o:on": [
            "f:base",
            "f:theme",
            "f:hosting",
            "f:site_name",
            "f:pages",
            "f:addons",
            "f:branding",
            "f:cms_features",
            "f:ecom_features",
            "f:btn_generate",
            "f:btn_publish",
        ],

        // selecting add-ons → backup reveals backup plan
        "o:backup": ["f:backup_plan"],

        // Choosing base types can reveal branch-specific fields
        "o:cms": ["f:cms_features"],
        "o:store": ["f:ecom_features"],
    },
    excludes_for_buttons: {
        "o:off": [
            "f:base",
            "f:theme",
            "f:hosting",
            "f:site_name",
            "f:pages",
            "f:addons",
            "f:backup_plan",
            "f:branding",
            "f:cms_features",
            "f:ecom_features",
            "f:btn_generate",
            "f:btn_publish",
        ],
    },

    // Provide a schema version and some example fallbacks
    schema_version: "1.1.0",
    fallbacks: {
        nodes: {
            "f:theme": [2, 3],
            "o:store": [7],
        },
        global: {
            3: [2],
            6: [5],
        },
    },
};

const serviceMap: DgpServiceMap = {
    1: { id: 1, name: "Starter (basic)", rate: 20, cancel: true }, // base: starter
    2: { id: 2, name: "Free Theme", rate: 0 }, // utility (free theme)
    3: { id: 3, name: "Pro Theme", rate: 30 }, // utility (pro theme)
    4: {
        id: 4,
        name: "Maintenance – Monthly",
        rate: 10,
        refill: false,
        cancel: true,
    }, // addon under Extras
    5: { id: 5, name: "Hosting Basic", rate: 5 }, // hosting basic
    6: { id: 6, name: "Hosting Pro", rate: 15, cancel: true }, // hosting pro
    7: { id: 7, name: "Online Store", rate: 50 }, // ecommerce module / store features
    8: { id: 8, name: "CMS Site", rate: 25 }, // cms base
    9: { id: 9, name: "Priority Support", rate: 40, cancel: true }, // priority support
    10: { id: 10, name: "Daily Backup", rate: 8 }, // backup daily
    11: { id: 11, name: "Hourly Backup", rate: 20 }, // backup hourly
    12: { id: 12, name: "SEO Package", rate: 12 }, // SEO package
    13: { id: 13, name: "Analytics", rate: 6 }, // Analytics
};

export { initialProps, serviceMap };
