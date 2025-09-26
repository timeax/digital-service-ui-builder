// src/react/workspace/WorkspaceLayout.tsx
import React from 'react';
import type {ReactNode} from 'react';
import {useUi} from './ui-bridge';

// ⚠️ These are your built-ins (we’ll implement them next):
import {StructurePanel} from './panels/StructurePanel';          // left
import {CommentsPanel} from './panels/CommentsPanel';            // right → “Comments”
import FlowCanvas from '../adapters/reactflow';
import {CanvasProvider, useCanvasOwned} from "../canvas/context";
import {LeftPanel} from "./panels/LeftPanel";
import {initialProps, serviceMap} from "./data";         // middle (React Flow adapter)

export type WorkspaceLayoutProps = {
    /** Addons rendered in the CANVAS toolbar row (right side on desktop, in top bar on mobile). */
    canvasToolbarAddon?: ReactNode;
    /** Addons rendered as an overlay *inside* the canvas area (absolute positioned). */
    canvasOverlayAddon?: ReactNode;
    /** Host-provided right-panel tab content (second tab). Omit to hide the tab. */
    rightCustom?: ReactNode;

    /** Initial panel sizes (percentages). */
    initialSizes?: { left?: number; middle?: number; right?: number };
    /** Minimum panel sizes (percentages). */
    minSizes?: { left?: number; right?: number };

    /** ClassName hooks */
    className?: string;
    leftClassName?: string;
    canvasClassName?: string;
    rightClassName?: string;

    /** Show/hide right panel entirely (comments + custom). */
    showRight?: boolean;
};

export function WorkspaceLayout({
                                    canvasToolbarAddon,
                                    canvasOverlayAddon,
                                    rightCustom,
                                    initialSizes = {left: 22, middle: 56, right: 22},
                                    minSizes = {left: 16, right: 18},
                                    className,
                                    leftClassName,
                                    canvasClassName,
                                    rightClassName,
                                    showRight = true,
                                }: WorkspaceLayoutProps) {
    const {
        ResizablePanelGroup, ResizablePanel, ResizableHandle,
        Tabs, TabsList, TabsTrigger, TabsContent,
        Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose,
        Button, Separator, cn,
    } = useUi();

    const [rightTab, setRightTab] = React.useState<'comments' | 'custom'>('comments');
    const [isLeftDrawerOpen, setLeftDrawerOpen] = React.useState(false);

    const hasCustom = !!rightCustom;

    const {api} = useCanvasOwned(initialProps, undefined, {serviceMap});

    return (
        <CanvasProvider api={api}>
            <div className={cn('relative h-[100vh] w-[100vw] bg---color-destructive', className)}>
                {/*Mobile top bar (drawer trigger + toolbar addons)*/}
                <div className="flex items-center gap-2 px-2 py-2 border-b md:hidden">
                    <Drawer open={isLeftDrawerOpen} onOpenChange={setLeftDrawerOpen}>
                        <DrawerTrigger asChild>
                            <Button variant="outline" size="sm">Panels</Button>
                        </DrawerTrigger>
                        <DrawerContent className="h-[85vh]">
                            <DrawerHeader className="pb-2">
                                <DrawerTitle>Workspace panels</DrawerTitle>
                            </DrawerHeader>
                            <div className="px-2 pb-2"><Separator/></div>
                            <div className="px-3 pb-6 overflow-auto h-full">
                                <StructurePanel/>
                            </div>
                            <div className="px-3 pb-3 flex justify-end">
                                <DrawerClose asChild><Button variant="secondary">Close</Button></DrawerClose>
                            </div>
                        </DrawerContent>
                    </Drawer>
                    <div className="flex-1"/>
                    {canvasToolbarAddon ? <div className="flex items-center gap-2">{canvasToolbarAddon}</div> : null}
                </div>

                {/* Main resizable layout */}
                <ResizablePanelGroup direction="horizontal" className="h-[calc(100%-0px)]">
                    {/* LEFT (built-in) */}
                    <ResizablePanel
                        defaultSize={initialSizes.left}
                        minSize={minSizes.left}
                        className={cn('hidden md:flex flex-col overflow-hidden border-r', leftClassName)}
                    >
                        <div className="flex items-center justify-between px-3 py-2 border-b">
                            <div className="text-sm font-medium">Structure</div>
                        </div>
                        <div className="h-full overflow-auto">
                            {/*<StructurePanel/>*/}
                            <LeftPanel/>
                        </div>
                    </ResizablePanel>

                    <ResizableHandle className="hidden md:flex"/>

                    {/* MIDDLE (built-in canvas) */}
                    <ResizablePanel defaultSize={initialSizes.middle} className={cn('flex flex-col', canvasClassName)}>
                        {/* Desktop toolbar row */}
                        {canvasToolbarAddon ? (
                            <div className="hidden md:flex items-center gap-2 px-3 py-2 border-b">
                                {canvasToolbarAddon}
                            </div>
                        ) : null}

                        <div className="relative flex-1 overflow-hidden">
                            {/* Canvas fills the space */}
                            <div className="absolute inset-0">
                                <FlowCanvas/>
                            </div>

                            {/* Optional overlay slot inside canvas */}
                            {canvasOverlayAddon ? (
                                <div className="absolute bottom-3 right-3 z-10">{canvasOverlayAddon}</div>
                            ) : null}
                        </div>
                    </ResizablePanel>

                    {showRight && (
                        <>
                            <ResizableHandle className="hidden md:flex"/>
                            {/* RIGHT (built-in tabs: Comments + optional Custom) */}
                            <ResizablePanel
                                defaultSize={initialSizes.right}
                                minSize={minSizes.right}
                                className={cn('hidden md:flex flex-col overflow-hidden border-l', rightClassName)}
                            >
                                <Tabs value={rightTab} onValueChange={(v: any) => setRightTab(v as any)}
                                      className="flex-1 flex flex-col">
                                    <div className="px-3 pt-2 border-b">
                                        <TabsList>
                                            <TabsTrigger value="comments">Comments</TabsTrigger>
                                            {hasCustom && <TabsTrigger value="custom">Custom</TabsTrigger>}
                                        </TabsList>
                                    </div>
                                    <div className="flex-1 overflow-auto">
                                        <TabsContent value="comments" className="m-0">
                                            <CommentsPanel/>
                                        </TabsContent>
                                        {hasCustom && (
                                            <TabsContent value="custom" className="m-0">
                                                {rightCustom}
                                            </TabsContent>
                                        )}
                                    </div>
                                </Tabs>
                            </ResizablePanel>
                        </>
                    )}
                </ResizablePanelGroup>
            </div>
        </CanvasProvider>
    );
}