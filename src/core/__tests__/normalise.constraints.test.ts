import {describe, it, expect} from 'vitest';
import {normalise} from "@/core";
import type {ServiceProps} from "@/schema";

describe('normalise() constraint propagation', () => {
    it('overrides child flags with nearest ancestor explicit values', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root', constraints: {refill: true}},
                {id: 'A', label: 'A', bind_id: 'root', constraints: {refill: false, cancel: true}},
                {id: 'B', label: 'B', bind_id: 'A', constraints: {dripfeed: true}},
            ],
            fields: [],
        };

        const out = normalise(props);
        const A = out.filters.find(t => t.id === 'A')!;
        const B = out.filters.find(t => t.id === 'B')!;

        // Parent refill:true overrides A.refill=false
        expect(A.constraints?.refill).toBe(true);
        // A.cancel:true is preserved (root didn’t set cancel), and passed to B
        expect(A.constraints?.cancel).toBe(true);

        // At B: inherits refill:true from root and cancel:true from A; keeps its own dripfeed:true
        expect(B.constraints?.refill).toBe(true);
        expect(B.constraints?.cancel).toBe(true);
        expect(B.constraints?.dripfeed).toBe(true);
    });

    it('does not invent constraints when none exist up the chain', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root'},
                {id: 'A', label: 'A', bind_id: 'root'},
                {id: 'B', label: 'B', bind_id: 'A'},
            ],
            fields: [],
        };
        const out = normalise(props);
        expect(out.filters.find(t => t.id === 'root')?.constraints).toBeUndefined();
        expect(out.filters.find(t => t.id === 'A')?.constraints).toBeUndefined();
        expect(out.filters.find(t => t.id === 'B')?.constraints).toBeUndefined();
    });

    it('handles multiple roots / orphaned nodes gracefully', () => {
        const props: ServiceProps = {
            filters: [
                {id: 'root', label: 'Root', constraints: {cancel: false}},
                {id: 'X', label: 'X', constraints: {refill: true}}, // orphan (no bind_id)
                {id: 'Y', label: 'Y', bind_id: 'X'},
            ],
            fields: [],
        };
        const out = normalise(props);
        // Root branch: only cancel:false propagates
        expect(out.filters.find(t => t.id === 'root')?.constraints?.cancel).toBe(false);
        // Orphan X acts as its own root; its refill:true propagates to Y
        expect(out.filters.find(t => t.id === 'X')?.constraints?.refill).toBe(true);
        expect(out.filters.find(t => t.id === 'Y')?.constraints?.refill).toBe(true);
    });
});