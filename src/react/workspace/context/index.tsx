// src/react/workspace/context/index.tsx
// React provider/hook for Workspace data with Field Templates (replaces "assets").
// Includes authors, permissions, branches, templates, and snapshots (autosave drafts).
// noinspection JSDeprecatedSymbols

import * as React from "react";
import {
    Actor,
    Author,
    BackendError,
    Branch,
    Commit,
    Draft,
    FieldTemplate,
    LiveOptions,
    MergeResult,
    PermissionsMap,
    Result,
    ServiceSnapshot,
    SnapshotsLoadResult,
    TemplatesListParams,
    TemplateCreateInput,
    TemplateUpdatePatch,
    WorkspaceBackend,
} from "./backend";

/* ---------------- small helpers ---------------- */

interface Loadable<T> {
    readonly data: T | null;
    readonly loading: boolean;
    readonly error?: BackendError;
    readonly updatedAt?: number;
}

export type SnapshotState = "clean" | "dirty" | "uncommitted" | "saving";

type RunOk = { ok: true };
type RunErr = { ok: false; errors: BackendError[] };
type RunResult = RunOk | RunErr;

function toBackendError(e: unknown): BackendError {
    if (
        typeof e === "object" &&
        e &&
        "code" in (e as any) &&
        "message" in (e as any)
    ) {
        return e as BackendError;
    }
    return { code: "unknown_error", message: String(e ?? "Unknown error") };
}

