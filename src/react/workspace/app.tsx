// src/react/workspace/app.tsx
import * as React from "react";

import { WorkspaceProvider } from "./context";
import type { WorkspaceProviderProps } from "./context";
import type { Actor, WorkspaceBackend } from "./context/backend";

import type { ToolsConfig } from "../adapters/reactflow";
import { CanvasProvider } from "./context/context";

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

    /** Optional live adapter registry (ws/sse/custom). */
    readonly liveAdapters?: WorkspaceProviderProps["liveAdapters"];

    /** Debounce refresh ticks (WS bursts etc). */
    readonly liveDebounceMs?: WorkspaceProviderProps["liveDebounceMs"];

    /** Autosave debounce window in ms (default 9000) */
    readonly autosaveMs?: WorkspaceProviderProps["autosaveMs"];

    /** Auto-run autosave when dirty (default true) */
    readonly autoAutosave?: WorkspaceProviderProps["autoAutosave"];

    readonly tools?: ToolsConfig;
    readonly children: (tools?: ToolsConfig) => React.ReactNode;
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
        liveAdapters,
        liveDebounceMs,
        autosaveMs,
        autoAutosave,
        tools,
        children,
    } = props;

    return (
        <WorkspaceProvider
            backend={backend}
            actor={actor}
            initial={initial}
            ensureMain={ensureMain}
            live={live}
            liveAdapters={liveAdapters}
            liveDebounceMs={liveDebounceMs}
            autosaveMs={autosaveMs}
            autoAutosave={autoAutosave}
        >
            <CanvasProvider>{children(tools)}</CanvasProvider>
        </WorkspaceProvider>
    );
}

export default Workspace;
