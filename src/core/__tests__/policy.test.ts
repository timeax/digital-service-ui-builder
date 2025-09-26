import {describe, it, expect} from 'vitest';
import {compilePolicies, splitPolicyDiagnostics} from '../policy';

describe('compilePolicies()', () => {
    it('defaults scope/subject/filter.role/severity/projection', () => {
        const raw = [{id: 'r1', op: 'unique'}];
        const {policies, diagnostics} = compilePolicies(raw);

        expect(policies[0]).toMatchObject({
            id: 'r1',
            scope: 'visible_group',
            subject: 'services',
            filter: {role: 'both'},
            severity: 'error',
            projection: 'service.id',
            op: 'unique',
        });
        expect(diagnostics.length).toBe(0);
    });

    it('generates id when missing and warns', () => {
        const {policies, diagnostics} = compilePolicies([{op: 'unique'}]);
        expect(policies[0].id).toMatch(/^policy_\d+$/);
        const {warnings} = splitPolicyDiagnostics(diagnostics);
        expect(warnings.some(w => /Missing "id"/.test(w.message))).toBe(true);
    });

    it('errors on invalid op and on missing numeric value for max_count', () => {
        const {policies, diagnostics} = compilePolicies([
            {id: 'bad1', op: 'nope'},
            {id: 'bad2', op: 'max_count'},
        ]);
        expect(policies.length).toBe(0);
        const {errors} = splitPolicyDiagnostics(diagnostics);
        expect(errors.some(e => e.path === 'op')).toBe(true);
        expect(errors.some(e => e.path === 'value')).toBe(true);
    });

    it('warns when projection for services does not start with service.', () => {
        const {diagnostics} = compilePolicies([{id: 'r', op: 'unique', projection: 'key'}]);
        const {warnings} = splitPolicyDiagnostics(diagnostics);
        expect(warnings.some(w => w.path === 'projection')).toBe(true);
    });

    it('warns when value is provided but unused for all_true/any_true', () => {
        const {diagnostics} = compilePolicies([
            {id: 'r1', op: 'all_true', value: true},
            {id: 'r2', op: 'any_true', value: false},
        ]);
        const {warnings} = splitPolicyDiagnostics(diagnostics);
        expect(warnings.filter(w => w.path === 'value').length).toBe(2);
    });

    it('accepts arrays or scalars in filter ids and defaults role', () => {
        const {policies} = compilePolicies([
            {id: 'filt', op: 'unique', filter: {handler_id: 7, platform_id: [1, 2]}},
        ]);
        expect(policies[0].filter?.handler_id).toEqual([7]);
        expect(policies[0].filter?.platform_id).toEqual([1, 2]);
        expect(policies[0].filter?.role).toBe('both');
    });
});