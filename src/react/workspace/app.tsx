import * as React from "react";

import { WorkspaceLayout } from "@/layout/workspace-layout";
import { LeftPanelProvider } from "@/layout/left-panel-context";
import { BottomBarProvider } from "@/layout/bottom-bar-context";
import { WorkspaceProvider } from "./context";
import type { WorkspaceProviderProps } from "./context";
import type { Actor, WorkspaceBackend } from "./context/backend";
import { LeftPanel } from "@/panels/left-panel";

/**
 * Props for the Workspace wrapper. Mirrors WorkspaceProvider options.
 */
export interface WorkspaceProps<
    TData extends object = Record<string, unknown>,
> {
    readonly backend: WorkspaceBackend<TData>;
    readonly workspaceId: string;
    readonly actor: Actor;

    /** Optional pre-hydration to avoid blank first paint */
    readonly initial?: WorkspaceProviderProps<TData>["initial"];

    /** Ensure a 'main' branch exists; otherwise first branch is used (default true) */
    readonly ensureMain?: WorkspaceProviderProps<TData>["ensureMain"];

    /** Live refresh mode (poll/SSE/WS/off). Defaults to off. */
    readonly live?: WorkspaceProviderProps<TData>["live"];

    /** Autosave debounce window in ms (default 9000) */
    readonly autosaveMs?: WorkspaceProviderProps<TData>["autosaveMs"];

    /** Auto-run autosave when dirty (default true) */
    readonly autoAutosave?: WorkspaceProviderProps<TData>["autoAutosave"];
}

/**
 * Workspace: wraps app panels with WorkspaceProvider.
 * Accepts the same inputs as WorkspaceProvider and passes them through.
 */
export function Workspace<TData extends object = Record<string, unknown>>(
    props: WorkspaceProps<TData>,
): React.JSX.Element {
    const {
        backend,
        workspaceId,
        actor,
        initial,
        ensureMain,
        live,
        autosaveMs,
        autoAutosave,
    } = props;

    return (
        <WorkspaceProvider<TData>
            backend={backend}
            workspaceId={workspaceId}
            actor={actor}
            initial={initial}
            ensureMain={ensureMain}
            live={live}
            autosaveMs={autosaveMs}
            autoAutosave={autoAutosave}
        >
            <BottomBarProvider>
                <LeftPanelProvider>
                    <WorkspaceLayout>
                        <div>
                            <LeftPanel />
                        </div>
                        <div>Workspace Middle</div>
                        <div>Workspace Right</div>
                        <div>Workspace Bottom</div>
                    </WorkspaceLayout>
                </LeftPanelProvider>
            </BottomBarProvider>
        </WorkspaceProvider>
    );
}

export default Workspace;
