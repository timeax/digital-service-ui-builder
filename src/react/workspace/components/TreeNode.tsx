import React from 'react';
import type {ReactNode, KeyboardEvent, MouseEvent} from 'react';
import {useUi} from '../ui-bridge';

export type TreeNodeProps = {
    id: string;
    label: ReactNode;

    /** Visual nesting level (controls indentation). */
    depth?: number;

    /** Whether this node currently has (and can show) children. */
    hasChildren?: boolean;

    /** Expanded state (only meaningful if hasChildren). */
    expanded?: boolean;

    /** Selected state for styling/aria. */
    selected?: boolean;

    /** Disable interactions. */
    disabled?: boolean;

    /** Optional right-side content (badges, counters, etc.). */
    right?: ReactNode;

    /** Optional left adornment (icon/avatar). */
    leftAdornment?: ReactNode;

    /** Fired when caret is clicked or ArrowLeft/Right toggles. */
    onToggle?: (id: string) => void;

    /** Fired when the row is clicked or Enter/Space pressed. */
    onSelect?: (id: string, ev: MouseEvent | KeyboardEvent) => void;

    /** Extra class for the row container. */
    className?: string;

    /** Indentation size per depth level (px). Default 12. */
    indentStep?: number;

    /** Optional title attribute for the row. */
    title?: string;
};

/**
 * A single, reusable tree node row.
 * - No data coupling; parent renders its children when `expanded` is true.
 * - Accessible: role=treeitem, ArrowLeft/Right to collapse/expand, Enter/Space to select.
 */
export function TreeNode({
                             id,
                             label,
                             depth = 0,
                             hasChildren = false,
                             expanded = false,
                             selected = false,
                             disabled = false,
                             right,
                             leftAdornment,
                             onToggle,
                             onSelect,
                             className,
                             indentStep = 12,
                             title,
                         }: TreeNodeProps) {
    const {cn} = useUi();

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;

        if (e.key === 'ArrowRight' && hasChildren) {
            if (!expanded) onToggle?.(id);
            else onSelect?.(id, e);
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' && hasChildren) {
            if (expanded) onToggle?.(id);
            else {
                // optional: bubble to parent in your tree impl
            }
            e.preventDefault();
        } else if (e.key === 'Enter' || e.key === ' ') {
            onSelect?.(id, e);
            e.preventDefault();
        }
    };

    const handleRowClick = (e: MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        onSelect?.(id, e);
    };

    const handleCaretClick = (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (disabled) return;
        onToggle?.(id);
    };

    const padLeft = 8 + depth * indentStep;

    return (
        <div
            role="treeitem"
            aria-expanded={hasChildren ? expanded : undefined}
            aria-selected={selected || undefined}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : 0}
            onKeyDown={handleKeyDown}
            onClick={handleRowClick}
            title={title}
            className={cn(
                'group flex items-center justify-between rounded px-2 py-1.5 cursor-pointer select-none',
                disabled ? 'opacity-60 cursor-not-allowed' :
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                className
            )}
            style={{paddingLeft: padLeft}}
            data-node-id={id}
        >
            <div className="flex items-center gap-2 min-w-0">
                {/* Caret or spacer */}
                {hasChildren ? (
                    <button
                        type="button"
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                        onClick={handleCaretClick}
                        className="h-5 w-5 grid place-items-center rounded hover:bg-muted-foreground/10 focus:outline-none"
                    >
                        <span className="text-xs">{expanded ? '▾' : '▸'}</span>
                    </button>
                ) : (
                    <span className="h-5 w-5"/>
                )}

                {/* Optional left adornment (icon/avatar) */}
                {leftAdornment ?? null}

                {/* Label */}
                <span className="truncate text-sm">{label}</span>
            </div>

            {/* Right slot (badges, counters, etc.) */}
            <div className="flex items-center gap-2 shrink-0">
                {right}
            </div>
        </div>
    );
}