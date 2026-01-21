import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {Builder} from "@/core";
import type {ServiceProps, Field, Tag} from "@/schema";
import type {DgpServiceCapability, DgpServiceMap} from "@/schema/provider";
import type {OrderSnapshot, Scalar} from "@/schema/order";
import type {FallbackSettings} from "@/schema/validation";

import {Selection} from '../canvas/selection';
import {buildOrderSnapshot} from "@/utils/build-order-snapshot";
import {useOptionalFormApi} from "@/react";

/* ───────────────────────── public API ───────────────────────── */

export type UseOrderFlowInit = {
    mode?: 'prod' | 'dev';
    services: DgpServiceMap;
    fallback?: FallbackSettings;
    hydrateFrom?: OrderSnapshot;
    initialTagId?: string;
    hostDefaultQuantity?: number; // default 1
    resolveService?: (id: number | string) => DgpServiceCapability | undefined;
};

export type UseOrderFlowReturn = {
    activeTagId?: string;
    visibleFieldIds: string[];
    visibleFields: Field[];
    formValuesByFieldId: Record<string, Scalar | Scalar[]>;
    optionSelectionsByFieldId: Record<string, string[]>;
    quantityPreview: number;
    services: Array<string | number>;
    serviceMap: Record<string, Array<string | number>>;
    selectTag: (tagId: string) => void;
    toggleOption: (fieldId: string, optionId: string) => void;
    setValue: (fieldId: string, value: Scalar | Scalar[]) => void;
    clearField: (fieldId: string) => void;
    reset: () => void;
    buildSnapshot: () => OrderSnapshot;
    setFallbackPolicy: (next: FallbackSettings) => void;
};

/* ───────────────────────── implementation ───────────────────────── */

