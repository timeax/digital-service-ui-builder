// src/react/workspace/context/provider/runtime/use-backend-runtime.ts
import * as React from "react";
import type { BackendError } from "../../backend";
import type { RunResult } from "../types";
import {
    runTasks as runTasksBase,
    toBackendError as toBackendErrorBase,
} from "../helpers";

export interface BackendRuntime {
    readonly now: () => number;
    readonly toBackendError: (e: unknown) => BackendError;
    readonly runTasks: (
        tasks: Array<() => Promise<unknown>>,
        tolerant: boolean,
    ) => Promise<RunResult>;
}

export function useBackendRuntime(): BackendRuntime {
    const now = React.useCallback((): number => Date.now(), []);

    const toBackendError = React.useCallback(
        (e: unknown): BackendError => toBackendErrorBase(e),
        [],
    );

    const runTasks = React.useCallback(
        async (
            tasks: Array<() => Promise<unknown>>,
            tolerant: boolean,
        ): Promise<RunResult> => runTasksBase(tasks, tolerant),
        [],
    );

    return React.useMemo<BackendRuntime>(
        () => ({ now, toBackendError, runTasks }),
        [now, toBackendError, runTasks],
    );
}
