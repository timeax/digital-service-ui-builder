import {describe, it, expect} from 'vitest';
import {Selection} from '../selection';

// Minimal “builder” double for Selection (we only need getProps()).
function mkBuilder(props: any) {
    return {getProps: () => props} as any;
}

describe('Selection.visibleGroup()', () => {
    it('workspace: >1 tag selected → returns multi with raw selection set', () => {
        const props = {
            filters: [
                {id: 't:root', label: 'Root'},
                {id: 't:A', label: 'A', bind_id: 't:root'},
                {id: 't:B', label: 'B', bind_id: 't:root'},
            ],
            fields: [],
        };
        const builder = mkBuilder(props);
        const sel = new Selection(builder, {env: 'workspace', rootTagId: 't:root'});

        const raw = ['t:A', 't:B', 'o:x'];
        sel.many(raw, 't:A');

        const out = sel.visibleGroup();
        expect(out).toEqual({kind: 'multi', groups: raw});
    });

    it('single group: computes visible fields (bind + tag includes/excludes + option includes/excludes) honoring order_for_tags', () => {
        const props = {
            filters: [
                {id: 't:root', label: 'Root'},
                {
                    id: 't:Web', label: 'Web', bind_id: 't:root',
                    includes: ['f:extra'],         // force-include f:extra
                    excludes: ['f:hidden'],        // hide f:hidden even if bound
                },
            ],
            fields: [
                {id: 'f:bound1', label: 'Bound1', bind_id: 't:Web'}, // visible
                {id: 'f:hidden', label: 'Hidden', bind_id: 't:Web'}, // excluded by tag.excludes
                {id: 'f:extra', label: 'Extra'},                    // included by tag.includes
                {id: 'f:optIn', label: 'OptIn'},                    // will be included by option
            ],
            // Option-level mapping: selecting 'o:show' includes f:optIn; 'o:hide' excludes f:bound1
            includes_for_options: {'o:show': ['f:optIn']},
            excludes_for_options: {'o:hide': ['f:bound1']},
            // Explicit order for Web: f:extra, f:bound1, (others afterward)
            order_for_tags: {'t:Web': ['f:extra', 'f:bound1']},
        };
        const builder = mkBuilder(props);
        const sel = new Selection(builder, {env: 'client', rootTagId: 't:root'});

        // Select the tag and the option that includes f:optIn
        sel.replace('t:Web');
        sel.add('o:show');

        const res = sel.visibleGroup();
        expect(res.kind).toBe('single');
        const group = (res as any).group;

        // Should include: bound1 (bound), extra (tag.include), optIn (option.include)
        // Should exclude: hidden (tag.exclude)
        expect(group.fieldIds).toEqual(['f:extra', 'f:bound1', 'f:optIn']);
    });

    it('services: tag service first unless overridden by the first selected base option; utilities append; extra base options append', () => {
        const props = {
            filters: [
                {id: 't:root', label: 'Root'},
                {id: 't:Web', label: 'Web', bind_id: 't:root', service_id: 100}, // tag base 100
            ],
            fields: [
                {
                    id: 'f:plan', label: 'Plan', bind_id: 't:Web',
                    options: [
                        {id: 'o:util', label: 'Util', service_id: 300, pricing_role: 'utility'},
                        {id: 'o:base2', label: 'Base2', service_id: 200, pricing_role: 'base'},
                        {id: 'o:base3', label: 'Base3', service_id: 400, pricing_role: 'base'},
                    ]
                }
            ]
        };
        const resolveService = (id: any) => ({id});
        const builder = mkBuilder(props);
        const sel = new Selection(builder, {env: 'client', rootTagId: 't:root', resolveService});

        sel.replace('t:Web');
        sel.add('o:util');   // append after base
        sel.add('o:base2');  // first base → overrides tag base
        sel.add('o:base3');  // additional base → append

        const res = sel.visibleGroup();
        expect(res.kind).toBe('single');
        const services = (res as any).group.services;
        expect(services.map((s: any) => s.id)).toEqual([200, 300, 400]);
    });

    it('parentTags (nearest-first) and childrenTags (immediate only)', () => {
        const props = {
            filters: [
                {id: 't:root', label: 'Root'},
                {id: 't:A', label: 'A', bind_id: 't:root'},
                {id: 't:B', label: 'B', bind_id: 't:A'}, // focus tag
                {id: 't:C', label: 'C', bind_id: 't:B'}, // child of B
                {id: 't:D', label: 'D', bind_id: 't:B'}, // child of B
            ],
            fields: [],
        };
        const builder = mkBuilder(props);
        const sel = new Selection(builder, {env: 'client', rootTagId: 't:root'});

        sel.replace('t:B');
        const res = sel.visibleGroup();
        expect(res.kind).toBe('single');

        const group = (res as any).group;
        expect(group.tagId).toBe('t:B');
        // Nearest-first: A, then root
        expect(group.parentTags?.map((t: any) => t.id)).toEqual(['t:A', 't:root']);
        // Immediate children of B
        expect(group.childrenTags?.map((t: any) => t.id).sort()).toEqual(['t:C', 't:D']);
    });

    it('resolves tag context from a field selection (no tag explicitly selected)', () => {
        const props = {
            filters: [
                {id: 't:root', label: 'Root'},
                {id: 't:X', label: 'X', bind_id: 't:root'},
            ],
            fields: [
                {id: 'f:foo', label: 'Foo', bind_id: 't:X'},
                {id: 'f:bar', label: 'Bar', bind_id: 't:X'},
            ]
        };
        const builder = mkBuilder(props);
        const sel = new Selection(builder, {env: 'client', rootTagId: 't:root'});

        sel.replace('f:foo'); // only field selected
        const res = sel.visibleGroup();
        expect(res.kind).toBe('single');
        expect((res as any).group.tagId).toBe('t:X');
        expect((res as any).group.fieldIds.sort()).toEqual(['f:bar', 'f:foo'].sort());
    });
});