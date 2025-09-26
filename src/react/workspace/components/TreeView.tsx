import React from 'react';
import type {ReactNode} from 'react';
import {useUi} from '../ui-bridge';
import {TreeNode} from './TreeNode';

export type TreeViewProps<T> = {
    /** Data source: flat or nested */
    data: T[];

    /** Required accessors */
    getId: (node: T) => string;
    getLabel: (node: T) => ReactNode;

    /** Provide exactly one of these (or neither = flat roots only) */
    getChildren?: (node: T) => T[] | undefined;
    getParentId?: (node: T) => string | null | undefined;

    /** Expansion (controlled or uncontrolled) */
    expandedIds?: string[];
    defaultOpen?: 'roots' | 'all' | 'none';
    onExpandedChange?: (ids: string[]) => void;

    /** Selection (controlled or uncontrolled) */
    selectedIds?: string[];
    onSelectionChange?: (ids: string[], primary?: string) => void;
    /** 'single' = replace on click; 'multi-modifier' = toggle with Ctrl/Cmd/Shift; 'multi' = always toggle */
    selectionMode?: 'single' | 'multi-modifier' | 'multi';

    /** Row hooks */
    onRowClick?: (node: T, id: string, ev: React.MouseEvent) => void;
    onToggleExpand?: (node: T, id: string) => void;

    /** Row decorations */
    renderRight?: (node: T, ctx: { depth: number }) => ReactNode;
    renderLeftAdornment?: (node: T, ctx: { depth: number }) => ReactNode;
    rowClassName?: (node: T, ctx: { depth: number; selected: boolean }) => string | undefined;

    /** Appearance */
    indentStep?: number;
    className?: string;
    listClassName?: string;
};

/** Internal tree shape */
type NodeRef<T> = { item: T; depth: number; children: NodeRef<T>[] };

function buildForestFromNested<T>(
    roots: T[],
    getChildren: (n: T) => T[] | undefined,
    depth = 0
): NodeRef<T>[] {
    return roots.map(item => ({
        item,
        depth,
        children: buildForestFromNested(getChildren(item) ?? [], getChildren, depth + 1),
    }));
}

function buildForestFromFlat<T>(
    data: T[],
    getId: (n: T) => string,
    getParentId: (n: T) => string | null | undefined
): NodeRef<T>[] {
    const byId = new Map<string, T>();
    const children = new Map<string, T[]>();
    for (const n of data) {
        byId.set(getId(n), n);
    }
    for (const n of data) {
        const pid = getParentId(n) ?? '';
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid)!.push(n);
    }

    const make = (n: T, depth: number): NodeRef<T> => ({
        item: n,
        depth,
        children: (children.get(getId(n)) ?? []).map(c => make(c, depth + 1)),
    });

    // roots: parent missing/falsy OR not present in set
    const roots: T[] = [];
    for (const n of data) {
        const pid = getParentId(n);
        if (!pid || !byId.has(pid)) roots.push(n);
    }
    return roots.map(r => make(r, 0));
}

export function TreeView<T>({
                                data,
                                getId,
                                getLabel,
                                getChildren,
                                getParentId,

                                expandedIds,
                                defaultOpen = 'roots',
                                onExpandedChange,

                                selectedIds,
                                onSelectionChange,
                                selectionMode = 'single',

                                onRowClick,
                                onToggleExpand,

                                renderRight,
                                renderLeftAdornment,
                                rowClassName,

                                indentStep = 12,
                                className,
                                listClassName,
                            }: TreeViewProps<T>) {
    const {cn} = useUi();

    // Build a stable forest representation
    const forest = React.useMemo<NodeRef<T>[]>(() => {
        if (getChildren) {
            return buildForestFromNested(data, getChildren, 0);
        }
        if (getParentId) {
            return buildForestFromFlat(data, getId, getParentId);
        }
        // default: flat → every node is a root with no children
        return data.map(item => ({item, depth: 0, children: []}));
    }, [data, getChildren, getParentId, getId]);

    // Index for quick lookups
    const allIds = React.useMemo(() => {
        const ids: string[] = [];
        const walk = (nodes: NodeRef<T>[]) => {
            for (const n of nodes) {
                ids.push(getId(n.item));
                if (n.children.length) walk(n.children);
            }
        };
        walk(forest);
        return new Set(ids);
    }, [forest, getId]);

    // Uncontrolled expansion
    const [open, setOpen] = React.useState<Set<string>>(() => {
        if (expandedIds) return new Set(expandedIds);
        const s = new Set<string>();
        if (defaultOpen === 'all') return allIds;
        if (defaultOpen === 'roots') {
            for (const n of forest) {
                s.add(getId(n.item));
                for (const c of n.children) s.add(getId(c.item));
            }
        }
        return s;
    });

    // Keep controlled expansion in sync
    React.useEffect(() => {
        if (!expandedIds) return;
        setOpen(new Set(expandedIds.filter(id => allIds.has(id))));
    }, [expandedIds, allIds]);

    const setOpenAndNotify = (next: Set<string>) => {
        setOpen(next);
        onExpandedChange?.(Array.from(next));
    };

    const toggleExpand = (node: NodeRef<T>) => {
        const id = getId(node.item);
        const next = new Set(open);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setOpenAndNotify(next);
        onToggleExpand?.(node.item, id);
    };

    // Selection (uncontrolled fallback)
    const [sel, setSel] = React.useState<Set<string>>(
        () => new Set((selectedIds ?? []).filter(id => allIds.has(id)))
    );
    React.useEffect(() => {
        if (selectedIds) setSel(new Set(selectedIds.filter(id => allIds.has(id))));
    }, [selectedIds, allIds]);

    const setSelAndNotify = (next: Set<string>, primary?: string) => {
        setSel(next);
        onSelectionChange?.(Array.from(next), primary);
    };

    const clickRow = (node: NodeRef<T>) => (ev: React.MouseEvent) => {
        const id = getId(node.item);
        const controlled = !!selectedIds;
        const cur = controlled ? new Set(selectedIds) : new Set(sel);

        const toggle = () => {
            if (cur.has(id)) cur.delete(id);
            else cur.add(id);
        };
        const replace = () => {
            cur.clear();
            cur.add(id);
        };

        if (selectionMode === 'single') {
            replace();
        } else if (selectionMode === 'multi') {
            toggle();
        } else {
            // multi-modifier
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey) toggle();
            else replace();
        }

        setSelAndNotify(cur, id);
        onRowClick?.(node.item, id, ev);
    };

    const render = (nodes: NodeRef<T>[]) => (
        <ul role="group" className={cn('space-y-0.5', listClassName)}>
            {nodes.map(node => {
                const id = getId(node.item);
                const expanded = open.has(id);
                const selected = sel.has(id);
                const children = node.children;
                const hasChildren = children.length > 0;

                return (
                    <li key={id} role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
                        <TreeNode
                            id={id}
                            label={getLabel(node.item)}
                            depth={node.depth}
                            hasChildren={hasChildren}
                            expanded={expanded}
                            selected={selected}
                            indentStep={indentStep}
                            right={renderRight?.(node.item, {depth: node.depth})}
                            leftAdornment={renderLeftAdornment?.(node.item, {depth: node.depth})}
                            onToggle={() => toggleExpand(node)}
                            onSelect={(_, ev) => clickRow(node)(ev as any)}
                            className={rowClassName?.(node.item, {depth: node.depth, selected})}
                        />
                        {hasChildren && expanded ? render(children) : null}
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div role="tree" className={cn('h-full overflow-auto', className)}>
            {render(forest)}
        </div>
    );
}