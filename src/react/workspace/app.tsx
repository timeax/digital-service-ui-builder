// src/react/workspace/app.tsx
import * as React from "react";

import { WorkspaceLayout } from "@/layout/workspace-layout";
import { LeftPanelProvider } from "@/layout/left-panel-context";
import { BottomBarProvider } from "@/layout/bottom-bar-context";
import { WorkspaceProvider } from "./context";
import type { WorkspaceProviderProps } from "./context";
import type { Actor, WorkspaceBackend } from "./context/backend";
import { LeftPanel } from "@/panels/left-panel";
import FlowCanvas, { type ToolsConfig } from "../adapters/reactflow";
import { CanvasProvider } from "@/context/context";

/**
 * Props for the Workspace wrapper. Mirrors WorkspaceProvider options.
 */
export interface WorkspaceProps {
    readonly backend: WorkspaceBackend;
    readonly actor: Actor;

    /** Optional pre-hydration to avoid blank first paint */
    readonly initial?: WorkspaceProviderProps["initial"];

    /** Ensure a 'main' branch exists; otherwise first branch is used (default true) */
    readonly ensureMain?: WorkspaceProviderProps["ensureMain"];

    /** Live refresh mode (poll/SSE/WS/off). Defaults to off. */
    readonly live?: WorkspaceProviderProps["live"];

    /** Autosave debounce window in ms (default 9000) */
    readonly autosaveMs?: WorkspaceProviderProps["autosaveMs"];

    /** Auto-run autosave when dirty (default true) */
    readonly autoAutosave?: WorkspaceProviderProps["autoAutosave"];
    readonly tools?: ToolsConfig;
}

/**
 * Workspace: wraps app panels with WorkspaceProvider.
 * Accepts the same inputs as WorkspaceProvider and passes them through.
 */
export function Workspace(props: WorkspaceProps): React.JSX.Element {
    const {
        backend,
        actor,
        initial,
        ensureMain,
        live,
        autosaveMs,
        autoAutosave,
        tools,
    } = props;

    return (
        <WorkspaceProvider
            backend={backend}
            actor={actor}
            initial={initial}
            ensureMain={ensureMain}
            live={live}
            autosaveMs={autosaveMs}
            autoAutosave={autoAutosave}
        >
            <CanvasProvider>
                <BottomBarProvider>
                    <LeftPanelProvider>
                        <WorkspaceLayout>
                            <LeftPanel />
                            <FlowCanvas tools={tools ?? {}} showToolbar />
                            <div>Workspace Right</div>
                            <div>Workspace Bottom</div>
                        </WorkspaceLayout>
                    </LeftPanelProvider>
                </BottomBarProvider>
            </CanvasProvider>
        </WorkspaceProvider>
    );
}

export default Workspace;
