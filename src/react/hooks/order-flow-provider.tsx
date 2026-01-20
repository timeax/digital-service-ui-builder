// src/react/hooks/OrderFlowProvider.tsx
import React, {
    useRef,
    useImperativeHandle,
    useEffect,
    useState,
    forwardRef,
    createContext,
    useContext,
    ReactNode,
    useMemo,
} from 'react';

import type {Builder} from '../../core';
import type {Selection} from '../canvas/selection';

import {Provider} from '../inputs/provider';
import {Registry as InputRegistryConfig} from '../inputs/registry';

import {FormProvider, useFormApi} from '../inputs/FormContext';
import type {Scalar} from '../../schema/order';

/* ───────────────────────── Types ───────────────────────── */

export type UseOrderFlowInit = {
    /** Seed form values keyed by fieldId (non-option inputs) */
    initialFormByFieldId?: Record<string, Scalar | Scalar[]>;
    /** (optional) seed selections by fieldId → optionIds[] */
    initialSelectionsByFieldId?: Record<string, string[]>;
};

export type OrderFlowProviderProps = {
    /** Bring your own flow (no internal Selection!) */
    flow: { builder: Builder; selection: Selection };
    /** Host input registry (maps kind/variant → components) */
    registry?: InputRegistryConfig;
    /** Optional init (form + selections seeding) */
    init?: UseOrderFlowInit;
    children?: ReactNode;
};

export type OrderFlowHandle = {
    /** Current active tag id (or undefined) */
    getActiveTag: () => string | undefined;
    /** Select a tag context (single-context) */
    selectTag: (tagId: string) => void;
    /** Latest visible-group result from Selection */
    getVisibleGroup: () => ReturnType<Selection['visibleGroup']>;
    /** Access to Form API (e.g., set/get values programmatically) */
    getFormApi: () => ReturnType<typeof useFormApi> | undefined;
    /** Raw selection ids */
    getSelectionIds: () => string[];
    /** Clear selection */
    clearSelection: () => void;
    /** Force refresh of internal activeTag tracker */
    refresh: () => void;
};

/* ───────────────────────── Context ───────────────────────── */

type CtxShape = {
    builder: Builder;
    selection: Selection;
    activeTagId?: string;
    setActiveTag: (id: string) => void;
};

const OrderFlowCtx = createContext<CtxShape | null>(null);

export function useOrderFlowContext(): CtxShape {
    const ctx = useContext(OrderFlowCtx);
    if (!ctx) throw new Error('useOrderFlowContext must be used within <OrderFlowProvider>');
    return ctx;
}

/* ───────────────────────── Internals ───────────────────────── */

/** Captures the FormApi from inside FormProvider (no extra props required). */
function CaptureFormApi({assign}: { assign: (api: ReturnType<typeof useFormApi>) => void }) {
    const api = useFormApi();
    useEffect(() => assign(api), [api, assign]);
    return null;
}

/* ───────────────────────── Component ───────────────────────── */

export const OrderFlowProvider = forwardRef<OrderFlowHandle, OrderFlowProviderProps>(function OrderFlowProvider(
    {flow, registry, init, children},
    ref
) {
    const {builder, selection} = flow;

    // Track current active tag from the provided Selection instance
    const [activeTagId, setActiveTagId] = useState<string | undefined>(() => selection.currentTag());
    useEffect(() => selection.onChange(() => setActiveTagId(selection.currentTag())), [selection]);

    const setActiveTag = (id: string) => {
        selection.replace(id);
        setActiveTagId(id);
    };

    // Imperative API: we store the FormApi ref captured from inside the FormProvider
    const formApiRef = useRef<ReturnType<typeof useFormApi>>();

    useImperativeHandle(
        ref,
        (): OrderFlowHandle => ({
            getActiveTag: () => activeTagId,
            selectTag: (id: string) => setActiveTag(id),
            getVisibleGroup: () => selection.visibleGroup(),
            getFormApi: () => formApiRef.current,
            getSelectionIds: () => Array.from(selection.all()),
            clearSelection: () => selection.clear(),
            refresh: () => setActiveTagId(selection.currentTag()),
        }),
        [activeTagId, selection]
    );

    // Build initial snapshot for FormProvider (values + selections)
    const initialFormValues = useMemo(
        () => init?.initialFormByFieldId ?? {},
        [init?.initialFormByFieldId]
    );
    const initialSelections = useMemo(
        () => init?.initialSelectionsByFieldId ?? {},
        [init?.initialSelectionsByFieldId]
    );

    return (
        <Provider initialRegistry={registry}>
            <FormProvider initial={{values: initialFormValues, selections: initialSelections}}>
                {/* capture API once we are inside the provider */}
                <CaptureFormApi assign={(api) => {
                    formApiRef.current = api;
                }}/>
                <OrderFlowCtx.Provider value={{builder, selection, activeTagId, setActiveTag}}>
                    {children}
                </OrderFlowCtx.Provider>
            </FormProvider>
        </Provider>
    );
});