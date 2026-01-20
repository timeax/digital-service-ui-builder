// src/react/workspace/context/provider/slices/use-branches-slice.ts
import * as React from "react";
import type {
    BackendError,
    Branch,
    BranchParticipant,
    WorkspaceBackend,
} from "../../backend";
import type { BranchesSlice, Loadable } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";

export interface BranchesSliceApi {
    readonly branches: BranchesSlice;
    readonly participants: Loadable<readonly BranchParticipant[]>;

    readonly setCurrentBranchId: (id: string) => void;

    readonly refreshBranches: () => Promise<void>;
    readonly refreshParticipants: (
        params?: Partial<{ branchId: string; since?: number | string }>,
    ) => Promise<void>;

    readonly invalidateBranches: () => void;
    readonly invalidateParticipants: () => void;

    /** internal setters for branch-cache composition */
    readonly __setParticipantsState: React.Dispatch<
        React.SetStateAction<Loadable<readonly BranchParticipant[]>>
    >;
}

function setLoadableError<T>(
    updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
    error: BackendError,
): void {
    updater((s) => ({ ...s, loading: false, error }));
}

export interface UseBranchesSliceParams {
    readonly backend: WorkspaceBackend;
    readonly workspaceId: string;

    readonly ensureMain: boolean;

    readonly initialBranches?: readonly Branch[];
    readonly initialMainId?: string;
    readonly initialCurrentId?: string;
    readonly initialParticipants?: readonly BranchParticipant[] | null;

    readonly runtime: BackendRuntime;
}

export function useBranchesSlice(
    params: UseBranchesSliceParams,
): BranchesSliceApi {
    const {
        backend,
        workspaceId,
        ensureMain,
        initialBranches,
        initialMainId,
        initialCurrentId,
        initialParticipants,
        runtime,
    } = params;

    const [branches, setBranches] = React.useState<BranchesSlice>({
        data: initialBranches ?? [],
        mainId: initialMainId,
        currentId: initialCurrentId ?? initialMainId,
        loading: false,
        updatedAt: initialBranches ? runtime.now() : undefined,
    });

    const [participants, setParticipants] = React.useState<
        Loadable<readonly BranchParticipant[]>
    >({
        data: initialParticipants ?? null,
        loading: false,
        updatedAt: initialParticipants ? runtime.now() : undefined,
    });

    // Ensure main branch pointer is stable (same behavior as old provider)
    React.useEffect((): void => {
        if (!ensureMain) return;
        if (branches.data.length === 0) return;

        const existingMain: string | undefined = branches.data.find(
            (b) => b.isMain,
        )?.id;

        if (existingMain && branches.mainId !== existingMain) {
            setBranches((s) => ({
                ...s,
                mainId: existingMain,
                currentId: s.currentId ?? existingMain,
            }));
            return;
        }

        if (!existingMain) {
            const first: string | undefined = branches.data[0]?.id;
            if (first && !branches.currentId) {
                setBranches((s) => ({ ...s, currentId: first }));
            }
        }
    }, [branches.data, branches.mainId, branches.currentId, ensureMain]);

    const setCurrentBranchId = React.useCallback((id: string): void => {
        setBranches((s) => ({ ...s, currentId: id }));
    }, []);

    const refreshBranches = React.useCallback(async (): Promise<void> => {
        setBranches((s) => ({ ...s, loading: true }));
        const res = await backend.branches.refresh(workspaceId);

        if (!res.ok) {
            setBranches((s) => ({ ...s, loading: false, error: res.error }));
            return;
        }

        const data: readonly Branch[] = res.value;
        const main: string | undefined = data.find((b) => b.isMain)?.id;

        setBranches((s) => {
            const currentStillExists: boolean =
                Boolean(s.currentId) && data.some((b) => b.id === s.currentId);

            const nextCurrent: string | undefined = currentStillExists
                ? s.currentId
                : (main ?? data[0]?.id);

            return {
                data,
                mainId: main ?? s.mainId,
                currentId: nextCurrent,
                loading: false,
                updatedAt: runtime.now(),
            };
        });
    }, [backend.branches, workspaceId, runtime]);

    const refreshParticipants = React.useCallback(
        async (
            params?: Partial<{ branchId: string; since?: number | string }>,
        ): Promise<void> => {
            const branchId: string | undefined =
                params?.branchId ?? branches.currentId;
            if (!branchId) return;

            setParticipants((s) => ({ ...s, loading: true }));

            const res = await backend.access.refreshParticipants(
                workspaceId,
                branchId,
                { since: params?.since ?? participants.updatedAt },
            );

            if (res.ok) {
                setParticipants({
                    data: res.value,
                    loading: false,
                    updatedAt: runtime.now(),
                });
            } else {
                setLoadableError(setParticipants, res.error);
            }
        },
        [
            backend.access,
            workspaceId,
            branches.currentId,
            participants.updatedAt,
            runtime,
        ],
    );

    const invalidateBranches = React.useCallback((): void => {
        setBranches((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    const invalidateParticipants = React.useCallback((): void => {
        setParticipants((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    return React.useMemo<BranchesSliceApi>(
        () => ({
            branches,
            participants,
            setCurrentBranchId,
            refreshBranches,
            refreshParticipants,
            invalidateBranches,
            invalidateParticipants,
            __setParticipantsState: setParticipants,
        }),
        [
            branches,
            participants,
            setCurrentBranchId,
            refreshBranches,
            refreshParticipants,
            invalidateBranches,
            invalidateParticipants,
        ],
    );
}
