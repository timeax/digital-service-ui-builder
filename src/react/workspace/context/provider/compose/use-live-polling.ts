// src/react/workspace/context/provider/compose/use-live-polling.ts
import * as React from "react";
import type { Actor, BackendError, LiveOptions } from "../../backend";
import type { RunResult } from "../types";
import type {
    WorkspaceLiveAdapter,
    WorkspaceLiveAdapterContext,
    WorkspaceLiveAdapterRegistry,
    WorkspaceLiveStatus,
    WorkspaceLiveTick,
} from "../live/types";
import { createPollAdapter } from "../live/adapters/poll";

export interface LiveControl {
    readonly connected: boolean;
    readonly lastEventAt?: number;
    readonly lastError?: BackendError;
    readonly connect: () => void;
    readonly disconnect: () => void;
}

export interface UseLivePollingParams {
    readonly live: LiveOptions;
    readonly workspaceId: string;
    readonly actor: Actor;

    readonly hasAnyData: boolean;

    readonly getCurrentBranchId: () => string | undefined;

    readonly refreshAll: (opts?: { strict?: boolean }) => Promise<RunResult>;
    readonly refreshBranchContext?: () => Promise<void>;
    readonly refreshSnapshotPointers?: () => Promise<void>;

    /**
     * Host can provide adapters for modes like "ws" / "sse"
     * (and even custom strings later).
     */
    readonly adapters?: WorkspaceLiveAdapterRegistry;

    /**
     * Simple debounce to avoid refresh storms (WS bursts etc).
     * Default: 250ms
     */
    readonly debounceMs?: number;
}

function toError(e: unknown): BackendError {
    if (
        typeof e === "object" &&
        e &&
        "code" in (e as Record<string, unknown>) &&
        "message" in (e as Record<string, unknown>)
    ) {
        return e as BackendError;
    }
    if (e instanceof Error) {
        return { code: "runtime_error", message: `${e.name}: ${e.message}` };
    }
    return { code: "unknown_error", message: String(e ?? "Unknown error") };
}

export function useLivePolling(params: UseLivePollingParams): LiveControl {
    const {
        live,
        workspaceId,
        actor,
        hasAnyData,
        getCurrentBranchId,
        refreshAll,
        refreshBranchContext,
        refreshSnapshotPointers,
        adapters,
        debounceMs,
    } = params;

    const [status, setStatus] = React.useState<WorkspaceLiveStatus>(() => ({
        connected: false,
    }));

    const adapterRef = React.useRef<WorkspaceLiveAdapter | null>(null);
    const inflightRef = React.useRef<boolean>(false);
    const debounceTimerRef = React.useRef<number | null>(null);
    const lastTickRef = React.useRef<WorkspaceLiveTick | null>(null);

    const debounceWindowMs: number = debounceMs ?? 250;

    const disconnect = React.useCallback((): void => {
        if (debounceTimerRef.current != null) {
            window.clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        adapterRef.current?.disconnect();
        adapterRef.current = null;
        inflightRef.current = false;
        lastTickRef.current = null;
        setStatus({ connected: false });
    }, []);

    const resolveAdapter =
        React.useCallback((): WorkspaceLiveAdapter | null => {
            if (live.mode === "off") return null;

            if (live.mode === "poll") {
                return createPollAdapter({ defaultIntervalMs: 15000 });
            }

            // ws/sse (or future modes) must be provided by host registry
            const reg: WorkspaceLiveAdapterRegistry | undefined = adapters;
            const factory = reg ? reg[live.mode] : undefined;

            return factory ? factory() : null;
        }, [live.mode, adapters]);

    const ctx = React.useMemo<WorkspaceLiveAdapterContext>(
        () => ({
            workspaceId,
            actorId: actor.id,
            live,
            getCurrentBranchId,
            refreshAll,
            refreshBranchContext,
            refreshSnapshotPointers,
        }),
        [
            workspaceId,
            actor.id,
            live,
            getCurrentBranchId,
            refreshAll,
            refreshBranchContext,
            refreshSnapshotPointers,
        ],
    );

    const scheduleRefresh = React.useCallback(
        (tick: WorkspaceLiveTick): void => {
            lastTickRef.current = tick;

            if (debounceTimerRef.current != null) {
                window.clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }

            debounceTimerRef.current = window.setTimeout(() => {
                debounceTimerRef.current = null;

                if (inflightRef.current) return;
                inflightRef.current = true;

                void (async () => {
                    try {
                        const res: RunResult = await refreshAll({
                            strict: false,
                        });

                        if (!res.ok) {
                            setStatus((s) => ({
                                ...s,
                                connected: true,
                                lastEventAt: tick.at,
                                lastError: res.errors[0],
                            }));
                        } else {
                            setStatus((s) => ({
                                ...s,
                                connected: true,
                                lastEventAt: tick.at,
                                lastError: undefined,
                            }));
                        }
                    } catch (e: unknown) {
                        setStatus((s) => ({
                            ...s,
                            connected: true,
                            lastEventAt: tick.at,
                            lastError: toError(e),
                        }));
                    } finally {
                        inflightRef.current = false;
                    }
                })();
            }, debounceWindowMs) as unknown as number;
        },
        [refreshAll, debounceWindowMs],
    );

    const connect = React.useCallback((): void => {
        // idempotent: disconnect current first
        disconnect();

        if (live.mode === "off") {
            setStatus({ connected: false });

            // parity with old behavior: if nothing loaded yet, do an initial refresh
            if (!hasAnyData) {
                void (async () => {
                    await refreshAll({ strict: false });
                })();
            }

            return;
        }

        const adapter: WorkspaceLiveAdapter | null = resolveAdapter();

        if (!adapter) {
            setStatus({
                connected: false,
                lastError: {
                    code: "live_adapter_missing",
                    message: `No live adapter registered for mode "${live.mode}".`,
                },
            });
            return;
        }

        adapterRef.current = adapter;

        void Promise.resolve(
            adapter.connect(ctx, {
                onTick: (tick: WorkspaceLiveTick) => {
                    // treat any tick as “refresh now”
                    scheduleRefresh(tick);
                },
                onStatus: (s: WorkspaceLiveStatus) => {
                    setStatus((prev) => ({
                        ...prev,
                        ...s,
                    }));
                },
            }),
        ).catch((e: unknown) => {
            setStatus({
                connected: false,
                lastError: toError(e),
            });
        });
    }, [
        disconnect,
        live.mode,
        hasAnyData,
        refreshAll,
        resolveAdapter,
        ctx,
        scheduleRefresh,
    ]);

    // Auto-connect/disconnect based on (workspaceId + live.mode + key options)
    const liveKey: string = React.useMemo(() => {
        if (live.mode === "poll") return `poll:${live.intervalMs ?? 15000}`;
        if (live.mode === "ws") return `ws:${live.url}`;
        if (live.mode === "sse") return `sse:${live.url}`;
        return String(live.mode);
    }, [live]);

    React.useEffect(() => {
        connect();
        return () => disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceId, liveKey]);

    return React.useMemo<LiveControl>(
        () => ({
            connected: status.connected,
            lastEventAt: status.lastEventAt,
            lastError: status.lastError,
            connect,
            disconnect,
        }),
        [
            status.connected,
            status.lastEventAt,
            status.lastError,
            connect,
            disconnect,
        ],
    );
}
