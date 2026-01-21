import {describe, it, expect} from 'vitest';
import React from 'react';
import {createInputRegistry, resolveInputDescriptor} from "@/react";
import type {InputDescriptor} from "@/react";

function StubA(_: Record<string, unknown>) { return React.createElement('div'); }
function StubB(_: Record<string, unknown>) { return React.createElement('div'); }

describe('InputRegistry variant resolution', () => {
    it('returns the default descriptor when variant not provided', () => {
        const registry = createInputRegistry();

        const defaultDesc: InputDescriptor = { Component: StubA, defaultProps: {foo: 1} };
        registry.register('custom:Rating', defaultDesc); // default variant

        const resolved = resolveInputDescriptor(registry, 'custom:Rating');
        expect(resolved).toBeDefined();
        expect(resolved?.Component).toBe(StubA);
        expect(resolved?.defaultProps).toEqual({foo: 1});
    });

    it('returns the specific variant when registered', () => {
        const registry = createInputRegistry();

        const defaultDesc: InputDescriptor = { Component: StubA };
        const compactDesc: InputDescriptor = { Component: StubB, defaultProps: {size: 'sm'} };

        registry.register('custom:Rating', defaultDesc);                 // default
        registry.register('custom:Rating', compactDesc, 'compact');      // variant

        // explicit variant
        const resolvedCompact = resolveInputDescriptor(registry, 'custom:Rating', 'compact');
        expect(resolvedCompact).toBeDefined();
        expect(resolvedCompact?.Component).toBe(StubB);
        expect(resolvedCompact?.defaultProps).toEqual({size: 'sm'});

        // unknown variant → falls back to default
        const resolvedUnknown = resolveInputDescriptor(registry, 'custom:Rating', 'unknown' as any);
        expect(resolvedUnknown).toBeDefined();
        expect(resolvedUnknown?.Component).toBe(StubA);
    });

    it('registerMany works and fallback-to-default still applies', () => {
        const registry = createInputRegistry();

        const entries = [
            { kind: 'custom:Rating', descriptor: { Component: StubA } },
            { kind: 'custom:Rating', descriptor: { Component: StubB, defaultProps: {size: 'xs'} }, variant: 'compact' },
        ];
        registry.registerMany(entries);

        // exact variant
        const v = resolveInputDescriptor(registry, 'custom:Rating', 'compact');
        expect(v?.Component).toBe(StubB);
        expect(v?.defaultProps).toEqual({size: 'xs'});

        // fallback to default
        const d = resolveInputDescriptor(registry, 'custom:Rating', 'nope' as any);
        expect(d?.Component).toBe(StubA);
    });
});