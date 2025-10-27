import {describe, it, expect} from 'vitest';
import {buildOrderSnapshot} from '../build-order-snapshot';

import {type Builder, createBuilder} from '../../core';
import type {ServiceProps, Field, Tag} from '../../schema';
import type {DgpServiceMap} from '../../schema/provider';

function mkPropsWithQuantityRule(rule: unknown): ServiceProps {
    const field: Field = {
        id: 'f_qty',
        type: 'text',
        bind_id: 'root',
        name: 'qty_input',
        label: 'Qty',
        meta: {quantity: rule as any},
        pricing_role: 'base',
    };
    return {
        filters: [{id: 'root', label: 'Root'}],
        fields: [field],
        schema_version: '1.0',
    };
}

function mkSelection(value: any) {
    return {
        activeTagId: 'root',
        formValuesByFieldId: {f_qty: value},
        optionSelectionsByFieldId: {},
    };
}

describe('buildOrderSnapshot – malformed quantity rules fallback', () => {
    it('falls back to host default when valueBy is unknown', () => {
        const hostDefault = 7;
        const props = mkPropsWithQuantityRule({valueBy: 'wat'}); // invalid
        const builder = createBuilder();
        builder.load(props);

        const snapshot = buildOrderSnapshot(
            props,
            builder,
            mkSelection(42),
            {}, // service map not needed for this test
            {mode: 'prod', hostDefaultQuantity: hostDefault}
        );

        expect(snapshot.quantity).toBe(hostDefault);
        expect(snapshot.quantitySource.kind).toBe('default');
        expect((snapshot.quantitySource as any).defaultedFromHost).toBe(true);
    });

    it('falls back to host default when valueBy="eval" but code is missing', () => {
        const hostDefault = 5;
        const props = mkPropsWithQuantityRule({valueBy: 'eval'}); // no code
        const builder = createBuilder();
        builder.load(props);

        const snapshot = buildOrderSnapshot(
            props,
            builder,
            mkSelection(123),
            {},
            {mode: 'prod', hostDefaultQuantity: hostDefault}
        );

        expect(snapshot.quantity).toBe(hostDefault);
        expect(snapshot.quantitySource.kind).toBe('default');
        expect((snapshot.quantitySource as any).defaultedFromHost).toBe(true);
    });

    it('falls back to host default when valueBy="eval" but code is not a string', () => {
        const hostDefault = 11;
        const props = mkPropsWithQuantityRule({valueBy: 'eval', code: 1337}); // bad type
        const builder = createBuilder();
        builder.load(props);

        const snapshot = buildOrderSnapshot(
            props,
            builder,
            mkSelection('9'),
            {},
            {mode: 'prod', hostDefaultQuantity: hostDefault}
        );

        expect(snapshot.quantity).toBe(hostDefault);
        expect(snapshot.quantitySource.kind).toBe('default');
        expect((snapshot.quantitySource as any).defaultedFromHost).toBe(true);
    });
});

/* ───────────────── helpers ───────────────── */

function makeBuilderVisibleFields(order: string[]): Builder {
    // Only visibleFields() is used by the snapshot builder here.
    return {
        visibleFields: (_tagId: string, _selected?: string[]) => order.slice(),
    } as unknown as Builder;
}

function tag(id: string, label: string, service_id?: number): Tag {
    return {
        id,
        label,
        ...(service_id !== undefined ? {service_id} : {}),
    } as Tag;
}

function fieldWithQuantity(
    id: string,
    bind_id: string | string[],
    quantity: { valueBy: 'value' | 'length' | 'eval'; code?: string },
    extra?: Partial<Field>
): Field {
    return {
        id,
        type: (extra?.type as string) ?? 'text',
        label: id,
        bind_id,
        ...(extra ?? {}),
        meta: {
            ...(extra?.meta ?? {}),
            quantity,
        },
    } as unknown as Field;
}

function plainField(id: string, bind_id: string | string[], extra?: Partial<Field>): Field {
    return {
        id,
        type: (extra?.type as string) ?? 'text',
        label: id,
        bind_id,
        ...(extra ?? {}),
    } as unknown as Field;
}

function propsOf(tags: Tag[], fields: Field[]): ServiceProps {
    return {filters: tags, fields, schema_version: '1.0'};
}

/* ───────────────── fixtures ───────────────── */

const svcMap: DgpServiceMap = {}; // services aren’t relevant for these tests

const ROOT = tag('t:root', 'Root');

/* ───────────────── tests ───────────────── */

