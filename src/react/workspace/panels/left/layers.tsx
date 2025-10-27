import React from 'react';
import { useCanvasAPI } from '../../../canvas/context';
import type { ServiceProps, Tag } from '../../../../schema';
import { Selection } from '../../../canvas/selection';
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";

type TreeNode = {
    id: string;
    label: string;
    children: TreeNode[];
    tag: Tag;
};

function buildTagTree(tags: Tag[]): TreeNode[] {
    const byId = new Map(tags.map(t => [t.id, t]));
    const childrenMap = new Map<string, Tag[]>();
    for (const t of tags) {
        const p = t.bind_id ?? null;
        if (!childrenMap.has(p as any)) childrenMap.set(p as any, []);
        childrenMap.get(p as any)!.push(t);
    }
    const makeNode = (t: Tag): TreeNode => ({
        id: t.id,
        label: t.label ?? t.id,
        tag: t,
        children: (childrenMap.get(t.id) ?? []).map(makeNode),
    });
    // roots = tags without a valid parent (or parent=null)
    const roots = (childrenMap.get(null as any) ?? []).map(makeNode);
    // Fallback to explicit 'root' if present but not grouped as null
    if (!roots.length) {
        const root = tags.find(t => t.id === 'root' || t.id === 't:root');
        if (root) return [makeNode(root)];
    }
    return roots;
}

export function Layers() {
    const api = useCanvasAPI();
    const builder = api['builder'] ?? (api as any).getBuilder?.(); // tolerate either shape

    // pull current props
    const props = builder.getProps() as ServiceProps;
    const tags = props.filters ?? [];
    const fields = props.fields ?? [];

    // selection (workspace semantics)
    const selectionRef = React.useRef<Selection>();
    if (!selectionRef.current) {
        selectionRef.current = new Selection(builder, { env: 'workspace', rootTagId: 'root' });
        // seed to root if nothing is selected
        const hasAny = selectionRef.current.all().size > 0;
        if (!hasAny) selectionRef.current.replace(tags.find(t => t.id === 'root' || t.id === 't:root')?.id ?? tags[0]?.id);
    }
    const selection = selectionRef.current;

    // subscribe to external selection, if your CanvasAPI mirrors it later you can sync here.
    // For now we keep the panel-local selection and let the canvas read it via the same builder if needed.

    // expanded/collapsed state per tag
    const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() => {
        const init: Record<string, boolean> = {};
        // open root chains initially
        for (const t of tags) {
            if (!t.bind_id) init[t.id] = true;
        }
        return init;
    });

    const toggleExpand = (id: string) => setExpanded(s => ({ ...s, [id]: !s[id] }));

    const onClickTag = (id: string, e: React.MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            selection.toggle(id);
        } else {
            selection.replace(id);
        }
        // Optional: focus canvas
        try { (api as any).focus?.([id]); } catch {}
    };

    // compute single/multi result
    const vg = selection.visibleGroup();
    const isMulti = vg.kind === 'multi';
    const group = vg.kind === 'single' ? vg.group : undefined;

    const tree = React.useMemo(() => buildTagTree(tags), [tags]);

    const renderTree = (nodes: TreeNode[], depth = 0) => (
        <ul className={cn('space-y-1')}>
            {nodes.map(node => {
                const isOpen = !!expanded[node.id];
                const isSelected = selection.all().has(node.id);
                return (
                    <li key={node.id}>
                        <div
                            className={cn(
                                'flex items-center justify-between rounded px-2 py-1.5 cursor-pointer',
                                isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                            )}
                            onClick={(e) => onClickTag(node.id, e)}
                        >
                            <div className="flex items-center gap-2">
                                {node.children.length > 0 && (
                                    <button
                                        className="text-xs rounded px-1 py-0.5 hover:bg-muted-foreground/10"
                                        onClick={(e) => { e.stopPropagation(); toggleExpand(node.id); }}
                                        title={isOpen ? 'Collapse' : 'Expand'}
                                    >
                                        {isOpen ? '▾' : '▸'}
                                    </button>
                                )}
                                <span className="text-sm" style={{ paddingLeft: depth ? depth * 8 : 0 }}>
                  {node.label}
                </span>
                            </div>
                            {/* quick statistics: number of bound fields */}
                            <span className="text-xs text-muted-foreground">
                {fields.filter(f => Array.isArray(f.bind_id) ? f.bind_id.includes(node.id) : f.bind_id === node.id).length}
              </span>
                        </div>
                        {isOpen && node.children.length > 0 && (
                            <div className="pl-3">{renderTree(node.children, depth + 1)}</div>
                        )}
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="flex h-full flex-col">
            {/* Tag tree */}
            <div className="px-3 pt-3 pb-2">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Tags
                </div>
                {renderTree(tree)}
            </div>

            <div className="px-3 py-2"><Separator /></div>

            {/* Visible under current tag (only when single-context) */}
            <div className="px-3 pb-3 overflow-auto">
                <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {isMulti ? 'Multiple tags selected' : 'Fields in view'}
                    </div>
                    {!isMulti && group?.tag?.label ? (
                        <div className="text-xs text-muted-foreground">under <span className="font-medium">{group.tag.label}</span></div>
                    ) : null}
                </div>

                {isMulti ? (
                    <div className="text-sm text-muted-foreground">
                        Workspace multi-select active. Use canvas actions to edit multiple groups.
                    </div>
                ) : (
                    <ul className="space-y-1">
                        {(group?.fields ?? []).map(f => {
                            const bound = Array.isArray(f.bind_id) ? f.bind_id : [f.bind_id].filter(Boolean);
                            const isSrv = (f.options ?? []).some(o => o.service_id != null);
                            return (
                                <li
                                    key={f.id}
                                    className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted cursor-default"
                                    title={isSrv ? 'Service-backed' : (f.name ? 'User input' : 'Unspecified')}
                                >
                                    <div className="min-w-0">
                                        <div className="truncate text-sm">{f.label ?? f.id}</div>
                                        <div className="text-xs text-muted-foreground truncate">
                                            {bound.length ? `bound: ${bound.join(', ')}` : 'unbound'}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 pl-3 shrink-0">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {(f.options ?? []).length} opts
                    </span>
                                    </div>
                                </li>
                            );
                        })}
                        {(group?.fields?.length ?? 0) === 0 && (
                            <li className="text-sm text-muted-foreground">No fields visible here.</li>
                        )}
                    </ul>
                )}
            </div>

            {/* Footer actions (optional; basic placeholders without hard deps on Editor APIs) */}
            <div className="mt-auto px-3 py-2 border-t bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40">
                <div className="flex items-center justify-end gap-2">
                    {/* These are intentionally no-ops unless you wire them to Editor later */}
                    <Button variant="outline" size="sm" onClick={() => selection.replace('root')}>
                        Go Root
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => {
                        // canvas focus on current group/tag
                        const tagId = (selection.visibleGroup().kind === 'single')
                            ? (selection.visibleGroup() as any).group.tagId
                            : undefined;
                        if (tagId) try { (api as any).focus?.([tagId]); } catch {}
                    }}>
                        Focus
                    </Button>
                </div>
            </div>
        </div>
    );
}