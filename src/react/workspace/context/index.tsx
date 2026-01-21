// src/react/workspace/context/index.ts

export {
    WorkspaceContext,
    useWorkspace,
    useWorkspaceMaybe,
} from "./provider/context";

export { WorkspaceProvider } from "./provider/provider";

export type {
    WorkspaceAPI,
    WorkspaceProviderProps,
    Loadable,
    SnapshotSlice,
    BranchesSlice,
} from "./provider/types";

/**
 * Live adapter contracts — exposed so the host can implement custom adapters
 * (Echo, native WebSocket, SSE, custom protocols).
 */
export type {
    WorkspaceLiveAdapter,
    WorkspaceLiveAdapterContext,
    WorkspaceLiveAdapterRegistry,
    WorkspaceLiveAdapterHandlers,
    WorkspaceLiveStatus,
    WorkspaceLiveTick,
} from "./provider/live/types";

/**
 * Default poll adapter — hosts may use this or provide their own ws/sse adapters.
 */
export { createPollAdapter } from "./provider/live/adapters/poll";