describe('buildOrderSnapshot — quantity evaluation', () => {
    it('value rule: uses the numeric value (coerces string to number)', () => {
        const fQ = fieldWithQuantity('fQ', 't:root', {valueBy: 'value'});
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fQ']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fQ: '5'}, // string "5" → 5
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 1,
        });

        expect(snap.quantity).toBe(5);
        expect(snap.quantitySource.kind).toBe('field');
        expect(snap.quantitySource).toMatchObject({id: 'fQ', rule: {valueBy: 'value'}});
    });

    it('length rule: uses string length', () => {
        const fQ = fieldWithQuantity('fLen', 't:root', {valueBy: 'length'});
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fLen']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fLen: 'hello!'}, // length 6
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 1,
        });

        expect(snap.quantity).toBe(6);
        expect(snap.quantitySource.kind).toBe('field');
        expect(snap.quantitySource).toMatchObject({id: 'fLen', rule: {valueBy: 'length'}});
    });

    it('length rule: uses array length if the value is an array', () => {
        const fQ = fieldWithQuantity('fLenArr', 't:root', {valueBy: 'length'});
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fLenArr']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fLenArr: [1, 2, 3, 4]}, // length 4
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 1,
        });

        expect(snap.quantity).toBe(4);
        expect(snap.quantitySource.kind).toBe('field');
    });

    it('eval rule: evaluates provided code against value/values', () => {
        const fQ = fieldWithQuantity('fEval', 't:root', {
            valueBy: 'eval',
            code: 'return Number(value) * 2;', // e.g. "3" → 6
        });
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fEval']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fEval: '3'},
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 1,
        });

        expect(snap.quantity).toBe(6);
        expect(snap.quantitySource.kind).toBe('field');
        expect(snap.quantitySource).toMatchObject({id: 'fEval', rule: {valueBy: 'eval'}});
    });

    it('first visible field with a quantity rule takes precedence', () => {
        const f1 = fieldWithQuantity('f1', 't:root', {valueBy: 'value'});
        const f2 = fieldWithQuantity('f2', 't:root', {valueBy: 'value'});
        const props = propsOf([ROOT], [f1, f2]);

        // Order: f1 then f2
        const builder = makeBuilderVisibleFields(['f1', 'f2']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {f1: '7', f2: '100'}, // f1 wins
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 1,
        });

        expect(snap.quantity).toBe(7);
        expect(snap.quantitySource).toMatchObject({kind: 'field', id: 'f1'});
    });

    it('falls back to host default when quantity rule yields NaN/invalid', () => {
        const fQ = fieldWithQuantity('fBad', 't:root', {valueBy: 'value'});
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fBad']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fBad: 'not-a-number'}, // → NaN
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 9,
        });

        expect(snap.quantity).toBe(9);
        expect(snap.quantitySource.kind).toBe('default');
        expect(snap.quantitySource).toMatchObject({defaultedFromHost: true});
    });

    it('falls back to host default when quantity rule result is ≤ 0', () => {
        const fQ = fieldWithQuantity('fZero', 't:root', {valueBy: 'value'});
        const props = propsOf([ROOT], [fQ]);
        const builder = makeBuilderVisibleFields(['fZero']);

        const selectionZero = {
            activeTagId: 't:root',
            formValuesByFieldId: {fZero: 0},
            optionSelectionsByFieldId: {},
        };

        const snapZero = buildOrderSnapshot(props, builder, selectionZero, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 3,
        });
        expect(snapZero.quantity).toBe(3);
        expect(snapZero.quantitySource.kind).toBe('default');

        const selectionNeg = {
            activeTagId: 't:root',
            formValuesByFieldId: {fZero: -5},
            optionSelectionsByFieldId: {},
        };
        const snapNeg = buildOrderSnapshot(props, builder, selectionNeg, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 4,
        });
        expect(snapNeg.quantity).toBe(4);
        expect(snapNeg.quantitySource.kind).toBe('default');
    });

    it('falls back to host default when no quantity rule exists on any visible field', () => {
        const fA = plainField('fA', 't:root');
        const fB = plainField('fB', 't:root');
        const props = propsOf([ROOT], [fA, fB]);
        const builder = makeBuilderVisibleFields(['fA', 'fB']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fA: '123', fB: '456'}, // irrelevant—no rules
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 2,
        });

        expect(snap.quantity).toBe(2);
        expect(snap.quantitySource.kind).toBe('default');
    });

    it('eval rule: if code throws or returns non-numeric → host default', () => {
        const fThrow = fieldWithQuantity('fThrow', 't:root', {
            valueBy: 'eval',
            code: 'throw new Error("boom");',
        });
        const fNan = fieldWithQuantity('fNan', 't:root', {
            valueBy: 'eval',
            code: 'return "nope";',
        });

        const props = propsOf([ROOT], [fThrow, fNan]);

        // Only first visible with a rule will be tested; make it the throwing one
        const builder = makeBuilderVisibleFields(['fThrow', 'fNan']);

        const selection = {
            activeTagId: 't:root',
            formValuesByFieldId: {fThrow: 10, fNan: 10},
            optionSelectionsByFieldId: {},
        };

        const snap = buildOrderSnapshot(props, builder, selection, svcMap, {
            mode: 'prod',
            hostDefaultQuantity: 8,
        });

        expect(snap.quantity).toBe(8);
        expect(snap.quantitySource.kind).toBe('default');
    });
});