export function useOrderFlow(builder: Builder, init: UseOrderFlowInit): UseOrderFlowReturn {
    const mode: 'prod' | 'dev' = init.mode ?? 'prod';
    const hostDefaultQuantity: number = Number.isFinite(init.hostDefaultQuantity ?? 1)
        ? (init.hostDefaultQuantity as number)
        : 1;

    const propsRef = useRef<ServiceProps>(builder.getProps());
    useEffect(() => {
        propsRef.current = builder.getProps();
    });

    const [fallbackPolicy, setFallbackPolicy] = useState<FallbackSettings>(() => ({
        requireConstraintFit: true,
        ratePolicy: {kind: 'lte_primary'},
        selectionStrategy: 'priority',
        mode: mode === 'dev' ? 'dev' : 'strict',
        ...(init.fallback ?? {}),
    }));

    // Internal state (used only if no FormContext is present)
    const [formValuesByFieldId, setFormValuesByFieldId] = useState<Record<string, Scalar | Scalar[]>>({});
    const [optionSelectionsByFieldId, setOptionSelectionsByFieldId] = useState<Record<string, string[]>>({});

    // Optional Form Context (host-provided)
    const formApi = useOptionalFormApi();

    // Selection
    const selectionRef = useRef<Selection>();
    if (!selectionRef.current) {
        selectionRef.current = new Selection(builder, {
            env: 'client',
            rootTagId: 'root',
            resolveService: init.resolveService,
        });
    }
    const selection = selectionRef.current;

    // Default tag: hydrate → initial → root → first
    useEffect(() => {
        const props = propsRef.current;
        const tags = props.filters ?? [];

        const hydratedTag = init.hydrateFrom?.selection?.tag;
        const initialTag = init.hydrateFrom
            ? hydratedTag
            : (init.initialTagId ?? findDefaultTagId(tags));

        if (initialTag) {
            selection.replace(initialTag);
        } else if (tags.length) {
            selection.replace(tags[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Hydrate inputs (internal state only; FormContext has its own state)
    useEffect(() => {
        const snap = init.hydrateFrom;
        if (!snap) return;

        if (snap.inputs?.selections) setOptionSelectionsByFieldId(snap.inputs.selections);

        const byFieldId: Record<string, Scalar | Scalar[]> = {};
        if (snap.inputs?.form) {
            const fields = propsRef.current.fields ?? [];
            const nameToIds = new Map<string, string[]>();
            for (const f of fields) {
                if (!f.name) continue;
                const arr = nameToIds.get(f.name) ?? [];
                arr.push(f.id);
                nameToIds.set(f.name, arr);
            }
            for (const [name, value] of Object.entries(snap.inputs.form)) {
                for (const fid of (nameToIds.get(name) ?? [])) byFieldId[fid] = value as Scalar | Scalar[];
            }
        }
        setFormValuesByFieldId(byFieldId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track active tag
    const [activeTagId, setActiveTagId] = useState<string | undefined>(() => selection.currentTag());
    useEffect(() => {
        return selection.onChange(() => {
            setActiveTagId(selection.currentTag());
        });
    }, [selection]);

    // Selected option keys from internal state (used if no FormContext)
    const selectedOptionKeys: string[] = useMemo(() => {
        const keys: string[] = [];
        for (const [fid, oids] of Object.entries(optionSelectionsByFieldId)) {
            for (const oid of oids) keys.push(`${fid}::${oid}`);
        }
        return keys;
    }, [optionSelectionsByFieldId]);

    // Visible fields
    const {visibleFieldIds, visibleFields} = useMemo(() => {
        const tag = activeTagId;
        if (!tag) return {visibleFieldIds: [] as string[], visibleFields: [] as Field[]};

        const fallbackSelectionKeys = selectedOptionKeys;
        const ids = builder.visibleFields(tag, fallbackSelectionKeys);
        const byId = new Map((propsRef.current.fields ?? []).map(f => [f.id, f] as const));
        const fields = ids.map(id => byId.get(id)).filter((f): f is Field => !!f);
        return {visibleFieldIds: ids, visibleFields: fields};
    }, [builder, activeTagId, selectedOptionKeys]);

    // Merge values/selections: FormContext (if present) takes precedence for visible fields
    const effectiveMaps = useMemo(() => {
        const visible = new Set(visibleFieldIds);

        const fromFormValues: Record<string, Scalar | Scalar[]> = {};
        const fromFormSelections: Record<string, string[]> = {};

        if (formApi) {
            for (const fid of visible) {
                const v = formApi.get(fid);
                if (v !== undefined) fromFormValues[fid] = v;
                const sel = formApi.getSelections(fid);
                if (sel && sel.length) fromFormSelections[fid] = sel.slice();
            }
        }

        // fall back to internal state for fields that that are not present in formApi
        const mergedValues: Record<string, Scalar | Scalar[]> = {...formValuesByFieldId};
        for (const [fid, v] of Object.entries(fromFormValues)) mergedValues[fid] = v;

        const mergedSelections: Record<string, string[]> = {...optionSelectionsByFieldId};
        for (const [fid, arr] of Object.entries(fromFormSelections)) mergedSelections[fid] = arr;

        return {formValuesByFieldId: mergedValues, optionSelectionsByFieldId: mergedSelections};
    }, [formApi, formValuesByFieldId, optionSelectionsByFieldId, visibleFieldIds]);

    // Live preview snapshot (uses effectiveMaps)
    const previewSnapshot: OrderSnapshot = useMemo(() => {
        if (!activeTagId) {
            return {
                version: '1',
                mode,
                builtAt: new Date().toISOString(),
                selection: {tag: 'unknown', fields: []},
                inputs: {form: {}, selections: {}},
                quantity: Number(init.hostDefaultQuantity ?? 1) || 1,
                quantitySource: {kind: 'default', defaultedFromHost: true},
                services: [],
                serviceMap: {},
                meta: {
                    schema_version: propsRef.current.schema_version,
                    context: {
                        tag: 'unknown',
                        constraints: {},
                        nodeContexts: {},
                        policy: {ratePolicy: {kind: 'lte_primary'}, requireConstraintFit: true},
                    },
                },
            };
        }

        return buildOrderSnapshot(
            propsRef.current,
            builder,
            {
                activeTagId,
                formValuesByFieldId: effectiveMaps.formValuesByFieldId,
                optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
            },
            init.services,
            {
                mode,
                hostDefaultQuantity,
                fallback: fallbackPolicy,
            },
        );
    }, [activeTagId, builder, effectiveMaps.formValuesByFieldId, effectiveMaps.optionSelectionsByFieldId, fallbackPolicy, hostDefaultQuantity, init.services, mode]);

    /* ───────────────────────── mutators ───────────────────────── */

    const selectTag = useCallback((tagId: string) => {
        selection.replace(tagId);
    }, [selection]);

    const toggleOption = useCallback((fieldId: string, optionId: string) => {
        // If a FormContext exists, prefer using it; otherwise internal state
        if (formApi) {
            formApi.toggleSelection(fieldId, optionId);
            return;
        }
        setOptionSelectionsByFieldId(prev => {
            const cur = new Set(prev[fieldId] ?? []);
            if (cur.has(optionId)) cur.delete(optionId); else cur.add(optionId);
            return {...prev, [fieldId]: Array.from(cur)};
        });
    }, [formApi]);

    const setValue = useCallback((fieldId: string, value: Scalar | Scalar[]) => {
        if (formApi) {
            formApi.set(fieldId, value);
            return;
        }
        setFormValuesByFieldId(prev => ({...prev, [fieldId]: value}));
    }, [formApi]);

    const clearField = useCallback((fieldId: string) => {
        if (formApi) {
            formApi.set(fieldId, undefined as unknown as Scalar); // effectively clears
            formApi.setSelections(fieldId, []);
            return;
        }
        setFormValuesByFieldId(prev => {
            const next = {...prev};
            delete next[fieldId];
            return next;
        });
        setOptionSelectionsByFieldId(prev => {
            const next = {...prev};
            delete next[fieldId];
            return next;
        });
    }, [formApi]);

    const reset = useCallback(() => {
        const tags = propsRef.current.filters ?? [];
        const defaultTag = findDefaultTagId(tags) ?? tags[0]?.id;
        if (defaultTag) selection.replace(defaultTag);
        if (formApi) {
            // clear all known visible fields
            for (const fid of visibleFieldIds) {
                formApi.set(fid, undefined as unknown as Scalar);
                formApi.setSelections(fid, []);
            }
        } else {
            setFormValuesByFieldId({});
            setOptionSelectionsByFieldId({});
        }
    }, [formApi, selection, visibleFieldIds]);

    const buildSnapshot = useCallback((): OrderSnapshot => {
        const tagId = selection.currentTag();
        if (!tagId) throw new Error('OrderFlow: no active tag/context selected');

        return buildOrderSnapshot(
            propsRef.current,
            builder,
            {
                activeTagId: tagId,
                formValuesByFieldId: effectiveMaps.formValuesByFieldId,
                optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
            },
            init.services,
            {
                mode,
                hostDefaultQuantity,
                fallback: fallbackPolicy,
            },
        );
    }, [builder, effectiveMaps.formValuesByFieldId, effectiveMaps.optionSelectionsByFieldId, fallbackPolicy, hostDefaultQuantity, init.services, mode, selection]);

    /* ───────────────────────── return ───────────────────────── */

    return {
        activeTagId,
        visibleFieldIds,
        visibleFields,
        formValuesByFieldId: effectiveMaps.formValuesByFieldId,
        optionSelectionsByFieldId: effectiveMaps.optionSelectionsByFieldId,
        quantityPreview: previewSnapshot.quantity,
        services: previewSnapshot.services,
        serviceMap: previewSnapshot.serviceMap,

        selectTag,
        toggleOption,
        setValue,
        clearField,
        reset,

        buildSnapshot,
        setFallbackPolicy,
    };
}

/* ───────────────────────── helpers ───────────────────────── */

function findDefaultTagId(tags: Tag[]): string | undefined {
    if (!tags || !tags.length) return undefined;
    const hasRoot = tags.find(t => t.id === 'root');
    return hasRoot ? 'root' : tags[0].id;
}