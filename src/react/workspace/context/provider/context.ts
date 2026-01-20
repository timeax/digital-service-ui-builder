// src/react/workspace/context/provider/context.ts
import * as React from "react";
import type { WorkspaceAPI } from "./types";

export const WorkspaceContext = React.createContext<WorkspaceAPI | null>(null);

export function useWorkspace(): WorkspaceAPI {
    const ctx = React.useContext(WorkspaceContext);
    if (!ctx) {
        throw new Error(
            "useWorkspace() must be used under <WorkspaceProvider/>",
        );
    }
    return ctx;
}

export function useWorkspaceMaybe(): WorkspaceAPI | null {
    return React.useContext(WorkspaceContext);
}
