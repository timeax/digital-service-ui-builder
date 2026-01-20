// src/react/workspace/context/provider/provider.tsx
import * as React from "react";
import type {
    LiveOptions,
    MergeResult,
    Result,
    TemplatesListParams,
} from "../backend";
import type { DgpServiceMap } from "@/schema/provider";

import { WorkspaceContext } from "./context";
import type { WorkspaceAPI, WorkspaceProviderProps } from "./types";
import { LIVE_OFF } from "./helpers";

import { useBackendRuntime } from "./runtime/use-backend-runtime";

import { useAuthorsSlice } from "./slices/use-authors-slice";
import { usePermissionsSlice } from "./slices/use-permissions-slice";
import { useBranchesSlice } from "./slices/use-branches-slice";
import { useTemplatesSlice } from "./slices/use-templates-slice";
import { useServicesSlice } from "./slices/use-services-slice";
import { useSnapshotsSlice } from "./slices/use-snapshots-slice";

import { useBranchCache } from "./compose/use-branch-cache";
import { useWorkspaceRefresh } from "./compose/use-workspace-refresh";
import { useLivePolling } from "./compose/use-live-polling";

/* ---------------- provider (thin composition root) ---------------- */

export function WorkspaceProvider(
    props: WorkspaceProviderProps,
): React.JSX.Element {
    const {
        backend,
        actor,
        initial,
        ensureMain = true,
        live: liveProp,
        autosaveMs = 9000,
        autoAutosave = true,
        children,
        liveAdapters,
        liveDebounceMs = 250,
    } = props;

    const runtime = useBackendRuntime();

    const workspaceId: string = backend.info.id;
    const live: LiveOptions = liveProp ?? LIVE_OFF;

    const authorsSlice = useAuthorsSlice({
        backend,
        workspaceId,
        initialAuthors: initial?.authors ?? null,
        runtime,
    });

    const permissionsSlice = usePermissionsSlice({
        backend,
        workspaceId,
        actor,
        initialPermissions: initial?.permissions ?? null,
        runtime,
    });

    const branchesSlice = useBranchesSlice({
        backend,
        workspaceId,
        ensureMain,
        initialBranches: initial?.branches ?? [],
        initialMainId: initial?.mainId,
        initialCurrentId: initial?.currentBranchId ?? initial?.mainId,
        initialParticipants: initial?.participants ?? null,
        runtime,
    });

    const getCurrentBranchId = React.useCallback(
        (): string | undefined => branchesSlice.branches.currentId,
        [branchesSlice.branches.currentId],
    );

    const templatesSlice = useTemplatesSlice({
        backend,
        workspaceId,
        getCurrentBranchId,
        initialTemplates: initial?.templates ?? null,
        runtime,
    });

    const servicesSlice = useServicesSlice({
        backend,
        workspaceId,
        initialServices: (initial?.services as DgpServiceMap | null) ?? null,
        runtime,
    });

    const snapshotsSlice = useSnapshotsSlice({
        backend,
        workspaceId,
        actor,
        getCurrentBranchId,
        initialSnapshot: initial?.snapshot
            ? {
                  schema_version: initial.snapshot.schema_version,
                  data: initial.snapshot.data as any,
              }
            : null,
        initialHead: initial?.head,
        initialDraft: initial?.draft,
        autosaveMs,
        autoAutosave,
        runtime,
    });

    const branchCache = useBranchCache();

    const refresh = useWorkspaceRefresh({
        runtime,
        refreshAuthors: authorsSlice.refreshAuthors,
        refreshPermissions: permissionsSlice.refreshPermissions,
        refreshBranches: branchesSlice.refreshBranches,
        refreshServices: servicesSlice.refreshServices,
        getCurrentBranchId,
        refreshTemplates: async (p?: Partial<{ branchId: string }>) => {
            await templatesSlice.refreshTemplates(
                p?.branchId
                    ? ({ branchId: p.branchId } as Partial<
                          Pick<TemplatesListParams, "branchId">
                      >)
                    : undefined,
            );
        },
        refreshParticipants: async (p?: Partial<{ branchId: string }>) => {
            await branchesSlice.refreshParticipants(
                p?.branchId
                    ? ({ branchId: p.branchId } as Partial<{
                          branchId: string;
                      }>)
                    : undefined,
            );
        },
        refreshSnapshotPointersForBranch:
            snapshotsSlice.refreshSnapshotPointersForBranch,
        refreshSnapshotPointers: snapshotsSlice.refreshSnapshotPointers,
    });

    const hasAnyData: boolean = Boolean(
        (authorsSlice.authors.data && authorsSlice.authors.data.length) ||
            (branchesSlice.branches.data &&
                branchesSlice.branches.data.length) ||
            (templatesSlice.templates.data &&
                templatesSlice.templates.data.length) ||
            (branchesSlice.participants.data &&
                branchesSlice.participants.data.length) ||
            snapshotsSlice.snapshot.data?.props,
    );

    const liveCtl = useLivePolling({
        live,
        workspaceId,
        actor,
        hasAnyData,
        getCurrentBranchId: () => branchesSlice.branches.currentId,
        refreshAll: refresh.refreshAll,
        refreshBranchContext: refresh.refreshBranchContext,
        refreshSnapshotPointers: refresh.refreshSnapshotPointers,
        adapters: liveAdapters,
        debounceMs: liveDebounceMs,
    });

    /* ---------------- branch ops ---------------- */

    const createBranch = React.useCallback<WorkspaceAPI["createBranch"]>(
        async (name: string, opts?: Readonly<{ fromId?: string }>) => {
            const res = await backend.branches.create(workspaceId, name, opts);
            if (res.ok) {
                await branchesSlice.refreshBranches();
                setCurrentBranch(res.value.id);
            }
            return res;
        },
        [backend.branches, workspaceId, branchesSlice /* setCurrentBranch */],
    );

    const setMain = React.useCallback<WorkspaceAPI["setMain"]>(
        async (branchId: string) => {
            const res = await backend.branches.setMain(workspaceId, branchId);
            if (res.ok) await branchesSlice.refreshBranches();
            return res;
        },
        [backend.branches, workspaceId, branchesSlice],
    );

    const mergeBranch = React.useCallback<WorkspaceAPI["mergeBranch"]>(
        async (sourceId: string, targetId: string): Result<MergeResult> => {
            const res = await backend.branches.merge(
                workspaceId,
                sourceId,
                targetId,
            );
            if (res.ok) {
                await runtime.runTasks(
                    [
                        () => branchesSlice.refreshBranches(),
                        () => refresh.refreshBranchContext(),
                    ],
                    true,
                );
            }
            return res;
        },
        [backend.branches, workspaceId, runtime, branchesSlice, refresh],
    );

    const deleteBranch = React.useCallback<WorkspaceAPI["deleteBranch"]>(
        async (branchId: string) => {
            const res = await backend.branches.delete(workspaceId, branchId);
            if (res.ok) {
                await branchesSlice.refreshBranches();

                if (branchesSlice.branches.currentId === branchId) {
                    const fallback: string | undefined =
                        branchesSlice.branches.data.find(
                            (b) => b.id !== branchId,
                        )?.id;

                    if (fallback) setCurrentBranch(fallback);
                }
            }
            return res;
        },
        [backend.branches, workspaceId, branchesSlice /* setCurrentBranch */],
    );

    /* ---------------- branch switching (cache-first) ---------------- */

    const hasInitialSnapshot: boolean = Boolean(initial?.snapshot);

    const setCurrentBranch = React.useCallback(
        (id: string): void => {
            const prevId: string | undefined = branchesSlice.branches.currentId;

            branchCache.switchBranch({
                nextId: id,
                prevId,

                templates: templatesSlice.templates,
                participants: branchesSlice.participants,
                snapshot: snapshotsSlice.snapshot,

                setTemplates: templatesSlice.__setTemplatesState,
                setParticipants: branchesSlice.__setParticipantsState,
                setSnapshot: snapshotsSlice.__setSnapshotState,

                resetTemplates: templatesSlice.resetTemplatesForBranch,
                resetParticipants: () => {
                    branchesSlice.__setParticipantsState((s) => ({
                        ...s,
                        data: null,
                        error: undefined,
                    }));
                },
                resetSnapshot: snapshotsSlice.resetSnapshotForBranch,

                setCurrentBranchId: branchesSlice.setCurrentBranchId,

                hasInitialSnapshot,

                loadSnapshotForBranch: (branchId: string) => {
                    void snapshotsSlice.loadSnapshotForBranch(branchId);
                },
            });
        },
        [
            branchesSlice.branches.currentId,
            branchesSlice.participants,
            branchesSlice.setCurrentBranchId,
            branchesSlice.__setParticipantsState,
            templatesSlice.templates,
            templatesSlice.__setTemplatesState,
            templatesSlice.resetTemplatesForBranch,
            snapshotsSlice.snapshot,
            snapshotsSlice.__setSnapshotState,
            snapshotsSlice.resetSnapshotForBranch,
            snapshotsSlice.loadSnapshotForBranch,
            branchCache,
            hasInitialSnapshot,
        ],
    );

    /* ---------------- cache invalidation ---------------- */

    const invalidate = React.useCallback<WorkspaceAPI["invalidate"]>(
        (keys) => {
            const setAll: boolean = !keys || keys.length === 0;

            if (setAll || keys?.includes("authors"))
                authorsSlice.invalidateAuthors();
            if (setAll || keys?.includes("permissions"))
                permissionsSlice.invalidatePermissions();
            if (setAll || keys?.includes("branches"))
                branchesSlice.invalidateBranches();
            if (setAll || keys?.includes("services"))
                servicesSlice.invalidateServices();

            if (setAll || keys?.includes("templates"))
                templatesSlice.invalidateTemplates();
            if (setAll || keys?.includes("participants"))
                branchesSlice.invalidateParticipants();

            if (
                setAll ||
                keys?.includes("templates") ||
                keys?.includes("participants")
            ) {
                branchCache.clear();
            }
        },
        [
            authorsSlice,
            permissionsSlice,
            branchesSlice,
            servicesSlice,
            templatesSlice,
            branchCache,
        ],
    );

    /* ---------------- memo API ---------------- */

    const api: WorkspaceAPI = React.useMemo<WorkspaceAPI>(
        () => ({
            info: backend.info,
            actor,

            authors: authorsSlice.authors,
            permissions: permissionsSlice.permissions,
            branches: branchesSlice.branches,

            templates: templatesSlice.templates,
            participants: branchesSlice.participants,
            services: servicesSlice.services,

            refresh: {
                all: refresh.refreshAll,

                authors: authorsSlice.refreshAuthors,
                permissions: permissionsSlice.refreshPermissions,
                branches: branchesSlice.refreshBranches,
                services: servicesSlice.refreshServices,

                branchContext: refresh.refreshBranchContext,

                templates: async (
                    params?: Partial<
                        Pick<TemplatesListParams, "branchId" | "since">
                    >,
                ) => templatesSlice.refreshTemplates(params),

                participants: async (
                    params?: Partial<{
                        branchId: string;
                        since?: number | string;
                    }>,
                ) => branchesSlice.refreshParticipants(params),

                snapshotPointers: refresh.refreshSnapshotPointers,
            },

            setCurrentBranch,

            createBranch,
            setMain,
            mergeBranch,
            deleteBranch,

            createTemplate: templatesSlice.createTemplate,
            updateTemplate: templatesSlice.updateTemplate,
            cloneTemplate: templatesSlice.cloneTemplate,
            publishTemplate: templatesSlice.publishTemplate,
            unpublishTemplate: templatesSlice.unpublishTemplate,
            deleteTemplate: templatesSlice.deleteTemplate,

            invalidate,

            live: {
                connected: liveCtl.connected,
                lastEventAt: liveCtl.lastEventAt,
                connect: liveCtl.connect,
                disconnect: liveCtl.disconnect,
            },

            snapshot: {
                state: snapshotsSlice.snapshot.state,
                saving: snapshotsSlice.snapshot.saving,
                dirty: snapshotsSlice.snapshot.dirty,
                head: snapshotsSlice.snapshot.head,
                draft: snapshotsSlice.snapshot.draft,
                schemaVersion: snapshotsSlice.snapshot.schemaVersion,
                data: snapshotsSlice.snapshot.data,
                lastSavedAt: snapshotsSlice.snapshot.lastSavedAt,
                lastDraftAt: snapshotsSlice.snapshot.lastDraftAt,

                set: snapshotsSlice.setSnapshotData,
                load: snapshotsSlice.loadSnapshot,
                refresh: snapshotsSlice.refreshSnapshotPointers,

                autosave: snapshotsSlice.autosave,
                save: snapshotsSlice.save,
                publish: snapshotsSlice.publish,
                discardDraft: snapshotsSlice.discardDraft,
            },
        }),
        [
            backend.info,
            actor,

            authorsSlice.authors,
            authorsSlice.refreshAuthors,

            permissionsSlice.permissions,
            permissionsSlice.refreshPermissions,

            branchesSlice.branches,
            branchesSlice.participants,
            branchesSlice.refreshBranches,
            branchesSlice.refreshParticipants,

            templatesSlice.templates,
            templatesSlice.refreshTemplates,
            templatesSlice.createTemplate,
            templatesSlice.updateTemplate,
            templatesSlice.cloneTemplate,
            templatesSlice.publishTemplate,
            templatesSlice.unpublishTemplate,
            templatesSlice.deleteTemplate,

            servicesSlice.services,
            servicesSlice.refreshServices,

            refresh.refreshAll,
            refresh.refreshBranchContext,
            refresh.refreshSnapshotPointers,

            setCurrentBranch,

            createBranch,
            setMain,
            mergeBranch,
            deleteBranch,

            invalidate,

            liveCtl.connected,
            liveCtl.lastEventAt,

            snapshotsSlice.snapshot,
            snapshotsSlice.setSnapshotData,
            snapshotsSlice.loadSnapshot,
            snapshotsSlice.refreshSnapshotPointers,
            snapshotsSlice.autosave,
            snapshotsSlice.save,
            snapshotsSlice.publish,
            snapshotsSlice.discardDraft,
        ],
    );

    return (
        <WorkspaceContext.Provider value={api}>
            {children}
        </WorkspaceContext.Provider>
    );
}
