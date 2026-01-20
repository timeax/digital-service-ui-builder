// src/react/workspace/context/provider/compose/use-workspace-refresh.ts
import * as React from "react";
import type { RunResult } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";

export interface WorkspaceRefreshApi {
    readonly refreshAll: (opts?: { strict?: boolean }) => Promise<RunResult>;

    // NOTE: still callable as refreshBranchContext() — we just allow optional params.
    readonly refreshBranchContext: (
        opts?: Readonly<{
            branchId?: string;

            /**
             * When true, errors stop the chain (same meaning as refreshAll strict).
             * Defaults to false (tolerant).
             */
            strict?: boolean;

            /**
             * Include workspace-scoped refreshes that are often “branch-relevant” in practice
             * (services, permissions, authors). Defaults to true.
             */
            includeWorkspaceData?: boolean;
        }>,
    ) => Promise<void>;

    // NOTE: still callable as refreshSnapshotPointers() — optional params allowed.
    readonly refreshSnapshotPointers: (
        opts?: Readonly<{
            branchId?: string;
            strict?: boolean;
        }>,
    ) => Promise<void>;
}

export interface UseWorkspaceRefreshParams {
    readonly runtime: BackendRuntime;

    readonly refreshAuthors: () => Promise<void>;
    readonly refreshPermissions: () => Promise<void>;
    readonly refreshBranches: () => Promise<void>;
    readonly refreshServices: () => Promise<void>;

    readonly getCurrentBranchId: () => string | undefined;

    readonly refreshTemplates: (
        params?: Partial<{ branchId: string }>,
    ) => Promise<void>;
    readonly refreshParticipants: (
        params?: Partial<{ branchId: string }>,
    ) => Promise<void>;

    readonly refreshSnapshotPointersForBranch: (
        branchId: string,
    ) => Promise<void>;
    readonly refreshSnapshotPointers: () => Promise<void>;
}

export function useWorkspaceRefresh(
    params: UseWorkspaceRefreshParams,
): WorkspaceRefreshApi {
    const {
        runtime,
        refreshAuthors,
        refreshPermissions,
        refreshBranches,
        refreshServices,
        getCurrentBranchId,
        refreshTemplates,
        refreshParticipants,
        refreshSnapshotPointersForBranch,
        refreshSnapshotPointers,
    } = params;

    const refreshBranchLocalContext = React.useCallback(
        async (branchId: string, tolerant: boolean): Promise<RunResult> => {
            return runtime.runTasks(
                [
                    () => refreshParticipants({ branchId }),
                    () => refreshTemplates({ branchId }),
                    () => refreshSnapshotPointersForBranch(branchId),
                ],
                tolerant,
            );
        },
        [
            runtime,
            refreshParticipants,
            refreshTemplates,
            refreshSnapshotPointersForBranch,
        ],
    );

    const refreshBranchContext = React.useCallback(
        async (
            opts?: Readonly<{
                branchId?: string;
                strict?: boolean;
                includeWorkspaceData?: boolean;
            }>,
        ): Promise<void> => {
            const branchId: string | undefined =
                opts?.branchId ?? getCurrentBranchId();

            if (!branchId) return;

            const tolerant: boolean = !(opts?.strict ?? false);
            const includeWorkspaceData: boolean =
                opts?.includeWorkspaceData ?? true;

            // The “practical” expectation: branch refresh should refresh branch-local data
            // AND other workspace data that impacts the branch experience.
            // (Services, authors/permissions often impact what a branch can do/render.)
            const tasks: Array<() => Promise<unknown>> = [];

            if (includeWorkspaceData) {
                tasks.push(() => refreshAuthors());
                tasks.push(() => refreshPermissions());
                tasks.push(() => refreshServices());
            }

            tasks.push(() => refreshBranchLocalContext(branchId, tolerant));

            await runtime.runTasks(tasks, tolerant);
        },
        [
            getCurrentBranchId,
            runtime,
            refreshAuthors,
            refreshPermissions,
            refreshServices,
            refreshBranchLocalContext,
        ],
    );

    const refreshAll = React.useCallback(
        async (opts?: { strict?: boolean }): Promise<RunResult> => {
            const tolerant: boolean = !(opts?.strict ?? false);

            // Avoid duplicate workspace refresh work:
            // refreshAll() does workspace-wide first, then branch-local only.
            const branchId: string | undefined = getCurrentBranchId();

            const tasks: Array<() => Promise<unknown>> = [
                () => refreshAuthors(),
                () => refreshPermissions(),
                () => refreshBranches(),
                () => refreshServices(),
            ];

            if (branchId) {
                tasks.push(() => refreshBranchLocalContext(branchId, tolerant));
            }

            return runtime.runTasks(tasks, tolerant);
        },
        [
            runtime,
            refreshAuthors,
            refreshPermissions,
            refreshBranches,
            refreshServices,
            getCurrentBranchId,
            refreshBranchLocalContext,
        ],
    );

    const refreshSnapshotPointersWrapped = React.useCallback(
        async (
            opts?: Readonly<{ branchId?: string; strict?: boolean }>,
        ): Promise<void> => {
            const tolerant: boolean = !(opts?.strict ?? false);

            if (opts?.branchId) {
                await runtime.runTasks(
                    [
                        () =>
                            refreshSnapshotPointersForBranch(
                                opts.branchId as string,
                            ),
                    ],
                    tolerant,
                );
                return;
            }

            await runtime.runTasks([() => refreshSnapshotPointers()], tolerant);
        },
        [runtime, refreshSnapshotPointers, refreshSnapshotPointersForBranch],
    );

    return React.useMemo<WorkspaceRefreshApi>(
        () => ({
            refreshAll,
            refreshBranchContext,
            refreshSnapshotPointers: refreshSnapshotPointersWrapped,
        }),
        [refreshAll, refreshBranchContext, refreshSnapshotPointersWrapped],
    );
}
