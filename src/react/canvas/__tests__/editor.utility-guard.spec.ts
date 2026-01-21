// src/canvas/__tests__/editor.utility-guard.spec.ts
import {describe, it, expect, vi} from 'vitest';
import {createBuilder} from "@/core";
import {CanvasAPI} from "../api";
import {ServiceProps} from "@/schema";

function baseProps(): ServiceProps {
    return {
        schema_version: '1.0',
        filters: [{id: 'root', label: 'Root'}],
        fields: [
            {
                id: 'fld',
                type: 'select',
                label: 'Select',
                bind_id: 'root',
                options: [
                    {id: 'o:base', label: 'Base Opt', pricing_role: 'base', service_id: 5},
                ],
            },
        ],
    };
}

describe('Editor utility guard (utilities cannot have service_id)', () => {
    it('clears service_id when switching option to utility', () => {
        const b = createBuilder();
        b.load(baseProps());

        const api = new CanvasAPI(b, {autoEmitState: false});
        const {editor} = api;

        // switch to utility (correct signature)
        editor.setService('o:base', {pricing_role: 'utility'});

        const props = b.getProps();
        const opt = props.fields[0].options!.find(o => o.id === 'o:base')!;
        expect(opt.pricing_role).toBe('utility');
        expect((opt as any).service_id).toBeUndefined();
    });

    it('blocks assigning service_id to a utility option', () => {
        const b = createBuilder();
        b.load(baseProps());

        const api = new CanvasAPI(b, {autoEmitState: false});
        const {editor} = api;

        // switch to utility first
        editor.setService('o:base', {pricing_role: 'utility'});

        // spy on error emission if your Editor exposes .on / .emit for 'editor:error'
        vi.fn();
        // If your Editor exposes `on`, uncomment:
        // editor.on('editor:error', errSpy);

        // attempt to set a service_id → should be blocked (correct signature)
        editor.setService('o:base', {service_id: 99});

        const props = b.getProps();
        const opt = props.fields[0].options!.find(o => o.id === 'o:base')!;
        expect(opt.pricing_role).toBe('utility');
        expect((opt as any).service_id).toBeUndefined();

        // If wired above:
        // expect(errSpy).toHaveBeenCalled();
    });

    it('undo restores previous base + service_id', () => {
        const b = createBuilder();
        b.load(baseProps());

        const api = new CanvasAPI(b, {autoEmitState: false});
        const {editor} = api;

        editor.setService('o:base', {pricing_role: 'utility'});
        let props = b.getProps();
        expect(props.fields[0].options![0].pricing_role).toBe('utility');
        expect((props.fields[0].options![0] as any).service_id).toBeUndefined();

        editor.undo();
        props = b.getProps();
        expect(props.fields[0].options![0].pricing_role).toBe('base');
        expect((props.fields[0].options![0] as any).service_id).toBe(5);
    });
});