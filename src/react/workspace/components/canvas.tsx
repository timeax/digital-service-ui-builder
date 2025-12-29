// src/react/adapters/reactflow/ReactFlowCanvas.tsx
import React, { useMemo, useState } from "react";
import ReactFlow, {
    Background,
    ConnectionMode,
    MiniMap,
} from "reactflow";
import "reactflow/dist/style.css";

import {
    type AdapterOptions,
    useReactFlowAdapter,
} from "../../adapters/reactflow/adapter";
import type { CanvasAPI } from "../../canvas/api";
import { Toolbar } from "../../adapters/reactflow/Toolbar";
import type { LabelPlacement, ToolsConfig } from "../../adapters/reactflow";
import { edgeTypes, nodeTypes } from "@/components/reactflow";

export type ReactFlowCanvasProps = {
    api: CanvasAPI;
    options?: AdapterOptions;

    showToolbar?: boolean;
    tools?: ToolsConfig;
    labelPlacement?: LabelPlacement;
    renderTool?: Parameters<typeof Toolbar>[0]["renderButton"];

    initialShowGrid?: boolean;
    initialShowMiniMap?: boolean;

    /** absolute position classes relative to the ReactFlow canvas */
    toolbarPositionClassName?: string; // e.g. "left-2 top-2"
};

export function Canvas({
    api,
    options,
    showToolbar = true,
    tools,
    labelPlacement = "tooltip",
    renderTool,
    initialShowGrid = true,
    initialShowMiniMap = false,
    toolbarPositionClassName = "left-2 top-2",
}: ReactFlowCanvasProps) {
    const [showGrid, setShowGrid] = useState(initialShowGrid);
    const [showMiniMap, setShowMiniMap] = useState(initialShowMiniMap);

    const {
        nodes,
        edges,
        onNodesChange,
        onEdgesChange,
        onConnect,
        onConnectStart,
        onConnectEnd,
        onMoveEnd,
        onSelectionChange,
        isValidConnection,
        snapVector,
    } = useReactFlowAdapter(api, options);

    const snapToGrid = useMemo(
        () => !!options?.snapToGrid,
        [options?.snapToGrid],
    );
    const snapGrid = useMemo<[number, number] | undefined>(
        () => snapVector,
        [snapVector],
    );

    return (
        <div className="relative h-full w-full bg-gray-50">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                connectionMode={ConnectionMode.Loose}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnectStart={onConnectStart}
                onConnectEnd={onConnectEnd}
                onConnect={onConnect}
                onMoveEnd={onMoveEnd}
                onSelectionChange={onSelectionChange}
                isValidConnection={isValidConnection}
                fitView
                snapToGrid={snapToGrid}
                snapGrid={snapGrid}
            >
                {/* toolbar inside ReactFlow so useReactFlow() works */}
                {showToolbar && (
                    <div
                        className={`pointer-events-none absolute z-10 ${toolbarPositionClassName}`}
                    >
                        <Toolbar
                            api={api}
                            mode="dev"
                            showGrid={showGrid}
                            setShowGrid={setShowGrid}
                            showMiniMap={showMiniMap}
                            setShowMiniMap={setShowMiniMap}
                            tools={tools}
                            labelPlacement={labelPlacement}
                            renderButton={renderTool}
                        />
                    </div>
                )}

                {showMiniMap && <MiniMap />}
                {showGrid && <Background />}
            </ReactFlow>
        </div>
    );
}
