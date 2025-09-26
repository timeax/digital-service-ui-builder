// src/core/__tests__/validate.test.ts
import {describe, it, expect} from 'vitest';
import {validate} from '../validate';
import type {ServiceProps, Field} from '../../schema';
import type {DgpServiceMap} from '../../schema/provider';
import {normalise} from "../normalise";

function errs(props: ServiceProps, serviceMap: DgpServiceMap = {}) {
    return validate(props, {serviceMap});
}

describe('validate()', () => {
    it('flags root_missing', () => {
        const out = errs({
            filters: [{id: 't1', label: 'T1'}],
            fields: [],
        });
        expect(out.some(e => e.code === 'root_missing')).toBe(true);
    });

    it('detects cycles and bad bind references (tags & fields)', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'a', label: 'A', bind_id: 'b'},
                {id: 'b', label: 'B', bind_id: 'a'}, // cycle a <-> b
                {id: 'c', label: 'C', bind_id: 'zzz'}, // bad ref
            ],
            fields: [
                {id: 'f1', label: 'F1', type: 'text', name: 'n1', bind_id: 'nope'}, // bad ref
            ],
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'cycle_in_tags')).toBe(true);
        expect(out.find(e => e.code === 'bad_bind_reference' && e.details?.ref === 'zzz')).toBeTruthy();
        expect(out.find(e => e.code === 'bad_bind_reference' && e.details?.ref === 'nope')).toBeTruthy();
    });

    it('flags duplicate_id, duplicate_tag_label, duplicate_field_name, and label_missing', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: ''}, // label_missing
                {id: 'dup', label: 'Same'},
                {id: 't2', label: 'Same'}, // duplicate_tag_label
            ],
            fields: [
                {id: 'dup', label: '   ', type: 'text', name: 'email'}, // duplicate_id + label_missing
                {id: 'f2', label: 'Field', type: 'text', name: 'email'}, // duplicate_field_name
                {
                    id: 'f3',
                    label: 'With options',
                    type: 'select',
                    name: 'shouldNotHaveService',
                    options: [{id: 'o1', label: ''}], // option label_missing
                },
            ],
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'duplicate_id' && e.nodeId === 'dup')).toBe(true);
        expect(out.some(e => e.code === 'duplicate_tag_label')).toBe(true);
        expect(out.some(e => e.code === 'duplicate_field_name' && e.nodeId === 'f2')).toBe(true);
        expect(out.filter(e => e.code === 'label_missing').length).toBeGreaterThanOrEqual(3);
    });

    it('validates option map keys and include/exclude conflicts', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'f1',
                    label: 'Sel',
                    type: 'select',
                    options: [{id: 'o1', label: 'O1'}],
                },
            ],
            includes_for_options: {
                'f1::o1': ['x'],
                'f1::bad': ['y'], // bad key (option not found)
            },
            excludes_for_options: {
                'f1::o1': ['z'], // conflict with includes_for_options
            },
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'bad_option_key' && e.details?.key === 'f1::bad')).toBe(true);
        expect(out.some(e => e.code === 'option_include_exclude_conflict' && e.details?.key === 'f1::o1')).toBe(true);
    });

    it('detects duplicate_visible_label under a tag (bind/include − exclude)', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {id: 'a', label: 'Same Label', type: 'text', name: 'x', bind_id: 'root'},
                {id: 'b', label: 'Same Label', type: 'text', name: 'y', bind_id: 'root'},
            ],
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'duplicate_visible_label')).toBe(true);
    });

    it('service vs user-input rules', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {id: 'svc_missing', label: 'No Name No Service', type: 'select', options: []}, // should require service option
                {
                    id: 'user_with_service',
                    label: 'User Field',
                    type: 'select',
                    name: 'username',
                    options: [{id: 'o1', label: 'O1', service_id: 1}], // not allowed for user-input
                },
                {
                    id: 'custom_with_service',
                    label: 'Custom Svc',
                    type: 'custom',
                    component: 'X/Y',
                    options: [{id: 'o1', label: 'O1', service_id: 2}], // custom cannot map services
                },
            ],
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'service_field_missing_service_id' && e.nodeId === 'svc_missing')).toBe(true);
        expect(out.some(e => e.code === 'user_input_field_has_service_option' && e.nodeId === 'user_with_service')).toBe(true);
        expect(out.some(e => e.code === 'user_input_field_has_service_option' && e.nodeId === 'custom_with_service')).toBe(true);
    });

    it('custom fields must have a component', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [{id: 'c1', label: 'C', type: 'custom'}],
        };
        const out = errs(props);
        expect(out.some(e => e.code === 'custom_component_missing' && e.nodeId === 'c1')).toBe(true);
    });

    it('rate mismatch across BASE options (multi-select) uses DgpServiceMap', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'f_multi',
                    label: 'Multi',
                    type: 'multiselect', // triggers multi
                    options: [
                        {id: 'o1', label: 'A', service_id: 1, pricing_role: 'base'},
                        {id: 'o2', label: 'B', service_id: 2, pricing_role: 'base'},
                        {id: 'o3', label: 'C', service_id: 3, pricing_role: 'utility'}, // utility ignored for rate match
                    ],
                },
            ],
        };
        const serviceMap: DgpServiceMap = {
            1: {id: 1, rate: 10, refill: true, cancel: false, dripfeed: false},
            2: {id: 2, rate: 20, refill: true, cancel: false, dripfeed: false},
            3: {id: 3, rate: 999, refill: true, cancel: true, dripfeed: true},
        };
        const out = errs(props, serviceMap);
        expect(out.some(e => e.code === 'rate_mismatch_across_base' && e.nodeId === 'f_multi')).toBe(true);
    });

    it('utility_without_base (per visible group): utility visible under root but no base → error on root', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'f',
                    label: 'F',
                    type: 'select',
                    bind_id: 'root', // <-- make it visible under root
                    options: [{id: 'oU', label: 'U', service_id: 10, pricing_role: 'utility'}],
                },
            ],
        };
        const serviceMap: DgpServiceMap = {10: {id: 10, rate: 30}};
        const out = validate(props, {serviceMap});
        // error is attached to the TAG (group), with the list of utility option ids
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'root')).toBe(true);
        const err = out.find(e => e.code === 'utility_without_base' && e.nodeId === 'root');
        expect(err?.details?.utilityOptionIds).toContain('oU');
    });

    it('constraints: descendant cannot contradict ancestor; tag promises must be supported by service', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root', constraints: {refill: true}},
                {id: 't1', label: 'Child', bind_id: 'root', constraints: {refill: false}}, // contradiction
                {id: 't2', label: 'SvcTag', service_id: 100, constraints: {cancel: true}}, // unsupported by service
            ],
            fields: [],
        };
        const serviceMap: DgpServiceMap = {
            100: {id: 100, rate: 5, cancel: false, refill: true, dripfeed: true},
        };
        const out = errs(props, serviceMap);
        expect(out.some(e => e.code === 'constraint_contradiction' && e.nodeId === 't1')).toBe(true);
        expect(out.some(e => e.code === 'unsupported_constraint' && e.nodeId === 't2' && e.details?.flag === 'cancel')).toBe(true);
    });

    it('treats meta.multi as multi-select for custom type strings', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'fX',
                    label: 'X',
                    type: 'my_custom_multi', // not a known keyword
                    meta: {multi: true},
                    options: [
                        {id: 'o1', label: 'A', service_id: 1, pricing_role: 'base'},
                        {id: 'o2', label: 'B', service_id: 2, pricing_role: 'base'},
                    ],
                } as unknown as Field,
            ],
        };
        const serviceMap: DgpServiceMap = {
            1: {id: 1, rate: 1},
            2: {id: 2, rate: 2},
        };
        const out = errs(props, serviceMap);
        expect(out.some(e => e.code === 'rate_mismatch_across_base' && e.nodeId === 'fX')).toBe(true);
    });

    it('utility_without_base is scoped per visible tag group', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'A', label: 'Group A', bind_id: 'root'},
                {id: 'B', label: 'Group B', bind_id: 'root'}
            ],
            fields: [
                // Utility under A (provider-backed)
                {
                    id: 'fU',
                    label: 'Theme',
                    type: 'select',
                    bind_id: 'A',
                    options: [{id: 'u1', label: 'Premium', service_id: 3001, pricing_role: 'utility'}]
                },
                // Base under B (provider-backed)
                {
                    id: 'fB',
                    label: 'Site Type',
                    type: 'select',
                    bind_id: 'B',
                    options: [{id: 'b1', label: 'Basic', service_id: 2001, pricing_role: 'base'}]
                }
            ]
        };

        const out = validate(props, {serviceMap: {}});
        // Error only on tag A (its group has utility but no base)
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'A')).toBe(true);
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'B')).toBe(false);
    });

    it('group visibility respects excludes (base excluded → utility_without_base fires)', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root'},
                // Tag T excludes the base field, so only utility remains visible
                {id: 'T', label: 'Group T', bind_id: 'root', excludes: ['fBase']}
            ],
            fields: [
                {
                    id: 'fBase',
                    label: 'Base Choice',
                    type: 'select',
                    bind_id: 'T',
                    options: [{id: 'b1', label: 'Base', service_id: 10, pricing_role: 'base'}]
                },
                {
                    id: 'fUtil',
                    label: 'Add-on',
                    type: 'select',
                    bind_id: 'T',
                    options: [{id: 'u1', label: 'Addon', service_id: 11, pricing_role: 'utility'}]
                }
            ]
        };

        const out = validate(props, {serviceMap: {}});
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'T')).toBe(true);
    });

    it('option-level include/exclude: util included, base excluded → utility_without_base on T', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}, {id: 'T', label: 'Group', bind_id: 'root'}],
            fields: [
                {
                    id: 'toggle',
                    label: 'Toggle',
                    type: 'radio',
                    bind_id: 'T',
                    options: [{id: 'on', label: 'On'}, {id: 'off', label: 'Off'}],
                },
                // Base (bound to T) but will be excluded when toggle:on
                {
                    id: 'base',
                    label: 'Base',
                    type: 'select',
                    bind_id: 'T',
                    options: [{id: 'b', label: 'B', service_id: 1, pricing_role: 'base'}],
                },
                // Utility (bound to T) but only included when toggle:on
                {
                    id: 'util',
                    label: 'Util',
                    type: 'select',
                    bind_id: 'T',
                    options: [{id: 'u', label: 'U', service_id: 2, pricing_role: 'utility'}],
                },
            ],
            includes_for_options: {'toggle::on': ['util']},
            excludes_for_options: {'toggle::on': ['base']}, // <-- hide base when "on"
        };

        const out = validate(props, {selectedOptionKeys: ['toggle::on']});
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'T')).toBe(true);

        const out2 = validate(props, {selectedOptionKeys: ['toggle::off']});
        expect(out2.some(e => e.code === 'utility_without_base' && e.nodeId === 'T')).toBe(false);
    });

    it('option-level exclude hides base; util remains visible → utility_without_base fires', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}, {id: 'T', label: 'Group', bind_id: 'root'}],
            fields: [
                {
                    id: 'toggle', label: 'Toggle', type: 'radio', bind_id: 'T', options: [
                        {id: 'hideBase', label: 'Hide Base'}, {id: 'showAll', label: 'Show All'}
                    ]
                },
                // Base field (bound to T)
                {
                    id: 'base', label: 'Base', type: 'select', bind_id: 'T', options: [
                        {id: 'b', label: 'B', service_id: 1, pricing_role: 'base'}
                    ]
                },
                // Util field (bound to T)
                {
                    id: 'util', label: 'Util', type: 'select', bind_id: 'T', options: [
                        {id: 'u', label: 'U', service_id: 2, pricing_role: 'utility'}
                    ]
                }
            ],
            excludes_for_options: {
                'toggle::hideBase': ['base']
            }
        };

        // Select "hideBase": base excluded → util visible without base → error
        const out = validate(props, {selectedOptionKeys: ['toggle::hideBase']});
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'T')).toBe(true);

        // Select "showAll": nothing excluded → base present → OK
        const out2 = validate(props, {selectedOptionKeys: ['toggle::showAll']});
        expect(out2.some(e => e.code === 'utility_without_base')).toBe(false);
    });

    it('globalUtilityGuard: flags when utilities exist anywhere but no base exists', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'f',
                    label: 'F',
                    type: 'select',
                    bind_id: 'root',
                    options: [{id: 'u', label: 'U', service_id: 10, pricing_role: 'utility'}],
                },
            ],
        };
        const out = validate(props, {globalUtilityGuard: true});
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'global')).toBe(true);
    });

    it('globalUtilityGuard: no error when any base exists anywhere', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'uF',
                    label: 'Util',
                    type: 'select',
                    bind_id: 'root',
                    options: [{id: 'u', label: 'U', service_id: 10, pricing_role: 'utility'}],
                },
                {
                    id: 'bF',
                    label: 'Base',
                    type: 'select',
                    bind_id: 'root',
                    options: [{id: 'b', label: 'B', service_id: 99, pricing_role: 'base'}],
                },
            ],
        };
        const out = validate(props, {globalUtilityGuard: true});
        expect(out.some(e => e.code === 'utility_without_base' && e.nodeId === 'global')).toBe(false);
    });

    it('flags field_unbound when a field is neither bound nor included by tag/option', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {id: 'orphan', label: 'Orphan', type: 'text'},                 // ❌
                {id: 'bound', label: 'Bound', type: 'text', bind_id: 'root'}, // ✅
            ],
        };
        const out = validate(props);
        expect(out.some(e => e.code === 'field_unbound' && e.nodeId === 'orphan')).toBe(true);
        expect(out.some(e => e.code === 'field_unbound' && e.nodeId === 'bound')).toBe(false);
    });

    it('does NOT flag when the field is only included by tag.includes', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root', includes: ['incOnly']}],
            fields: [{id: 'incOnly', label: 'Included', type: 'text'}],
        };
        const out = validate(props);
        expect(out.some(e => e.code === 'field_unbound')).toBe(false);
    });

    it('does NOT flag when the field is only included via includes_for_options', () => {
        const props: ServiceProps = {
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'toggle', label: 'Toggle', type: 'radio', bind_id: 'root',
                    options: [{id: 'on', label: 'On'}]
                },
                {id: 'incByOpt', label: 'IncludedByOption', type: 'text'},
            ],
            includes_for_options: {'toggle::on': ['incByOpt']},
        };
        const out = validate(props);
        expect(out.some(e => e.code === 'field_unbound' && e.nodeId === 'incByOpt')).toBe(false);
    });

    it('validator emits constraint_overridden warnings from normaliser meta', () => {
        const props = normalise({
            filters: [
                { id: 'root', label: 'Root', constraints: { dripfeed: false } },
                { id: 'T', label: 'T', bind_id: 'root', constraints: { dripfeed: true } } // overridden → false
            ],
            fields: []
        });
        const out = validate(props);
        const warn = out.find(e => e.code === 'constraint_overridden' && e.nodeId === 'T');
        expect(warn?.details?.flag).toBe('dripfeed');
        expect(warn?.details?.from).toBe(true);
        expect(warn?.details?.to).toBe(false);
        expect(warn?.details?.origin).toBe('root');
    });
});