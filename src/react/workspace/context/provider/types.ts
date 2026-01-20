// src/react/workspace/context/provider/types.ts
import type {
    Actor,
    Author,
    BackendError,
    Branch,
    BranchParticipant,
    Commit,
    Draft,
    FieldTemplate,
    LiveOptions,
    MergeResult,
    PermissionsMap,
    Result,
    ServiceSnapshot,
    SnapshotsLoadResult,
    TemplateCreateInput,
    TemplateUpdatePatch,
    TemplatesListParams,
    WorkspaceBackend,
    WorkspaceInfo,
} from "../backend";
import type { EditorSnapshot } from "@/schema/editor";
import type { DgpServiceMap } from "@/schema/provider";
import React from "react";
import { WorkspaceLiveAdapterRegistry } from "@/react/workspace/context/provider/live/types";

export interface Loadable<T> {
    readonly data: T | null;
    readonly loading: boolean;
    readonly error?: BackendError;
    readonly updatedAt?: number;
}

export type SnapshotState = "clean" | "dirty" | "uncommitted" | "saving";

export type RunOk = { ok: true };
export type RunErr = { ok: false; errors: BackendError[] };
export type RunResult = RunOk | RunErr;

export interface WorkspaceProviderProps {
    readonly backend: WorkspaceBackend;
    readonly actor: Actor;

    readonly initial?: Partial<{
        authors: readonly Author[];
        permissions: PermissionsMap;
        branches: readonly Branch[];
        mainId: string;

        // branch-scoped caches
        templates: readonly FieldTemplate[];
        participants: readonly BranchParticipant[];

        snapshot: ServiceSnapshot;
        head?: Commit;
        draft?: Draft;

        currentBranchId?: string;

        // services can be injected as already-normalized map
        services: DgpServiceMap;
    }>;

    readonly ensureMain?: boolean;
    readonly live?: LiveOptions;
    /**
     * Optional adapter registry for live modes.
     * If you want ws/sse (or custom), pass adapters here.
     */
    readonly liveAdapters?: WorkspaceLiveAdapterRegistry;

    /**
     * Debounce refresh ticks (WS bursts etc). Default handled in hook (250ms).
     */
    readonly liveDebounceMs?: number;
    readonly autosaveMs?: number; // default 9000
    readonly autoAutosave?: boolean; // default true
    readonly children: React.ReactNode;
}

export interface BranchesSlice {
    readonly data: readonly Branch[];
    readonly mainId?: string;
    readonly currentId?: string;
    readonly loading: boolean;
    readonly error?: BackendError;
    readonly updatedAt?: number;
}

export interface SnapshotSlice {
    readonly schemaVersion?: string;
    readonly data?: EditorSnapshot;
    readonly head?: Commit;
    readonly draft?: Draft;

    readonly state: SnapshotState;
    readonly saving: boolean;
    readonly dirty: boolean;

    readonly lastSavedAt?: number;
    readonly lastDraftAt?: number;
}

export interface BranchCacheEntry {
    readonly templates: Loadable<readonly FieldTemplate[]>;
    readonly participants: Loadable<readonly BranchParticipant[]>;
    readonly snapshot: SnapshotSlice;
}

export interface WorkspaceAPI {
    readonly info: WorkspaceInfo;
    readonly actor: Actor;

    readonly authors: Loadable<readonly Author[]>;
    readonly permissions: Loadable<PermissionsMap>;
    readonly branches: BranchesSlice;

    /** branch-scoped */
    readonly templates: Loadable<readonly FieldTemplate[]>;
    readonly participants: Loadable<readonly BranchParticipant[]>;

    /** workspace-scoped map (already normalized) */
    readonly services: Loadable<DgpServiceMap>;

    readonly refresh: {
        /** Refresh everything (workspace + current-branch context) */
        all(opts?: { strict?: boolean }): Promise<RunResult>;

        authors(): Promise<void>;
        permissions(): Promise<void>;
        branches(): Promise<void>;
        services(): Promise<void>;

        /** Current branch-scoped refreshers */
        branchContext(): Promise<void>;
        templates(
            params?: Partial<Pick<TemplatesListParams, "branchId" | "since">>,
        ): Promise<void>;
        participants(
            params?: Partial<{ branchId: string; since?: number | string }>,
        ): Promise<void>;

        snapshotPointers(): Promise<void>;
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
        keys?: Array<
            | "authors"
            | "permissions"
            | "branches"
            | "services"
            | "templates"
            | "participants"
        >,
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
        readonly data?: EditorSnapshot;
        readonly lastSavedAt?: number;
        readonly lastDraftAt?: number;

        set(
            updater: (curr: EditorSnapshot | undefined) => EditorSnapshot,
        ): void;

        load(
            params?: Readonly<{ versionId?: string }>,
        ): Result<SnapshotsLoadResult>;
        refresh(): Promise<void>;

        autosave(): Result<Readonly<{ draft: Draft }>>;
        save(message?: string): Result<Readonly<{ commit: Commit }>>;
        publish(message?: string): Result<Readonly<{ commit: Commit }>>;
        discardDraft(): Result<void>;
    };
}
