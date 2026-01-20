import { ContextMenuRenderer } from "@/react/workspace/components/context-menu-renderer";
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { CanvasAPI } from "@/react";

/* ───────────────────── Types ───────────────────── */

export type ContextScope =
    | "file"
    | "folder"
    | "library"
    | "empty"
    | (string & {});

export type ContextState = CtxWithAttach;

// Allow attaching UI-scoped helpers (e.g., Sidebar startAdd)
type CtxWithAttach = CanvasAPI;
export interface MenuItem {
    key?: React.Key;
    label?: string;
    icon?: React.ReactNode;
    hint?: string;
    divider?: boolean;
    danger?: boolean;
    disabled?: boolean | ((ctx: CtxWithAttach) => boolean);
    onSelect?: (args: {
        ctx: CtxWithAttach;
        nativeEvent: MouseEvent | KeyboardEvent;
    }) => void | Promise<void>;
    children?: MenuItem[];
}

interface InternalState {
    open: boolean;
    x: number;
    y: number;
    items: MenuItem[];
    ariaLabel?: string;
    ctx: CtxWithAttach;
}

export type MenuBuilder =
    | MenuItem[]
    | ((opts: {
          ctx: ContextState;
          nativeEvent?: MouseEvent;
      }) => MenuItem[] | Promise<MenuItem[]>);

export interface OpenOptions {
    /** A11y label for the menu. */
    ariaLabel?: string;
    /** Context state used by disabled predicates & callbacks. */
    ctx?: ContextState;
    /** If you already have precise coords, pass them. Otherwise we’ll use the event’s clientX/Y. */
    coords?: { x: number; y: number };
    /** Native event (if any). */
    nativeEvent?: MouseEvent;
}

export interface ContextMenuApi {
    openAt: (
        evOrCoords: MouseEvent | { x: number; y: number },
        items: MenuBuilder,
        options?: OpenOptions,
    ) => void;
    close: () => void;
    /** Ergonomic helper for `onContextMenu={cm.bind(() => items, { ctx: ... })}` */
    bind: (
        builder: (ev: React.MouseEvent) => MenuBuilder | Promise<MenuBuilder>,
        options?: Omit<OpenOptions, "nativeEvent" | "coords">,
    ) => (ev: React.MouseEvent) => void;
}

/* ───────────────────── Context ───────────────────── */

const Ctx = createContext<ContextMenuApi | null>(null);

export const useContextMenu = (): ContextMenuApi => {
    const api = useContext(Ctx);
    if (!api) {
        throw new Error(
            "useContextMenu() must be used under <ContextMenuProvider>.",
        );
    }
    return api;
};

/* ───────────────────── Provider ───────────────────── */

export const Ctxmenu: React.FC<{
    children: React.ReactNode;
    zIndex?: number;
}> = ({
    children,
    zIndex = 60, // sits above most app chrome; tweak if needed
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);

    const [state, setState] = useState<InternalState>({
        open: false,
        x: 0,
        y: 0,
        items: [],
        ariaLabel: "Context menu",
        //@ts-expect-error
        ctx: {},
    });

    const [measured, setMeasured] = useState<{ w: number; h: number }>({
        w: 0,
        h: 0,
    });

    // Close on outside click / ESC
    useEffect(() => {
        if (!state.open) return;

        const onDown = (e: MouseEvent) => {
            const el = containerRef.current;
            if (el && !el.contains(e.target as Node)) {
                setState((s) => ({ ...s, open: false }));
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setState((s) => ({ ...s, open: false }));
            }
        };

        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, [state.open]);

    // Clamp menu within viewport after render
    useLayoutEffect(() => {
        if (!state.open) return;
        const el = containerRef.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        if (rect.width !== measured.w || rect.height !== measured.h) {
            setMeasured({ w: rect.width, h: rect.height });
        }

        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let nx = state.x;
        let ny = state.y;

        if (nx + rect.width + margin > vw)
            nx = Math.max(margin, vw - rect.width - margin);
        if (ny + rect.height + margin > vh)
            ny = Math.max(margin, vh - rect.height - margin);

        if (nx !== state.x || ny !== state.y) {
            setState((s) => ({ ...s, x: nx, y: ny }));
        }
    }, [state.open, state.x, state.y, measured.w, measured.h]);

    const resolveItems = useCallback(
        async (items: MenuBuilder, opts: OpenOptions): Promise<MenuItem[]> => {
            let raw: MenuItem[] | Promise<MenuItem[]>;
            if (typeof items === "function") {
                raw = items({
                    //@ts-expect-error
                    ctx: opts.ctx ?? {},
                    nativeEvent: opts.nativeEvent,
                });
            } else {
                raw = items;
            }
            const resolved = await raw;
            return Array.isArray(resolved) ? resolved : [];
        },
        [],
    );

    const openAt = useCallback<ContextMenuApi["openAt"]>(
        async (evOrCoords, items, options) => {
            const nativeEvent =
                "x" in evOrCoords
                    ? options?.nativeEvent
                    : (evOrCoords as MouseEvent);
            const coords =
                "x" in evOrCoords
                    ? evOrCoords
                    : {
                          x: (evOrCoords as MouseEvent).clientX,
                          y: (evOrCoords as MouseEvent).clientY,
                      };

            if (
                !("x" in evOrCoords) &&
                (evOrCoords as MouseEvent).preventDefault
            ) {
                (evOrCoords as MouseEvent).preventDefault();
            }

            const resolved = await resolveItems(items, {
                ...(options ?? {}),
                nativeEvent,
            });
            setState({
                open: true,
                x: coords.x,
                y: coords.y,
                items: resolved,
                ariaLabel: options?.ariaLabel ?? "Context menu",
                //@ts-expect-error
                ctx: options?.ctx ?? {},
            });
        },
        [resolveItems],
    );

    const close = useCallback(
        () => setState((s) => ({ ...s, open: false })),
        [],
    );

    const bind = useCallback<ContextMenuApi["bind"]>(
        (builder, options) => {
            return (ev: React.MouseEvent) => {
                ev.preventDefault();
                const native: MouseEvent = ev.nativeEvent;
                const maybePromise = builder(ev);
                Promise.resolve(maybePromise).then((items) => {
                    openAt(
                        { x: native.clientX, y: native.clientY },
                        // If builder returned a function or array, pass through; openAt will resolve again safely.
                        typeof items === "function" || Array.isArray(items)
                            ? (items as MenuBuilder)
                            : [],
                        { ...(options ?? {}), nativeEvent: native },
                    );
                });
            };
        },
        [openAt],
    );

    const api = useMemo<ContextMenuApi>(
        () => ({ openAt, close, bind }),
        [openAt, close, bind],
    );

    return (
        <Ctx.Provider value={api}>
            {children}
            {state.open &&
                createPortal(
                    <div
                        ref={containerRef}
                        className="fixed z-[9999]"
                        style={{ left: state.x, top: state.y, zIndex }}
                        role="dialog"
                        aria-label={state.ariaLabel}
                    >
                        <ContextMenuRenderer
                            items={state.items}
                            ctx={state.ctx}
                            onClose={close}
                            onAction={(it, e) =>
                                it.onSelect?.({
                                    ctx: state.ctx,
                                    nativeEvent: e,
                                })
                            }
                        />
                    </div>,
                    document.body,
                )}
        </Ctx.Provider>
    );
};
