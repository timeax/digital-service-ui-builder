import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Builder} from 'digital-service-ui-builder/core';
import {Selection, type SelectionOptions, type VisibleGroup} from './selection';

type OrderFlowOptions = Omit<SelectionOptions, 'env'> & {
    /** Initial selection to seed once on mount. */
    initialSelection?: { ids?: string[]; primary?: string };
};

export function useOrderFlow(builder: Builder, opts?: OrderFlowOptions) {
    // Create a client-mode Selection bound to this builder
    const selection = useMemo(
        () => new Selection(builder, {...(opts ?? {}), env: 'client'}),
        // builder identity changes should be deliberate; if yours is stable, this won’t churn
        [builder]
    );

    // Seed initial selection once
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current) return;
        seeded.current = true;
        if (opts?.initialSelection) {
            selection.many(opts.initialSelection.ids ?? [], opts.initialSelection.primary);
        }
    }, [selection, opts?.initialSelection]);

    // React snapshot of selection ids/primary
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [primaryId, setPrimaryId] = useState<string | undefined>(undefined);

    useEffect(() => {
        // prime snapshot
        setSelectedIds(Array.from(selection.all()));
        setPrimaryId(selection.primary());

        // subscribe to changes
        const off = selection.onChange(({ids, primary}) => {
            setSelectedIds(ids);
            setPrimaryId(primary);
        });
        return off;
    }, [selection]);

    // Visible group (client env → always 'single'; fall back to empty shape if not)
    const group = useMemo<VisibleGroup>(() => {
        const res = selection.visibleGroup();
        return res.kind === 'single' ? res.group : ({fields: [], fieldIds: []} as VisibleGroup);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, selectedIds, primaryId]);

    // Convenient mutators
    const replace = useCallback((id?: string | null) => selection.replace(id), [selection]);
    const add = useCallback((id: string) => selection.add(id), [selection]);
    const remove = useCallback((id: string) => selection.remove(id), [selection]);
    const toggle = useCallback((id: string) => selection.toggle(id), [selection]);
    const many = useCallback((ids: string[], primary?: string) => selection.many(ids, primary), [selection]);
    const clear = useCallback(() => selection.clear(), [selection]);

    return {
        selection,      // underlying instance (advanced usage)
        selectedIds,    // live ids snapshot
        primaryId,      // live primary id snapshot
        group,          // VisibleGroup for current tag
        replace, add, remove, toggle, many, clear,
    };
}

export type {VisibleGroup} from '../canvas/selection';