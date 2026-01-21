// src/canvas/__tests__/editor.quantity-rule.spec.ts
import {describe, it, expect} from 'vitest';
import {createBuilder} from "@/core";
import {CanvasAPI} from "../api";

function baseProps() {
    return {
        schema_version: '1.0',
        filters: [{ id: 'root', label: 'Root' }],
        fields: [
            { id: 'f:text', type: 'text', bind_id: 'root', label: 'Qty Source' },
        ],
    };
}

describe('Editor field quantity rule helpers', () => {
    it('set/get/clear meta.quantity and undo/redo', () => {
        const b = createBuilder();
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        // initially none
        expect(editor.getFieldQuantityRule('f:text')).toBeUndefined();

        // set eval rule
        editor.setFieldQuantityRule('f:text', {
            valueBy: 'eval',
            code: 'return (Array.isArray(values) ? values.length : (value ? 1 : 0)) * 3;',
        });

        let props = b.getProps();
        expect((props.fields[0] as any).meta?.quantity).toEqual({
            valueBy: 'eval',
            code: 'return (Array.isArray(values) ? values.length : (value ? 1 : 0)) * 3;',
        });
        expect(editor.getFieldQuantityRule('f:text')).toEqual({
            valueBy: 'eval',
            code: 'return (Array.isArray(values) ? values.length : (value ? 1 : 0)) * 3;',
        });

        // clear via helper
        editor.clearFieldQuantityRule('f:text');
        props = b.getProps();
        expect((props.fields[0] as any).meta).toBeUndefined();
        expect(editor.getFieldQuantityRule('f:text')).toBeUndefined();

        // undo → rule back
        editor.undo();
        props = b.getProps();
        expect((props.fields[0] as any).meta?.quantity?.valueBy).toBe('eval');

        // redo → cleared again
        editor.redo();
        props = b.getProps();
        expect((props.fields[0] as any).meta).toBeUndefined();
    });

    it('normalizes rule (drops invalid shapes)', () => {
        const b = createBuilder();
        b.load(baseProps());

        const api = new CanvasAPI(b, { autoEmitState: false });
        const { editor } = api;

        // invalid valueBy should be ignored → nothing set
        editor.setFieldQuantityRule('f:text', { valueBy: 'weird' });
        let props = b.getProps();
        expect((props.fields[0] as any).meta).toBeUndefined();

        // valid non-eval drops code
        editor.setFieldQuantityRule('f:text', { valueBy: 'length', code: 'ignored' });
        props = b.getProps();
        expect((props.fields[0] as any).meta?.quantity).toEqual({ valueBy: 'length' });
    });
});