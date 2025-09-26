import React from 'react';
import {useUi} from '../ui-bridge';
import {useCanvasAPI} from '../../canvas/context';
import type {Tag, Field, ServiceProps} from '../../../schema';
import {TreeView} from '../components/TreeView';
import {Selection} from '../../canvas/selection';

function countBound(fields: Field[] = [], tagId: string) {
    let n = 0;
    for (const f of fields) {
        const b = f.bind_id;
        if (Array.isArray(b) ? b.includes(tagId) : b === tagId) n++;
    }
    return n;
}

export function LeftPanel() {
    const {
        Tabs, TabsList, TabsTrigger, TabsContent,
        ResizablePanelGroup, ResizablePanel, ResizableHandle,
        Separator
    } = useUi();

    const api = useCanvasAPI();
    const builder = (api as any).builder ?? (api as any).getBuilder?.();
    const props = builder.getProps() as ServiceProps;
    const tags = props.filters ?? [];
    const fields = props.fields ?? [];

    // Workspace selection (shared or local)
    const selRef = React.useRef<Selection>();
    if (!selRef.current) {
        selRef.current = new Selection(builder, {env: 'workspace', rootTagId: 'root'});
        const rootId = tags.find(t => t.id === 'root' || t.id === 't:root')?.id ?? tags[0]?.id;
        if (rootId) selRef.current.replace(rootId);
    }
    const selection = selRef.current;
    const selectedIds = React.useMemo(() => Array.from(selection.all()), [selection, props]); // props to refresh tree

    return (
        <Tabs defaultValue="layers" className="flex-1 flex flex-col min-h-0">
            <div className="px-3 pt-2 border-b">
                <TabsList>
                    <TabsTrigger value="layers">Layers</TabsTrigger>
                    <TabsTrigger value="active-services">Active Services</TabsTrigger>
                    <TabsTrigger value="templates">Templates</TabsTrigger>
                </TabsList>
            </div>

            {/* LAYERS */}
            <TabsContent value="layers" className="flex-1 m-0 min-h-0">
                <ResizablePanelGroup direction="vertical" className="min-h-0">
                    {/* TAGS (top) */}
                    <ResizablePanel defaultSize={60} minSize={30} className="flex min-h-0 flex-col">
                        <div
                            className="px-3 pt-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Tags
                        </div>
                        <div className="px-2 pb-2">
                            <Separator/>
                        </div>

                        <div className="flex-1 overflow-auto">
                            <TreeView<Tag>
                                data={tags}
                                getId={(t) => t.id}
                                getLabel={(t) => t.label ?? t.id}
                                getParentId={(t) => t.bind_id}
                                defaultOpen="roots"
                                // selection (controlled by Selection)
                                selectedIds={selectedIds.filter(id => tags.some(t => t.id === id))}
                                onSelectionChange={(ids) => selection.many(ids)}
                                selectionMode="multi-modifier"
                                // right-side: bound field count
                                renderRight={(t) => (
                                    <span className="text-xs text-muted-foreground tabular-nums">
                    {countBound(fields, t.id)}
                  </span>
                                )}
                                // optional: focus canvas on click
                                onRowClick={(t) => {
                                    try {
                                        (api as any).focus?.([t.id]);
                                    } catch {
                                    }
                                }}
                            />
                        </div>
                    </ResizablePanel>

                    <ResizableHandle/>

                    {/* FIELDS (bottom) — visible group only (stub for now) */}
                    <ResizablePanel defaultSize={40} minSize={20} className="flex flex-col">
                        <div
                            className="px-3 pt-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Fields (Visible Group)
                        </div>
                        <div className="px-3 pb-3 text-sm text-muted-foreground">
                            {/* Step 2 will render fields/options for the current visible group here */}
                            Select a tag to see fields in its visible group. (Rendering comes in the next step.)
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </TabsContent>

            {/* ACTIVE SERVICES */}
            <TabsContent value="active-services" className="flex-1 m-0 min-h-0">
                <div className="px-3 pt-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Active Services
                </div>
                <div className="px-3 text-sm text-muted-foreground">
                    This will list services currently mapped to tags/options. (We’ll wire this after Layers.)
                </div>
            </TabsContent>

            {/* TEMPLATES */}
            <TabsContent value="templates" className="flex-1 m-0">
                <div className="px-3 pt-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Templates
                </div>
                <div className="px-3 text-sm text-muted-foreground">
                    Host-provided blueprints will appear here. (We’ll wire this after Active Services.)
                </div>
            </TabsContent>
        </Tabs>
    );
}