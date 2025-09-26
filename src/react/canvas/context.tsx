import React, {createContext, useContext, useEffect, useMemo, useRef} from 'react';
import type {ReactNode} from 'react';
import {CanvasAPI} from './api';
import {Builder, BuilderOptions, createBuilder} from '../../core';
import type {CanvasOptions} from './types';
import type {CanvasBackendOptions} from './backend';
import {ServiceProps} from "../../schema";

const Ctx = createContext<CanvasAPI | null>(null);

export function CanvasProvider({api, children}: { api: CanvasAPI; children: ReactNode }) {
    return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCanvasAPI(): CanvasAPI {
    const api = useContext(Ctx);
    if (!api) throw new Error('useCanvasAPI must be used within <CanvasProvider>');
    return api;
}

/**
 * Create & memoize a CanvasAPI from a Builder.
 * - Disposes the previous API when builder changes.
 * - Accepts both view/state options and backend options.
 * - Warns (DEV only) if `opts` identity is changing every render.
 */
export function useCanvasFromBuilder(
    builder: Builder,
    opts?: CanvasOptions & CanvasBackendOptions
): CanvasAPI {
    // Warn (DEV) if the raw opts reference is churning each render
    useDevWarnOnOptsChurn(opts);

    // Stabilize opts content to avoid churn-driven re-instantiation
    const lastOptsRef = useRef<CanvasOptions & CanvasBackendOptions | undefined>(undefined);
    const stableOpts =
        opts && lastOptsRef.current && shallowEqualOpts(lastOptsRef.current, opts)
            ? lastOptsRef.current
            : (lastOptsRef.current = opts);

    const api = useMemo(() => new CanvasAPI(builder, stableOpts), [builder, stableOpts]);

    useEffect(() => {
        return () => {
            // Clean up listeners / timers when API instance is replaced or unmounted
            api.dispose?.();
        };
    }, [api]);

    return api;
}

/**
 * Use an existing CanvasAPI instance without creating/disposing anything.
 * Useful when the host fully manages the API lifecycle (e.g., from a parent).
 */
export function useCanvasFromExisting(api: CanvasAPI): CanvasAPI {
    // No disposal here—the host owns the instance
    return api;
}

/* ───────────────────────── helpers ───────────────────────── */

function shallowEqualOpts(
    a?: CanvasOptions & CanvasBackendOptions,
    b?: CanvasOptions & CanvasBackendOptions
) {
    if (a === b) return true;
    if (!a || !b) return false;
    const aKeys = Object.keys(a) as (keyof (CanvasOptions & CanvasBackendOptions))[];
    const bKeys = Object.keys(b) as (keyof (CanvasOptions & CanvasBackendOptions))[];
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if ((a as any)[k] !== (b as any)[k]) return false;
    }
    return true;
}

/** DEV-only: warn if opts identity changes on most renders (suggests wrapping in useMemo). */
function useDevWarnOnOptsChurn(opts?: CanvasOptions & CanvasBackendOptions) {
    const rawRef = useRef<typeof opts>(undefined);
    const churnCountRef = useRef(0);
    const lastWindowStartRef = useRef<number>(Date.now());
    const warnedRef = useRef(false);

    useEffect(() => {
        //@ts-ignore
        if (window.SITE?.env === 'production') return;
        const now = Date.now();

        // Reset window every 2s
        if (now - lastWindowStartRef.current > 2000) {
            lastWindowStartRef.current = now;
            churnCountRef.current = 0;
        }

        if (rawRef.current !== opts) {
            churnCountRef.current += 1;
            rawRef.current = opts;
        }

        // If we see churn on most renders in the window, warn once.
        if (!warnedRef.current && churnCountRef.current >= 5) {
            warnedRef.current = true;
            // eslint-disable-next-line no-console
            console.warn(
                '[digital-service-ui-builder] useCanvasFromBuilder: `opts` is changing identity frequently. ' +
                'Wrap your options in useMemo to avoid unnecessary API re-instantiation.'
            );
        }
    });
}

type UseCanvasOwnedReturn = { api: CanvasAPI; builder: Builder };

/** Creates a Builder once, loads initial props once, and owns the CanvasAPI lifecycle. */
export function useCanvasOwned(
    initialProps?: ServiceProps,
    canvasOpts?: CanvasOptions & CanvasBackendOptions,
    builderOpts?: BuilderOptions                    // ← pass builder params here
): UseCanvasOwnedReturn {
    // 1) Create the builder ONCE with the provided builder options
    const builderRef = useRef<Builder>();
    const builderOptsRef = useRef<BuilderOptions | undefined>(builderOpts);

    if (!builderRef.current) {
        builderRef.current = createBuilder(builderOptsRef.current); // ← forwarded
        if (initialProps) {
            builderRef.current.load(initialProps);
        }
        ///@ts-ignore
    } else if (window.SITE?.env !== 'production') {
        // Warn if builderOpts identity changes after first mount (they won't be applied)
        if (builderOptsRef.current !== builderOpts) {
            // eslint-disable-next-line no-console
            console.warn('[useCanvasOwned] builderOpts changed after init; new values are ignored. ' +
                'If you need to recreate the builder, remount the hook (e.g. change a React key).');
            builderOptsRef.current = builderOpts;
        }
    }
    const builder = builderRef.current!;

    // 2) Stabilize canvas options to avoid churn re-instantiation of CanvasAPI
    const lastCanvasOptsRef = useRef<typeof canvasOpts>();
    const stableCanvasOpts = useMemo(() => {
        if (!lastCanvasOptsRef.current) {
            lastCanvasOptsRef.current = canvasOpts;
            return canvasOpts;
        }
        const a = canvasOpts ?? {};
        const b = lastCanvasOptsRef.current ?? {};
        const same =
            Object.keys({...a, ...b}).every(k => (a as any)[k] === (b as any)[k]);
        if (same) return lastCanvasOptsRef.current;
        lastCanvasOptsRef.current = canvasOpts;
        return canvasOpts;
    }, [canvasOpts]);

    // 3) Create CanvasAPI and dispose on change/unmount
    const api = useMemo(() => new CanvasAPI(builder, stableCanvasOpts), [builder, stableCanvasOpts]);

    useEffect(() => () => {
        api.dispose?.();
    }, [api]);

    return {api, builder};
}