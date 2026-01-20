// src/react/workspace/context/provider/live/adapters/poll.ts
import type { LiveOptions } from "../../../backend";
import type {
    WorkspaceLiveAdapter,
    WorkspaceLiveAdapterContext,
    WorkspaceLiveAdapterHandlers,
    WorkspaceLiveStatus,
    WorkspaceLiveTick,
} from "../types";

export interface PollAdapterOptions {
    readonly defaultIntervalMs: number; // e.g. 15000
}

export function createPollAdapter(
    opts?: Partial<PollAdapterOptions>,
): WorkspaceLiveAdapter {
    const defaultIntervalMs: number = opts?.defaultIntervalMs ?? 15000;

    let intervalId: number | undefined;
    let connected: boolean = false;

    const disconnect = (): void => {
        if (typeof intervalId === "number") {
            window.clearInterval(intervalId);
        }
        intervalId = undefined;
        connected = false;
    };

    const connect = async (
        ctx: WorkspaceLiveAdapterContext,
        handlers: WorkspaceLiveAdapterHandlers,
    ): Promise<void> => {
        disconnect();

        const live: LiveOptions = ctx.live;

        if (live.mode !== "poll") {
            handlers.onStatus({ connected: false } as WorkspaceLiveStatus);
            return;
        }

        const intervalMs: number = live.intervalMs ?? defaultIntervalMs;

        connected = true;
        handlers.onStatus({ connected: true } as WorkspaceLiveStatus);

        const tickOnce = async (
            reason: WorkspaceLiveTick["reason"],
        ): Promise<void> => {
            const tick: WorkspaceLiveTick = {
                at: Date.now(),
                reason,
            };
            handlers.onTick(tick);
        };

        // immediate tick
        await tickOnce("init");

        intervalId = window.setInterval(() => {
            void tickOnce("timer");
        }, intervalMs) as unknown as number;
    };

    return {
        id: "poll",
        connect,
        disconnect,
    };
}
