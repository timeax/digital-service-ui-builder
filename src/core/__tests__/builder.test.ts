import {describe, it, expect} from 'vitest';
import {createBuilder} from '../builder';
import type {ServiceProps} from '../../schema';
import type {DgpServiceMap} from '../../schema/provider';

describe('Builder', () => {
    it('load() normalises payload and builds indices', () => {
        const b = createBuilder();
        // No root provided → normalise() should inject it
        const props: ServiceProps = {filters: [], fields: []};
        b.load(props);

        const got = b.getProps();
        expect(Array.isArray(got.filters)).toBe(true);
        expect(got.filters[0]?.id).toBe('root');
    });

    it('tree() yields tag/field nodes and edges (child/bind/include/exclude)', () => {
        const b = createBuilder();
        b.load({
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'A', label: 'A', bind_id: 'root', includes: ['fX'], excludes: ['fY']},
            ],
            fields: [
                {id: 'f1', label: 'F1', type: 'text', bind_id: 'A'},
                {id: 'fX', label: 'FX', type: 'text'},
                {id: 'fY', label: 'FY', type: 'text'},
            ],
        });

        const g = b.tree();
        // nodes include tags + fields
        const nodeIds = new Set(g.nodes.map(n => n.id));
        expect(nodeIds.has('root')).toBe(true);
        expect(nodeIds.has('A')).toBe(true);
        expect(nodeIds.has('f1')).toBe(true);
        expect(nodeIds.has('fX')).toBe(true);

        // edges include child (root->A), bind (A->f1), include/exclude from A
        const sig = g.edges.map(e => `${e.kind}:${e.from}->${e.to}`);
        expect(sig).toContain('child:root->A');
        expect(sig).toContain('bind:A->f1');
        expect(sig).toContain('include:A->fX');
        expect(sig).toContain('exclude:A->fY');
    });

    it('visibleFields(tagId) respects bind/include − exclude (static)', () => {
        const b = createBuilder();
        b.load({
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'G', label: 'Group', bind_id: 'root', includes: ['fInc'], excludes: ['fExc']},
            ],
            fields: [
                {id: 'fBound', label: 'Bound', type: 'text', bind_id: 'G'},
                {id: 'fInc', label: 'Inc', type: 'text'},
                {id: 'fExc', label: 'Exc', type: 'text', bind_id: 'G'},
                {id: 'fOther', label: 'Other', type: 'text'},
            ],
        });

        const vis = b.visibleFields('G');
        expect(vis).toContain('fBound');
        expect(vis).toContain('fInc');       // included
        expect(vis).not.toContain('fExc');   // excluded
        expect(vis).not.toContain('fOther'); // neither bound nor included
    });

    it('visibleFields(tagId, selectedOptionKeys) applies option-level maps when provided', () => {
        const b = createBuilder();
        b.load({
            filters: [{id: 'root', label: 'Root'}, {id: 'T', label: 'T', bind_id: 'root'}],
            fields: [
                {
                    id: 'toggle', label: 'Toggle', type: 'radio', bind_id: 'T',
                    options: [{id: 'on', label: 'On'}, {id: 'off', label: 'Off'}]
                },
                {id: 'base', label: 'Base', type: 'text', bind_id: 'T'},
                {id: 'util', label: 'Util', type: 'text'}, // not bound; will be included by option map
            ],
            includes_for_buttons: {'toggle::on': ['util']},
            excludes_for_buttons: {'toggle::on': ['base']},
        });

        const visOn = b.visibleFields('T', ['toggle::on']);
        const visOff = b.visibleFields('T', ['toggle::off']);

        expect(visOn).toContain('util');  // included by option
        expect(visOn).not.toContain('base');   // excluded by option
        expect(visOff).not.toContain('util');  // not included without selection
        expect(visOff).toContain('base');      // not excluded without selection
    });

    it('visibleFields uses builder.setOptions({ selectedOptionKeys }) when no argument is passed', () => {
        const b = createBuilder();
        b.load({
            filters: [{id: 'root', label: 'Root'}, {id: 'T', label: 'T', bind_id: 'root'}],
            fields: [
                {
                    id: 'toggle', label: 'Toggle', type: 'radio', bind_id: 'T',
                    options: [{id: 'on', label: 'On'}, {id: 'off', label: 'Off'}]
                },
                {id: 'showme', label: 'ShowMe', type: 'text'},
            ],
            includes_for_buttons: {'toggle::on': ['showme']},
        });

        b.setOptions({selectedOptionKeys: ['toggle::on']});
        const vis = b.visibleFields('T'); // no arg; uses options
        expect(vis).toContain('showme');
    });

    it('errors() integrates validate(): duplicate visible labels and custom rules surface', () => {
        const b = createBuilder();
        b.load({
            filters: [{id: 'root', label: 'Root'}, {id: 'G', label: 'Group', bind_id: 'root'}],
            fields: [
                {id: 'x', label: 'Same', type: 'text', name: 'n1', bind_id: 'G'},
                {id: 'y', label: 'Same', type: 'text', name: 'n2', bind_id: 'G'}, // duplicate_visible_label under G
                {id: 'c', label: 'C', type: 'custom', bind_id: 'G'},              // custom missing component
            ],
        });
        const errs = b.errors().map(e => e.code);
        expect(errs).toContain('duplicate_visible_label');
        expect(errs).toContain('custom_component_missing');
    });

    it('cleanedProps() drops unbound utility fields that are excluded and prunes option maps', () => {
        const b = createBuilder();
        b.load({
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'T', label: 'T', bind_id: 'root', excludes: ['u_orphan']}, // explicit exclude
            ],
            fields: [
                // unbound utility, excluded → will be dropped by cleanedProps()
                {id: 'u_orphan', label: 'U-orphan', type: 'text', pricing_role: 'utility'},
                // referenced via option include → kept
                {id: 'u_ref', label: 'U-ref', type: 'text', pricing_role: 'utility'},
                // regular bound field
                {id: 'f1', label: 'F1', type: 'text', bind_id: 'T'},
            ],
            includes_for_buttons: {
                'f1::o1': ['u_ref', 'ghost_field'],
            },
            excludes_for_buttons: {
                'f1::o2': ['ghost_field'],
            },
        });

        const cleaned = b.cleanedProps();

        const fieldIds = cleaned.fields.map(f => f.id);
        expect(fieldIds).not.toContain('u_orphan'); // dropped
        expect(fieldIds).toContain('u_ref');        // kept (referenced by option-map include)
        expect(fieldIds).toContain('f1');

        // option maps pruned to existing field ids only
        expect(cleaned.includes_for_buttons?.['f1::o1']).toEqual(['u_ref']);
        expect(cleaned.excludes_for_buttons?.['f1::o2']).toBeUndefined(); // entire entry removed (all ghost)
    });

    it('undo()/redo() restore previous/next props snapshots', () => {
        const b = createBuilder();

        // initial
        b.load({filters: [], fields: []}); // normalise injects root
        const firstId = b.getProps().filters[0].id;
        expect(firstId).toBe('root');

        // next
        b.load({
            filters: [{id: 'root', label: 'Root'}, {id: 'A', label: 'A', bind_id: 'root'}],
            fields: [],
        });
        expect(b.getProps().filters.some(t => t.id === 'A')).toBe(true);

        // undo → back to previous (no 'A')
        expect(b.undo()).toBe(true);
        expect(b.getProps().filters.some(t => t.id === 'A')).toBe(false);

        // redo → forward (has 'A')
        expect(b.redo()).toBe(true);
        expect(b.getProps().filters.some(t => t.id === 'A')).toBe(true);
    });

    it('cleanedProps preserves schema_version and returns canonical keys only', () => {
        const b = createBuilder();
        b.load({
            filters: [{id: 'root', label: 'Root'}],
            fields: [],
            unknown: 'x',
            schema_version: '2.0',
        } as any);

        const cleaned = b.cleanedProps();
        expect(cleaned.schema_version).toBe('2.0');
        expect(Object.keys(cleaned).sort()).toEqual(
            ['excludes_for_options', 'filters', 'fields', 'includes_for_options', 'schema_version']
                .filter(k => (cleaned as any)[k] !== undefined)
                .sort()
        );
    });

    it('visibleFields returns [] for unknown tag id', () => {
        const b = createBuilder();
        b.load({filters: [{id: 'root', label: 'Root'}], fields: []});
        expect(b.visibleFields('nope')).toEqual([]);
    });

    it('errors() can use serviceMap in options (e.g., rate mismatch check)', () => {
        const b = createBuilder({
            serviceMap: {
                1: {id: 1, rate: 10},
                2: {id: 2, rate: 20},
            } satisfies DgpServiceMap,
        });
        b.load({
            filters: [{id: 'root', label: 'Root'}],
            fields: [
                {
                    id: 'multi',
                    label: 'Multi',
                    type: 'multiselect',
                    options: [
                        {id: 'a', label: 'A', service_id: 1, pricing_role: 'base'},
                        {id: 'b', label: 'B', service_id: 2, pricing_role: 'base'},
                    ],
                },
            ],
        });
        const codes = b.errors().map(e => e.code);
        expect(codes).toContain('rate_mismatch_across_base');
    });
});