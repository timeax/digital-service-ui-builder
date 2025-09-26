import {ServiceProps} from "../../schema";

/** Minimal service capability shape for the demo */
type DgpServiceMap = Record<
    number,
    { id: number; rate: number; refill?: boolean; cancel?: boolean; dripfeed?: boolean }
>;

/** --- Demo data (small but rich enough to visualize) ----------------------- */
const initialProps: ServiceProps = {
    // TAGS (filters)
    filters: [
        {id: "root", label: "Root"},
        {id: "T", label: "Site Builder", bind_id: "root"},
        {id: "Extras", label: "Extras", bind_id: "root", constraints: {cancel: true}},
    ],

    // FIELDS
    fields: [
        // Toggle (reveals base + util under T when "on")
        {
            id: "toggle",
            label: "Enable site package",
            type: "radio",
            bind_id: "T",
            options: [
                {id: "on", label: "On"},
                {id: "off", label: "Off"},
            ],
        },
        // Base service field (becomes visible when toggle:on)
        {
            id: "base",
            label: "Site Type",
            type: "select",
            bind_id: "T",
            pricing_role: "base", // default role for its options unless overridden
            options: [
                {id: "starter", label: "Starter (basic)", service_id: 1}, // role inherits 'base'
            ],
        },
        // Utility field (also revealed by toggle:on)
        {
            id: "theme",
            label: "Theme",
            type: "select",
            bind_id: "T",
            options: [
                {id: "free", label: "Free Theme", service_id: 2, pricing_role: "utility"},
                {id: "pro", label: "Pro Theme", service_id: 3, pricing_role: "utility"},
            ],
        },
        // A user-input field (to show mixed field types)
        {
            id: "site_name",
            label: "Site Name",
            type: "text",
            bind_id: "T",
            name: "site_name",
            placeholder: "Acme Inc.",
            helperText: "What should we call the website?",
            helperTextPos: "bottom",
            labelClassName: "",
            required: true,
            axis: "y",
            labelAxis: "y",
            extra: null,
        },
        // Something bound under Extras to show another branch
        {
            id: "extras_field",
            label: "Maintenance Plan",
            type: "select",
            bind_id: "Extras",
            options: [
                {id: "none", label: "None"},
                {id: "monthly", label: "Monthly", service_id: 4, pricing_role: "utility"},
            ],
        },
    ],

    // Option-level visibility: selecting toggle:on reveals base + theme
    includes_for_options: {
        "toggle::on": ["base", "theme"],
    },
    excludes_for_options: {
        "toggle::off": ["base", "theme"],
    },
};

const serviceMap: DgpServiceMap = {
    1: {id: 1, rate: 20, cancel: true},        // base
    2: {id: 2, rate: 0},                        // utility (free theme)
    3: {id: 3, rate: 30},                       // utility (pro theme)
    4: {id: 4, rate: 10, refill: false, cancel: true}, // addon under Extras
};

export {initialProps, serviceMap};