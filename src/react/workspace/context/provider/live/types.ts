// src/react/workspace/context/provider/live/types.ts
import type { BackendError, LiveOptions } from "../../backend";
import type { RunResult } from "../types";

/**
 * The “tick” is the only thing the adapter *must* emit.
 * You can treat any WS/SSE message as a tick initially,
 * and later introduce selective refresh events.
 */
export interface WorkspaceLiveTick {
    readonly at: number;
    readonly reason:
        | "init"
        | "timer"
        | "message"
        | "manual"
        | "reconnect"
        | "unknown";
}

export interface WorkspaceLiveStatus {
    readonly connected: boolean;
    readonly lastEventAt?: number;
    readonly lastError?: BackendError;
}

export interface WorkspaceLiveAdapterContext {
    readonly workspaceId: string;
    readonly actorId: string;

    readonly live: LiveOptions;

    /** current branch (if any) */
    readonly getCurrentBranchId: () => string | undefined;

    /**
     * “What to do” is owned by the provider (refresh semantics).
     * “When to do it” is owned by the adapter (poll/ws/sse/etc).
     */
    readonly refreshAll: (opts?: { strict?: boolean }) => Promise<RunResult>;

    /** Optional: adapters can use these for lighter refresh policies later */
    readonly refreshBranchContext?: () => Promise<void>;
    readonly refreshSnapshotPointers?: () => Promise<void>;
}

export interface WorkspaceLiveAdapterHandlers {
    readonly onTick: (tick: WorkspaceLiveTick) => void;
    readonly onStatus: (status: WorkspaceLiveStatus) => void;
}

export interface WorkspaceLiveAdapter {
    /** A stable id (e.g. "poll", "ws", "sse") */
    readonly id: string;

    connect(
        ctx: WorkspaceLiveAdapterContext,
        handlers: WorkspaceLiveAdapterHandlers,
    ): void | Promise<void>;

    disconnect(): void;

    /**
     * Optional: allow branch changes / live option changes without reconnect.
     * If not implemented, the runner will disconnect+connect when key changes.
     */
    update?(ctx: WorkspaceLiveAdapterContext): void;
}

export type WorkspaceLiveAdapterFactory = () => WorkspaceLiveAdapter;

export type WorkspaceLiveAdapterRegistry = Readonly<
    Record<string, WorkspaceLiveAdapterFactory>
>;
