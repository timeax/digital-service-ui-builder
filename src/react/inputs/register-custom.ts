import type {Registry, InputDescriptor, InputKind, InputVariant, InputAdapter} from "@/react";

const moduleCache = new Map<string, unknown>();

export type RegisterCustomOptions = {
    /** Full URL to the module (host-controlled & trusted) */
    url: string;
    /** Descriptor key; recommend prefixing with "custom:" e.g. "custom:Rating" */
    kind: InputKind;
    /** Optional variant; defaults to "default" */
    variant?: InputVariant;
    /** Which export to use; defaults to "default" */
    exportName?: string;
    /** Optional adapter + default props */
    adapter?: InputAdapter;
    defaultProps?: Record<string, unknown>;
};

/**
 * Dynamically imports a remote component and registers it in the input registry.
 * Call this client-side (e.g., inside useEffect) to avoid SSR pitfalls.
 */
export async function registerCustomFromUrl(
    registry: Registry,
    opts: RegisterCustomOptions
): Promise<void> {
    const {url, kind, variant, exportName = 'default', adapter, defaultProps} = opts;

    if (typeof window === 'undefined') {
        // No-op on server
        return;
    }

    let mod: any = moduleCache.get(url);
    if (!mod) {
        // Host must ensure origin trust/safety
        mod = await import(/* webpackIgnore: true */ url);
        moduleCache.set(url, mod);
    }

    const Component = mod?.[exportName];
    if (!Component) {
        // eslint-disable-next-line no-console
        console.warn(`[registerCustomFromUrl] Export "${exportName}" not found at ${url}`);
        return;
    }

    const descriptor: InputDescriptor = {Component, ...(adapter ? {adapter} : {}), ...(defaultProps ? {defaultProps} : {})};
    registry.register(kind, descriptor, variant);
}

/** Optional helper to pre-warm the cache (no registration) */
export async function preloadCustomModule(url: string): Promise<void> {
    if (moduleCache.has(url)) return;
    if (typeof window === 'undefined') return;
    const mod = await import(/* webpackIgnore: true */ url);
    moduleCache.set(url, mod);
}