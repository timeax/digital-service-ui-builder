import {describe, it, expect} from 'vitest';

import {buildOrderSnapshot} from '../build-order-snapshot';
import type {BuildOrderSelection} from '../build-order-snapshot';

import type {Builder} from '../../core';
import type {ServiceProps, Field, FieldOption, Tag} from '../../schema';
import type {DgpServiceMap} from '../../schema/provider';

/* ───────────────── helpers ───────────────── */

function makeBuilderVisibleFields(visible: string[]): Builder {
    // We only need visibleFields() for these tests
    const b = {
        visibleFields: (tagId: string, _selected?: string[]) => visible.slice(),
    } as unknown as Builder;
    return b;
}

function tag(id: string, label: string, service_id?: number): Tag {
    return {
        id,
        label,
        ...(service_id !== undefined ? {service_id} : {}),
    } as Tag;
}

function field(
    id: string,
    bind_id: string | string[],
    options?: FieldOption[],
): Field {
    return {
        id,
        type: 'select',
        bind_id,
        label: id,
        options: options ?? [],
    } as Field;
}

function opt(id: string, label: string, service_id?: number, pricing_role: 'base' | 'utility' = 'base'): FieldOption {
    const o: FieldOption = {id, label, ...(service_id !== undefined ? {service_id} : {}), pricing_role};
    return o;
}

function baseProps(tags: Tag[], fields: Field[]): ServiceProps {
    return {
        filters: tags,
        fields,
        schema_version: '1.0',
        // no fallbacks here; we’re testing service composition only
    };
}

/* ───────────────── fixtures ───────────────── */

const svcMap: DgpServiceMap = {
    1: {id: 1, rate: 100},
    10: {id: 10, rate: 90},
    11: {id: 11, rate: 80},
    99: {id: 99, rate: 70},
};

/* ───────────────── tests ───────────────── */

describe('buildOrderSnapshot — service composition', () => {
    it('uses tag service as default when no option with service_id is selected', () => {
        const tags = [tag('t:root', 'Root', 1)];
        const fA = field('fA', 't:root', [opt('o:A1', 'A1'), opt('o:A2', 'A2')]); // no service ids
        const props = baseProps(tags, [fA]);

        const builder = makeBuilderVisibleFields(['fA']);
        const selection: BuildOrderSelection = {
            activeTagId: 't:root',
            formValuesByFieldId: {},
            optionSelectionsByFieldId: {fA: ['o:A1']}, // selected but no service_id on option
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {mode: 'prod'});

        expect(snap.services).toEqual([1]);
        expect(snap.serviceMap).toEqual({'t:root': [1]});
    });

    it('first selected option with service_id overrides tag default as primary; others append (selection order)', () => {
        const tags = [tag('t:root', 'Root', 1)];
        const fA = field('fA', 't:root', [
            opt('o:A1', 'A1', 10), // has service → should become primary, overrides tag default
            opt('o:A2', 'A2', 11), // appended after
        ]);
        const props = baseProps(tags, [fA]);

        const builder = makeBuilderVisibleFields(['fA']);

        const selection: BuildOrderSelection = {
            activeTagId: 't:root',
            formValuesByFieldId: {},
            optionSelectionsByFieldId: {fA: ['o:A1', 'o:A2']},
            optionTraversalOrder: [
                {fieldId: 'fA', optionId: 'o:A1'},
                {fieldId: 'fA', optionId: 'o:A2'},
            ],
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {mode: 'prod'});

        // primary is 10 (o:A1), then 11 (o:A2)
        expect(snap.services).toEqual([10, 11]);
        // serviceMap records true origins; tag default is NOT kept because it was overridden
        expect(snap.serviceMap).toEqual({
            'o:A1': [10],
            'o:A2': [11],
        });
        // ensure tag->service mapping is absent when overridden
        expect(Object.keys(snap.serviceMap)).not.toContain('t:root');
    });

    it('ignores options from non-visible fields', () => {
        const tags = [tag('t:root', 'Root', 1), tag('t:other', 'Other')];
        const fA = field('fA', 't:root', [opt('o:A1', 'A1', 10)]);
        const fB = field('fB', 't:other', [opt('o:B1', 'B1', 99)]); // not visible for t:root
        const props = baseProps(tags, [fA, fB]);

        const builder = makeBuilderVisibleFields(['fA']); // ONLY fA visible in this context

        const selection: BuildOrderSelection = {
            activeTagId: 't:root',
            formValuesByFieldId: {},
            optionSelectionsByFieldId: {
                fA: ['o:A1'],
                fB: ['o:B1'], // should be ignored (field not visible for active tag)
            },
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {mode: 'prod'});

        expect(snap.services).toEqual([10]); // o:B1(99) ignored
        expect(snap.serviceMap).toEqual({'o:A1': [10]});
        expect(Object.keys(snap.serviceMap)).not.toContain('o:B1');
    });

    it('dedupes services list when multiple selected options map to the same service_id', () => {
        const tags = [tag('t:root', 'Root')];
        const fA = field('fA', 't:root', [
            opt('o:A1', 'A1', 10),
            opt('o:A2', 'A2', 10), // same service id as A1
        ]);
        const props = baseProps(tags, [fA]);

        const builder = makeBuilderVisibleFields(['fA']);
        const selection: BuildOrderSelection = {
            activeTagId: 't:root',
            formValuesByFieldId: {},
            optionSelectionsByFieldId: {fA: ['o:A1', 'o:A2']},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {mode: 'prod'});

        // Services list is deduped (single 10), but serviceMap keeps both origins
        expect(snap.services).toEqual([10]);
        expect(snap.serviceMap).toEqual({
            'o:A1': [10],
            'o:A2': [10],
        });
    });

    it('ignores misconfigured utilities that carry a service_id (defensive guard)', () => {
        const tags = [tag('t:root', 'Root', 1)];
        const fA = field('fA', 't:root', [
            opt('o:U1', 'U1', 10, 'utility'), // should be ignored (utility with service_id)
            opt('o:B1', 'B1', 11, 'base'),    // valid service
        ]);
        const props = baseProps(tags, [fA]);

        const builder = makeBuilderVisibleFields(['fA']);
        const selection: BuildOrderSelection = {
            activeTagId: 't:root',
            formValuesByFieldId: {},
            optionSelectionsByFieldId: {fA: ['o:U1', 'o:B1']},
            optionTraversalOrder: [
                {fieldId: 'fA', optionId: 'o:U1'},
                {fieldId: 'fA', optionId: 'o:B1'},
            ],
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {mode: 'prod'});

        // Only the base-role option contributes a service; tag default is overridden
        expect(snap.services).toEqual([11]);
        expect(snap.serviceMap).toEqual({'o:B1': [11]});
        expect(Object.keys(snap.serviceMap)).not.toContain('o:U1');
        expect(Object.keys(snap.serviceMap)).not.toContain('t:root');
    });
});