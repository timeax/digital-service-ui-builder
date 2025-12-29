// src/react/adapters/reactflow/index.tsx
import React from "react";
import { Canvas } from "@/components/canvas";
import { useCanvasAPI } from "@/context/context";
import type { AdapterOptions } from "./adapter";
import type { ToolsConfig, LabelPlacement } from "./toolbar/types";

export type FlowCanvasProps = {
    tools?: ToolsConfig;
    /** 'dev' enables richer UX; 'prod' can hide some helpers */
    mode?: "dev" | "prod";
    /** Show/position the toolbar (inside the ReactFlow surface) */
    showToolbar?: boolean;
    toolbarPositionClassName?: string; // e.g. "left-2 top-2"

    /** How labels render on buttons: tooltip | inline | below | none */
    labelPlacement?: LabelPlacement;

    /** Pass custom renderer for individual tool buttons */
    renderTool?: React.ComponentProps<typeof Canvas>["renderTool"];

    /** Initial layer toggles */
    initialShowGrid?: boolean;
    initialShowMiniMap?: boolean;

    /** Adapter options (snapping etc.) */
    options?: AdapterOptions;
};

const FlowCanvas: React.FC<FlowCanvasProps> = ({
    tools,
    showToolbar = true,
    toolbarPositionClassName,
    labelPlacement = "tooltip",
    renderTool,
    initialShowGrid = true,
    initialShowMiniMap = false,
    options,
}) => {
    const api = useCanvasAPI();

    return (
        <Canvas
            api={api}
            tools={tools}
            showToolbar={showToolbar}
            toolbarPositionClassName={toolbarPositionClassName}
            labelPlacement={labelPlacement}
            renderTool={renderTool}
            initialShowGrid={initialShowGrid}
            initialShowMiniMap={initialShowMiniMap}
            options={options}
        />
    );
};

export default FlowCanvas;

// Optional convenience re-exports
export { Canvas };
export type { ToolsConfig, LabelPlacement, AdapterOptions };
