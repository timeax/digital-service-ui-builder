import type { ContextState, MenuItem } from "@/context/ContextMenuProvider";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Pure presentational menu. Mirrors Stitch spec:
 * - 8px+ padding groups with 1px separators
 * - Icons on the left, label, right-aligned hint
 * - Disabled shows muted colors + not-allowed cursor
 * - Danger shows red accents
 */
export const ContextMenuRenderer: React.FC<{
    items: MenuItem[];
    ctx: ContextState;
    onClose: () => void;
    onAction: (item: MenuItem, e: MouseEvent | KeyboardEvent) => void;
}> = ({ items, ctx, onClose, onAction }) => {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [focusIdx, setFocusIdx] = useState<number>(() => nextFocusable(items, ctx, -1));

    const flat = useMemo(
        () => items, // simple 1-level for now; submenus can extend this
        [items],
    );

    const isDisabled = useCallback((it: MenuItem) => (typeof it.disabled === 'function' ? it.disabled(ctx) : !!it.disabled), [ctx]);

    const handleActivate = useCallback(
        (it: MenuItem, e: MouseEvent | KeyboardEvent) => {
            if (isDisabled(it) || it.divider || !it.onSelect) return;
            onAction(it, e);
            onClose();
        },
        [isDisabled, onClose, onAction],
    );

    // Keyboard support
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setFocusIdx((i) => nextFocusable(flat, ctx, i));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setFocusIdx((i) => prevFocusable(flat, ctx, i));
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const it = flat[focusIdx];
                if (it) handleActivate(it, e);
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [flat, ctx, focusIdx, handleActivate, onClose]);

    return (
        <div
            ref={rootRef}
            className="w-64 min-w-max rounded-lg border border-slate-200/80 bg-white shadow-xl shadow-slate-950/5 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900"
            role="menu"
            aria-orientation="vertical"
        >
            <div className="flex flex-col gap-0.5 p-1.5">
                {flat.map((it, idx) => {
                    if (it.divider) {
                        return <hr key={`div-${idx}`} className="my-1.5 border-t border-slate-200 dark:border-slate-800" aria-hidden />;
                    }

                    const disabled = isDisabled(it);
                    const danger = !!it.danger;
                    const focused = idx === focusIdx;

                    return (
                        <button
                            key={it.key ?? idx}
                            type="button"
                            role="menuitem"
                            aria-disabled={disabled || undefined}
                            onMouseEnter={() => setFocusIdx(idx)}
                            onClick={(e) => {
                                e.preventDefault();
                                if (disabled) return;
                                handleActivate(it, e.nativeEvent);
                            }}
                            className={[
                                'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-3 text-sm font-medium',
                                disabled
                                    ? 'cursor-not-allowed text-slate-400 dark:text-slate-600'
                                    : danger
                                      ? 'text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300'
                                      : focused
                                        ? 'bg-primary/10 text-slate-900 dark:text-slate-100'
                                        : 'text-slate-700 hover:bg-primary/10 dark:text-slate-300',
                            ].join(' ')}
                        >
                            <span className="flex items-center gap-3">
                                {it.icon ?? null}
                                <span className="truncate">{it.label}</span>
                            </span>
                            {it.hint ? <span className="text-xs text-slate-400 dark:text-slate-500">{it.hint}</span> : <span />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

/* ───────────────────── Helpers ───────────────────── */

function nextFocusable(items: MenuItem[], ctx: ContextState, from: number): number {
    for (let i = from + 1; i < items.length; i++) {
        const it = items[i];
        if (it.divider) continue;
        const disabled = typeof it.disabled === 'function' ? it.disabled(ctx) : !!it.disabled;
        if (!disabled) return i;
    }
    // wrap
    for (let i = 0; i <= from && i < items.length; i++) {
        const it = items[i];
        if (it.divider) continue;
        const disabled = typeof it.disabled === 'function' ? it.disabled(ctx) : !!it.disabled;
        if (!disabled) return i;
    }
    return Math.max(0, Math.min(items.length - 1, from));
}

function prevFocusable(items: MenuItem[], ctx: ContextState, from: number): number {
    for (let i = from - 1; i >= 0; i--) {
        const it = items[i];
        if (it.divider) continue;
        const disabled = typeof it.disabled === 'function' ? it.disabled(ctx) : !!it.disabled;
        if (!disabled) return i;
    }
    // wrap
    for (let i = items.length - 1; i >= from && i >= 0; i--) {
        const it = items[i];
        if (it.divider) continue;
        const disabled = typeof it.disabled === 'function' ? it.disabled(ctx) : !!it.disabled;
        if (!disabled) return i;
    }
    return Math.max(0, Math.min(items.length - 1, from));
}