async function runTasks(
    tasks: Array<() => Promise<unknown>>,
    tolerant: boolean,
): Promise<RunResult> {
    const errors: BackendError[] = [];
    for (const t of tasks) {
        try {
            await t();
        } catch (e) {
            if (!tolerant) throw e;
            errors.push(toBackendError(e));
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

/* ---------------- provider props & slices ---------------- */

export interface WorkspaceProviderProps<
    TData extends object = Record<string, unknown>,
> {
    readonly backend: WorkspaceBackend<TData>;
    readonly workspaceId: string;
    readonly actor: Actor;
    readonly initial?: Partial<{
        authors: readonly Author[];
        permissions: PermissionsMap;
        branches: readonly Branch[];
        mainId: string;
        templates: readonly FieldTemplate[];
        snapshot: ServiceSnapshot<TData>;
        head?: Commit;
        draft?: Draft;
        currentBranchId?: string;
    }>;
    readonly ensureMain?: boolean;
    readonly live?: LiveOptions;
    readonly autosaveMs?: number; // default 9000
    readonly autoAutosave?: boolean; // default true
    readonly children: React.ReactNode;
}

interface BranchesSlice {
    readonly data: readonly Branch[];
    readonly mainId?: string;
    readonly currentId?: string;
    readonly loading: boolean;
    readonly error?: BackendError;
    readonly updatedAt?: number;
}

interface SnapshotSlice<TData extends object> {
    readonly schemaVersion?: string;
    readonly data?: TData;
    readonly head?: Commit;
    readonly draft?: Draft;
    readonly state: SnapshotState;
    readonly saving: boolean;
    readonly dirty: boolean;
    readonly lastSavedAt?: number;
    readonly lastDraftAt?: number;
}

/* ---------------- public API ---------------- */

interface WorkspaceAPI<TData extends object> {
    readonly workspaceId: string;
    readonly actor: Actor;

    readonly authors: Loadable<readonly Author[]>;
    readonly permissions: Loadable<PermissionsMap>;
    readonly branches: BranchesSlice;
    readonly templates: Loadable<readonly FieldTemplate[]>;

    readonly refresh: {
        all(opts?: { strict?: boolean }): Promise<RunResult>;
        authors(): Promise<void>;
        permissions(): Promise<void>;
        branches(): Promise<void>;
        templates(
            params?: Partial<Pick<TemplatesListParams, "branchId" | "since">>,
        ): Promise<void>;
    };

    readonly setCurrentBranch: (id: string) => void;
    readonly createBranch: (
        name: string,
        opts?: Readonly<{ fromId?: string }>,
    ) => Result<Branch>;
    readonly setMain: (branchId: string) => Result<Branch>;
    readonly mergeBranch: (
        sourceId: string,
        targetId: string,
    ) => Result<MergeResult>;
    readonly deleteBranch: (branchId: string) => Result<void>;

    // Template ops
    readonly createTemplate: (
        input: TemplateCreateInput,
    ) => Result<FieldTemplate>;
    readonly updateTemplate: (
        id: string,
        patch: TemplateUpdatePatch,
    ) => Result<FieldTemplate>;
    readonly cloneTemplate: (
        source: Readonly<{ id?: string; key?: string }>,
        opts?: Readonly<{
            newKey?: string;
            name?: string;
            branchId?: string;
            asDraft?: boolean;
        }>,
    ) => Result<FieldTemplate>;
    readonly publishTemplate: (id: string) => Result<FieldTemplate>;
    readonly unpublishTemplate: (id: string) => Result<FieldTemplate>;
    readonly deleteTemplate: (id: string) => Result<void>;

    readonly invalidate: (
        keys?: Array<"authors" | "permissions" | "branches" | "templates">,
    ) => void;

    readonly live: {
        readonly connected: boolean;
        readonly lastEventAt?: number;
        connect(): void;
        disconnect(): void;
    };

    readonly snapshot: {
        readonly state: SnapshotState;
        readonly saving: boolean;
        readonly dirty: boolean;
        readonly head?: Commit;
        readonly draft?: Draft;
        readonly schemaVersion?: string;
        readonly data?: TData;
        readonly lastSavedAt?: number;
        readonly lastDraftAt?: number;

        set(updater: (curr: TData | undefined) => TData): void;
        load(
            params?: Readonly<{ versionId?: string }>,
        ): Result<SnapshotsLoadResult<TData>>;
        refresh(): Promise<void>;
        autosave(): Result<Readonly<{ draft: Draft }>>;
        save(message?: string): Result<Readonly<{ commit: Commit }>>;
        publish(message?: string): Result<Readonly<{ commit: Commit }>>;
        discardDraft(): Result<void>;
    };
}

/* ---------------- context & hook ---------------- */

const WorkspaceContext = React.createContext<WorkspaceAPI<any> | null>(null);

export function useWorkspace<
    TData extends object = Record<string, unknown>,
>(): WorkspaceAPI<TData> {
    const ctx = React.useContext(WorkspaceContext);
    if (!ctx)
        throw new Error(
            "useWorkspace() must be used under <WorkspaceProvider/>",
        );
    return ctx as WorkspaceAPI<TData>;
}

/* ---------------- provider ---------------- */

export function WorkspaceProvider<
    TData extends object = Record<string, unknown>,
>(props: WorkspaceProviderProps<TData>): JSX.Element {
    const {
        backend,
        workspaceId,
        actor,
        initial,
        ensureMain = true,
        live = { mode: "off" },
        autosaveMs = 9000,
        autoAutosave = true,
        children,
    } = props;

    const [authors, setAuthors] = React.useState<Loadable<readonly Author[]>>({
        data: initial?.authors ?? null,
        loading: false,
        updatedAt: initial?.authors ? Date.now() : undefined,
    });

    const [permissions, setPermissions] = React.useState<
        Loadable<PermissionsMap>
    >({
        data: initial?.permissions ?? null,
        loading: false,
        updatedAt: initial?.permissions ? Date.now() : undefined,
    });

    const [branches, setBranches] = React.useState<BranchesSlice>({
        data: initial?.branches ?? [],
        mainId: initial?.mainId,
        currentId: initial?.currentBranchId ?? initial?.mainId,
        loading: false,
        updatedAt: initial?.branches ? Date.now() : undefined,
    });

    const [templates, setTemplates] = React.useState<
        Loadable<readonly FieldTemplate[]>
    >({
        data: initial?.templates ?? null,
        loading: false,
        updatedAt: initial?.templates ? Date.now() : undefined,
    });

    const [snapshot, setSnapshot] = React.useState<SnapshotSlice<TData>>({
        schemaVersion: initial?.snapshot?.schema_version,
        data: initial?.snapshot?.data as TData | undefined,
        head: initial?.head,
        draft: initial?.draft,
        state: initial?.draft ? "uncommitted" : "clean",
        saving: false,
        dirty: false,
    });

    const autosaveTimerRef = React.useRef<number | null>(null);
    const now = () => Date.now();

    function setError<T>(
        updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
        error: BackendError,
    ) {
        updater((s) => ({ ...s, loading: false, error }));
    }

    /* -------- ensure main branch -------- */
    React.useEffect(() => {
        if (!ensureMain) return;
        if (branches.data.length === 0) return;
        const existingMain = branches.data.find((b) => b.isMain)?.id;
        if (existingMain && branches.mainId !== existingMain) {
            setBranches((s) => ({
                ...s,
                mainId: existingMain,
                currentId: s.currentId ?? existingMain,
            }));
        } else if (!existingMain) {
            const first = branches.data[0]?.id;
            if (first && !branches.currentId) {
                setBranches((s) => ({ ...s, currentId: first }));
            }
        }
    }, [branches.data, branches.mainId, branches.currentId, ensureMain]);

    /* ---------------- refreshers ---------------- */

    const refreshAuthors = React.useCallback(async () => {
        setAuthors((s) => ({ ...s, loading: true }));
        const res = await backend.authors.refresh(workspaceId);
        if (res.ok)
            setAuthors({ data: res.value, loading: false, updatedAt: now() });
        else setError(setAuthors, res.error);
    }, [backend.authors, workspaceId]);

    const refreshPermissions = React.useCallback(async () => {
        setPermissions((s) => ({ ...s, loading: true }));
        const res = await backend.permissions.refresh(workspaceId, actor);
        if (res.ok)
            setPermissions({
                data: res.value,
                loading: false,
                updatedAt: now(),
            });
        else setError(setPermissions, res.error);
    }, [backend.permissions, workspaceId, actor]);

    const refreshBranches = React.useCallback(async () => {
        setBranches((s) => ({ ...s, loading: true }));
        const res = await backend.branches.refresh(workspaceId);
        if (res.ok) {
            const data = res.value;
            const main = data.find((b) => b.isMain)?.id;
            setBranches((s) => ({
                data,
                mainId: main ?? s.mainId,
                currentId: s.currentId ?? main ?? data[0]?.id,
                loading: false,
                updatedAt: now(),
            }));
        } else {
            setBranches((s) => ({ ...s, loading: false, error: res.error }));
        }
    }, [backend.branches, workspaceId]);

    const refreshTemplates = React.useCallback(
        async (
            params?: Partial<Pick<TemplatesListParams, "branchId" | "since">>,
        ) => {
            setTemplates((s) => ({ ...s, loading: true }));
            const res = await backend.templates.refresh({
                workspaceId,
                branchId: params?.branchId ?? branches.currentId,
                since: params?.since ?? templates.updatedAt,
            });
            if (res.ok)
                setTemplates({
                    data: res.value,
                    loading: false,
                    updatedAt: now(),
                });
            else setError(setTemplates, res.error);
        },
        [
            backend.templates,
            workspaceId,
            branches.currentId,
            templates.updatedAt,
        ],
    );

    const refreshAll = React.useCallback(
        async (opts?: { strict?: boolean }) =>
            runTasks(
                [
                    () => refreshAuthors(),
                    () => refreshPermissions(),
                    () => refreshBranches(),
                    () => refreshTemplates(),
                ],
                /* tolerant */ !(opts?.strict ?? false),
            ),
        [refreshAuthors, refreshPermissions, refreshBranches, refreshTemplates],
    );

    /* ---------------- snapshot ops ---------------- */

    const loadSnapshot = React.useCallback(
        async (
            params?: Readonly<{ versionId?: string }>,
        ): Result<SnapshotsLoadResult<TData>> => {
            const branchId = branches.currentId;
            if (!branchId)
                return {
                    ok: false,
                    error: {
                        code: "no_branch",
                        message: "No current branch to load snapshot from.",
                    },
                } as const;
            const res = await backend.snapshots.load({
                workspaceId,
                branchId,
                versionId: params?.versionId,
            });
            if (res.ok) {
                const { head, draft, snapshot: snap } = res.value;
                setSnapshot({
                    schemaVersion: snap.schema_version,
                    data: snap.data,
                    head,
                    draft,
                    state: draft ? "uncommitted" : "clean",
                    saving: false,
                    dirty: false,
                    lastSavedAt: undefined,
                    lastDraftAt: undefined,
                });
            }
            return res;
        },
        [backend.snapshots, workspaceId, branches.currentId],
    );

    const setSnapshotData = React.useCallback(
        (updater: (curr: TData | undefined) => TData) => {
            setSnapshot((s) => ({
                ...s,
                data: updater(s.data),
                state: s.draft ? "uncommitted" : "dirty",
                dirty: true,
            }));
        },
        [],
    );

    const doAutosave = React.useCallback(async () => {
        const branchId = branches.currentId;
        if (!branchId)
            return {
                ok: false,
                error: {
                    code: "no_branch",
                    message: "No current branch to autosave.",
                },
            } as const;
        if (!snapshot.data || !snapshot.schemaVersion)
            return {
                ok: false,
                error: { code: "no_snapshot", message: "Nothing to autosave." },
            } as const;

        const res = await backend.snapshots.autosave({
            workspaceId,
            branchId,
            snapshot: {
                schema_version: snapshot.schemaVersion,
                data: snapshot.data,
            },
            etag: snapshot.draft?.etag,
        });
        if (res.ok) {
            setSnapshot((s) => ({
                ...s,
                draft: res.value.draft,
                state: "uncommitted",
                dirty: false,
                lastDraftAt: now(),
            }));
        }
        return res;
    }, [
        backend.snapshots,
        workspaceId,
        branches.currentId,
        snapshot.data,
        snapshot.schemaVersion,
        snapshot.draft?.etag,
    ]);

    const doSave = React.useCallback(
        async (message?: string) => {
            const branchId = branches.currentId;
            if (!branchId)
                return {
                    ok: false,
                    error: {
                        code: "no_branch",
                        message: "No current branch to save.",
                    },
                } as const;
            if (!snapshot.data || !snapshot.schemaVersion)
                return {
                    ok: false,
                    error: { code: "no_snapshot", message: "Nothing to save." },
                } as const;

            setSnapshot((s) => ({ ...s, state: "saving", saving: true }));
            const res = await backend.snapshots.save({
                workspaceId,
                branchId,
                snapshot: {
                    schema_version: snapshot.schemaVersion,
                    data: snapshot.data,
                },
                message,
                draftId: snapshot.draft?.id,
                etag: snapshot.head?.etag,
            });
            if (res.ok) {
                const commit = res.value.commit;
                setSnapshot((s) => ({
                    ...s,
                    head: commit,
                    draft: undefined,
                    state: "clean",
                    saving: false,
                    dirty: false,
                    lastSavedAt: now(),
                }));
            } else {
                setSnapshot((s) => ({
                    ...s,
                    state: s.draft ? "uncommitted" : "dirty",
                    saving: false,
                }));
            }
            return res;
        },
        [
            backend.snapshots,
            workspaceId,
            branches.currentId,
            snapshot.data,
            snapshot.schemaVersion,
            snapshot.draft?.id,
            snapshot.head?.etag,
        ],
    );

    const doPublish = React.useCallback(
        async (message?: string) => {
            const draftId = snapshot.draft?.id;
            if (!draftId) return doSave(message);
            const res = await backend.snapshots.publish({
                workspaceId,
                draftId,
                message,
            });
            if (res.ok) {
                const commit = res.value.commit;
                setSnapshot((s) => ({
                    ...s,
                    head: commit,
                    draft: undefined,
                    state: "clean",
                    saving: false,
                    dirty: false,
                    lastSavedAt: now(),
                }));
            }
            return res;
        },
        [backend.snapshots, workspaceId, snapshot.draft?.id, doSave],
    );

    const discardDraft = React.useCallback(async () => {
        const draftId = snapshot.draft?.id;
        if (!draftId) return { ok: true, value: undefined } as const;
        const res = await backend.snapshots.discard({ workspaceId, draftId });
        if (res.ok)
            setSnapshot((s) => ({
                ...s,
                draft: undefined,
                state: s.dirty ? "dirty" : "clean",
            }));
        return res;
    }, [backend.snapshots, workspaceId, snapshot.draft?.id, snapshot.dirty]);

    const refreshSnapshotPointers = React.useCallback(async () => {
        const branchId = branches.currentId;
        if (!branchId) return;
        const res = await backend.snapshots.refresh({
            workspaceId,
            branchId,
            since: snapshot.lastSavedAt ?? snapshot.lastDraftAt,
        });
        if (res.ok) {
            setSnapshot((s) => ({
                ...s,
                head: res.value.head ?? s.head,
                draft: res.value.draft,
                state: res.value.draft
                    ? "uncommitted"
                    : s.dirty
                      ? "dirty"
                      : "clean",
            }));
        }
    }, [
        backend.snapshots,
        workspaceId,
        branches.currentId,
        snapshot.lastSavedAt,
        snapshot.lastDraftAt,
    ]);

    /* ---------------- autosave effect ---------------- */
    React.useEffect(() => {
        if (!autoAutosave || !snapshot.dirty) return;
        if (autosaveTimerRef.current) {
            window.clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
        }
        autosaveTimerRef.current = window.setTimeout(() => {
            void doAutosave();
            autosaveTimerRef.current = null;
        }, autosaveMs) as unknown as number;

        return () => {
            if (autosaveTimerRef.current) {
                window.clearTimeout(autosaveTimerRef.current);
                autosaveTimerRef.current = null;
            }
        };
    }, [snapshot.dirty, autosaveMs, autoAutosave, doAutosave]);

    /* ---------------- live (poll baseline) ---------------- */
    const [liveState, setLiveState] = React.useState<{
        connected: boolean;
        lastEventAt?: number;
    }>({ connected: false });

    React.useEffect(() => {
        if (live.mode === "off") return;

        let intervalId: number | null = null;
        let stop = () => {};

        if (live.mode === "poll") {
            const iv = live.intervalMs ?? 15000;
            setLiveState((s) => ({ ...s, connected: true }));
            const tick = async () => {
                await runTasks(
                    [
                        () => refreshBranches(),
                        () => refreshTemplates(),
                        () => refreshSnapshotPointers(),
                    ],
                    true,
                );
                setLiveState({ connected: true, lastEventAt: Date.now() });
            };
            intervalId = window.setInterval(tick, iv) as unknown as number;
            void tick();
            stop = () => {
                if (intervalId !== null) window.clearInterval(intervalId);
                setLiveState({ connected: false });
            };
        }
        // Wire SSE/WS here if you emit WorkspaceEvent events.

        return () => stop();
    }, [live, refreshBranches, refreshTemplates, refreshSnapshotPointers]);

    /* ---------------- branch ops ---------------- */

    const setCurrentBranch = React.useCallback(
        (id: string) => {
            setBranches((s) => ({ ...s, currentId: id }));
            void loadSnapshot();
        },
        [loadSnapshot],
    );

    const createBranch = React.useCallback<WorkspaceAPI<TData>["createBranch"]>(
        async (name, opts) => {
            const res = await backend.branches.create(workspaceId, name, opts);
            if (res.ok) {
                await refreshBranches();
                setCurrentBranch(res.value.id);
            }
            return res;
        },
        [backend.branches, workspaceId, refreshBranches, setCurrentBranch],
    );

    const setMain = React.useCallback<WorkspaceAPI<TData>["setMain"]>(
        async (branchId) => {
            const res = await backend.branches.setMain(workspaceId, branchId);
            if (res.ok) await refreshBranches();
            return res;
        },
        [backend.branches, workspaceId, refreshBranches],
    );

    const mergeBranch = React.useCallback<WorkspaceAPI<TData>["mergeBranch"]>(
        async (sourceId, targetId) => {
            const res = await backend.branches.merge(
                workspaceId,
                sourceId,
                targetId,
            );
            if (res.ok)
                await runTasks(
                    [() => refreshBranches(), () => refreshSnapshotPointers()],
                    true,
                );
            return res;
        },
        [
            backend.branches,
            workspaceId,
            refreshBranches,
            refreshSnapshotPointers,
        ],
    );

    const deleteBranch = React.useCallback<WorkspaceAPI<TData>["deleteBranch"]>(
        async (branchId) => {
            const res = await backend.branches.delete(workspaceId, branchId);
            if (res.ok) {
                await refreshBranches();
                if (branches.currentId === branchId) {
                    const fallback = branches.data.find(
                        (b) => b.id !== branchId,
                    )?.id;
                    if (fallback) setCurrentBranch(fallback);
                }
            }
            return res;
        },
        [
            backend.branches,
            workspaceId,
            refreshBranches,
            branches.currentId,
            branches.data,
            setCurrentBranch,
        ],
    );

    /* ---------------- template ops ---------------- */

    const createTemplate = React.useCallback<
        WorkspaceAPI<TData>["createTemplate"]
    >(
        async (input) => {
            const res = await backend.templates.create(workspaceId, {
                ...input,
                branchId: input.branchId ?? branches.currentId,
            });
            if (res.ok)
                await refreshTemplates({
                    branchId: res.value.branchId ?? branches.currentId,
                });
            return res;
        },
        [backend.templates, workspaceId, branches.currentId, refreshTemplates],
    );

    const updateTemplate = React.useCallback<
        WorkspaceAPI<TData>["updateTemplate"]
    >(
        async (id, patch) => {
            const res = await backend.templates.update(id, patch);
            if (res.ok)
                await refreshTemplates({
                    branchId: res.value.branchId ?? branches.currentId,
                });
            return res;
        },
        [backend.templates, branches.currentId, refreshTemplates],
    );

    const cloneTemplate = React.useCallback<
        WorkspaceAPI<TData>["cloneTemplate"]
    >(
        async (source, opts) => {
            const res = await backend.templates.clone(
                source,
                opts ?? { branchId: branches.currentId ?? undefined },
            );
            if (res.ok)
                await refreshTemplates({
                    branchId: res.value.branchId ?? branches.currentId,
                });
            return res;
        },
        [backend.templates, branches.currentId, refreshTemplates],
    );

    const publishTemplate = React.useCallback<
        WorkspaceAPI<TData>["publishTemplate"]
    >(
        async (id) => {
            const res = await backend.templates.publish(id);
            if (res.ok)
                await refreshTemplates({
                    branchId: res.value.branchId ?? branches.currentId,
                });
            return res;
        },
        [backend.templates, branches.currentId, refreshTemplates],
    );

    const unpublishTemplate = React.useCallback<
        WorkspaceAPI<TData>["unpublishTemplate"]
    >(
        async (id) => {
            const res = await backend.templates.unpublish(id);
            if (res.ok)
                await refreshTemplates({
                    branchId: res.value.branchId ?? branches.currentId,
                });
            return res;
        },
        [backend.templates, branches.currentId, refreshTemplates],
    );

    const deleteTemplate = React.useCallback<
        WorkspaceAPI<TData>["deleteTemplate"]
    >(
        async (id) => {
            const res = await backend.templates.delete(id);
            if (res.ok)
                await refreshTemplates({ branchId: branches.currentId });
            return res;
        },
        [backend.templates, branches.currentId, refreshTemplates],
    );

    /* ---------------- cache invalidation ---------------- */

    const invalidate = React.useCallback<WorkspaceAPI<TData>["invalidate"]>(
        (keys) => {
            const setAll = !keys || keys.length === 0;
            if (setAll || keys.includes("authors"))
                setAuthors((s) => ({ ...s, updatedAt: undefined }));
            if (setAll || keys.includes("permissions"))
                setPermissions((s) => ({ ...s, updatedAt: undefined }));
            if (setAll || keys.includes("branches"))
                setBranches((s) => ({ ...s, updatedAt: undefined }));
            if (setAll || keys.includes("templates"))
                setTemplates((s) => ({ ...s, updatedAt: undefined }));
        },
        [],
    );

    /* ---------------- initial load ---------------- */
    React.useEffect(() => {
        if (initial?.snapshot) return;
        void loadSnapshot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [branches.currentId]);

    /* ---------------- memo API ---------------- */

    const api: WorkspaceAPI<TData> = React.useMemo(
        () => ({
            workspaceId,
            actor,
            authors,
            permissions,
            branches,
            templates,
            refresh: {
                all: refreshAll,
                authors: refreshAuthors,
                permissions: refreshPermissions,
                branches: refreshBranches,
                templates: refreshTemplates,
            },
            setCurrentBranch,
            createBranch,
            setMain,
            mergeBranch,
            deleteBranch,
            createTemplate,
            updateTemplate,
            cloneTemplate,
            publishTemplate,
            unpublishTemplate,
            deleteTemplate,
            invalidate,
            live: {
                connected: liveState.connected,
                lastEventAt: liveState.lastEventAt,
                connect: () => {
                    /* re-render provider with live prop for SSE/WS */
                },
                disconnect: () => {
                    /* re-render with live={{mode:"off"}} */
                },
            },
            snapshot: {
                state: snapshot.state,
                saving: snapshot.saving,
                dirty: snapshot.dirty,
                head: snapshot.head,
                draft: snapshot.draft,
                schemaVersion: snapshot.schemaVersion,
                data: snapshot.data,
                lastSavedAt: snapshot.lastSavedAt,
                lastDraftAt: snapshot.lastDraftAt,
                set: setSnapshotData,
                load: loadSnapshot,
                refresh: refreshSnapshotPointers,
                autosave: doAutosave,
                save: doSave,
                publish: doPublish,
                discardDraft: discardDraft,
            },
        }),
        [
            workspaceId,
            actor,
            authors,
            permissions,
            branches,
            templates,
            refreshAll,
            refreshAuthors,
            refreshPermissions,
            refreshBranches,
            refreshTemplates,
            setCurrentBranch,
            createBranch,
            setMain,
            mergeBranch,
            deleteBranch,
            createTemplate,
            updateTemplate,
            cloneTemplate,
            publishTemplate,
            unpublishTemplate,
            deleteTemplate,
            invalidate,
            liveState.connected,
            liveState.lastEventAt,
            snapshot.state,
            snapshot.saving,
            snapshot.dirty,
            snapshot.head,
            snapshot.draft,
            snapshot.schemaVersion,
            snapshot.data,
            snapshot.lastSavedAt,
            snapshot.lastDraftAt,
            setSnapshotData,
            loadSnapshot,
            refreshSnapshotPointers,
            doAutosave,
            doSave,
            doPublish,
            discardDraft,
        ],
    );

    return (
        <WorkspaceContext.Provider value={api}>
            {children}
        </WorkspaceContext.Provider>
    );
}
