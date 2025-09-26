import {describe, it, expect} from 'vitest';
import {validate} from '../validate';
import type {ServiceProps} from '../../schema';
import type {DgpServiceMap} from '../../schema/provider';
import type {DynamicRule} from '../../schema/validation';

describe('validate() dynamic policies', () => {
    const baseProps: ServiceProps = {
        filters: [{id: 'root', label: 'Root'}, {id: 'A', label: 'A', bind_id: 'root'}],
        fields: [
            {
                id: 'f1',
                label: 'Base A',
                type: 'select',
                bind_id: 'A',
                options: [
                    {id: 'o1', label: 'S-1', service_id: 1, pricing_role: 'base'},
                    {id: 'o2', label: 'S-2', service_id: 2, pricing_role: 'base'},
                ],
            },
            {
                id: 'f2',
                label: 'Util A',
                type: 'select',
                bind_id: 'A',
                options: [{id: 'u1', label: 'U-1', service_id: 3, pricing_role: 'utility'}],
            },
        ],
    };

    const serviceMap: DgpServiceMap = {
        1: {id: 1, key: 'k1', rate: 10, handler_id: 9, platform_id: 100, dripfeed: true, meta: {type: 'alpha'} as any},
        2: {id: 2, key: 'k2', rate: 10, handler_id: 9, platform_id: 100, dripfeed: true, meta: {type: 'alpha'} as any},
        3: {id: 3, key: 'k1', rate: 5, handler_id: 7, platform_id: 200, dripfeed: false, meta: {type: 'beta'} as any},
    };

    it('visible_group: all_equal on service type passes when equal', () => {
        const rules: DynamicRule[] = [{
            id: 'grp-type-eq',
            scope: 'visible_group',
            subject: 'services',
            filter: {role: 'base'},
            projection: 'service.type',  // from meta.type above
            op: 'all_equal',
            message: 'Base services in a group must share the same type'
        }];

        const out = validate(baseProps, {serviceMap, policies: rules});
        expect(out.some(e => e.code === 'policy_violation' && e.details?.ruleId === 'grp-type-eq')).toBe(false);
    });

    it('visible_group: no_mix handler_id fails when handlers differ', () => {
        // Make one base use a different handler
        const props: ServiceProps = JSON.parse(JSON.stringify(baseProps));
        (props.fields[0].options![1] as any).service_id = 3; // handler 7 vs 9
        const rules: DynamicRule[] = [{
            id: 'grp-no-mix-handler',
            scope: 'visible_group',
            subject: 'services',
            filter: {role: 'base'},
            projection: 'service.handler_id',
            op: 'no_mix',
            message: 'Do not mix providers in one group',
        }];

        const out = validate(props, {serviceMap, policies: rules});
        expect(out.some(e => e.code === 'policy_violation' && e.details?.ruleId === 'grp-no-mix-handler' && e.nodeId === 'A')).toBe(true);
    });

    it('global: unique key fails if duplicate provider keys exist', () => {
        // k1 appears on service 1 and 3 globally
        const rules: DynamicRule[] = [{
            id: 'global-unique-key',
            scope: 'global',
            subject: 'services',
            projection: 'service.key',
            op: 'unique',
            message: 'Provider keys must be unique globally',
        }];

        const out = validate(baseProps, {serviceMap, policies: rules});
        expect(out.some(e => e.code === 'policy_violation' && e.details?.ruleId === 'global-unique-key' && e.nodeId === 'global')).toBe(true);
    });

    it('visible_group: all_true dripfeed fails if any is false', () => {
        const rules: DynamicRule[] = [{
            id: 'grp-dripfeed-alltrue',
            scope: 'visible_group',
            subject: 'services',
            projection: 'service.dripfeed',
            filter: {role: 'both'},
            op: 'all_true',
        }];

        const out = validate(baseProps, {serviceMap, policies: rules});
        // service 3 (utility) has dripfeed false → violation on tag A
        expect(out.some(e => e.code === 'policy_violation' && e.details?.ruleId === 'grp-dripfeed-alltrue' && e.nodeId === 'A')).toBe(true);
    });

    it('visible_group: max_count base=1 fails with two base items', () => {
        const rules: DynamicRule[] = [{
            id: 'grp-max-one-base',
            scope: 'visible_group',
            subject: 'services',
            filter: {role: 'base'},
            op: 'max_count',
            value: 1,
        }];

        const out = validate(baseProps, {serviceMap, policies: rules});
        expect(out.some(e => e.code === 'policy_violation' && e.details?.ruleId === 'grp-max-one-base' && e.nodeId === 'A')).toBe(true);
    });
});