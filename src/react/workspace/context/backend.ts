// src/react/workspace/context/backend.ts
// Transport-agnostic contracts for the Workspace layer.
// Explicit types only (no implicit any). Result shape: { ok, value | error }.

/* ---------------- core result & identity ---------------- */

export interface BackendError {
    readonly code: string;
    readonly message: string;
    readonly status?: number;
    readonly hint?: string;
    readonly cause?: unknown;
}

export type BackendResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: BackendError };

export type Result<T> = Promise<BackendResult<T>>;

export interface Actor {
    readonly id: string;
    readonly name?: string;
    readonly roles?: readonly string[];
    readonly meta?: Readonly<Record<string, unknown>>;
}

/* ---------------- common entities ---------------- */

export interface Author {
    readonly id: string;
    readonly name: string;
    readonly handle?: string;
    readonly avatarUrl?: string;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly createdAt?: string;
    readonly updatedAt?: string;
}

export type PermissionsMap = Readonly<Record<string, boolean>>;

export interface Branch {
    readonly id: string;
    readonly name: string;
    readonly isMain: boolean;
    readonly headVersionId?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface MergeResult {
    readonly sourceId: string;
    readonly targetId: string;
    readonly conflicts?: number;
    readonly message?: string;
}

/* ---------------- snapshots (editor state) ---------------- */

export interface ServiceSnapshot<
    TData extends object = Record<string, unknown>,
> {
    readonly schema_version: string;
    readonly data: TData;
    readonly meta?: Readonly<Record<string, unknown>>;
}

export interface Draft {
    readonly id: string;
    readonly branchId: string;
    readonly status: "uncommitted";
    readonly etag?: string;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface Commit {
    readonly id: string;
    readonly branchId: string;
    readonly message?: string;
    readonly versionId?: string;
    readonly etag?: string;
    readonly createdAt: string;
}

export interface SnapshotsLoadResult<
    TData extends object = Record<string, unknown>,
> {
    readonly head?: Commit;
    readonly draft?: Draft;
    readonly snapshot: ServiceSnapshot<TData>;
}

export interface SnapshotsBackend<
    TData extends object = Record<string, unknown>,
> {
    load(
        params: Readonly<{
            workspaceId: string;
            branchId: string;
            versionId?: string;
        }>,
    ): Result<SnapshotsLoadResult<TData>>;
    autosave(
        params: Readonly<{
            workspaceId: string;
            branchId: string;
            snapshot: ServiceSnapshot<TData>;
            clientId?: string;
            since?: number | string;
            etag?: string;
        }>,
    ): Result<Readonly<{ draft: Draft }>>;
    save(
        params: Readonly<{
            workspaceId: string;
            branchId: string;
            snapshot: ServiceSnapshot<TData>;
            message?: string;
            draftId?: string;
            etag?: string;
        }>,
    ): Result<Readonly<{ commit: Commit }>>;
    publish(
        params: Readonly<{
            workspaceId: string;
            draftId: string;
            message?: string;
        }>,
    ): Result<Readonly<{ commit: Commit }>>;
    discard(
        params: Readonly<{ workspaceId: string; draftId: string }>,
    ): Result<void>;
    refresh(
        params: Readonly<{
            workspaceId: string;
            branchId: string;
            since?: number | string;
        }>,
    ): Result<Readonly<{ head?: Commit; draft?: Draft }>>;
}

/* ---------------- templates (replacing "assets") ---------------- */

export interface TemplateValidator {
    readonly type: string; // e.g., "required" | "regex" | "min" | "max" | custom code
    readonly rule?: unknown; // params for the validator
    readonly message?: string;
}

export interface FieldTemplate {
    readonly id: string;
    /** Unique key (per workspace, optionally per branch) used to reference this template */
    readonly key: string;
    readonly name: string;
    /** logical kind e.g. "text", "number", "date", "select", "relation", ... */
    readonly kind: string;

    /** Optional branch scoping (can be global if undefined) */
    readonly branchId?: string;

    /** Canonical, builder-consumable definition (shape up to your app) */
    readonly definition: Readonly<Record<string, unknown>>;

    /** Default values the editor may inject when using this template */
    readonly defaults?: Readonly<Record<string, unknown>>;

    /** UI metadata (icons, color, sizing, render hints, etc.) */
    readonly ui?: Readonly<Record<string, unknown>>;

    /** Client- or server-side validators */
    readonly validators?: readonly TemplateValidator[];

    readonly tags?: readonly string[];
    readonly category?: string;

    /** Published templates are selectable by default in the editor palette */
    readonly published: boolean;

    /** Incremented on every update */
    readonly version: number;

    readonly createdAt: string;
    readonly updatedAt: string;
}

/** Narrow list/search input */
export interface TemplatesListParams {
    readonly workspaceId: string;
    readonly branchId?: string;
    readonly q?: string;
    readonly tags?: readonly string[];
    readonly category?: string;
    readonly since?: string | number;
}

export interface TemplateCreateInput {
    readonly key?: string; // if omitted, backend generates a unique one
    readonly name: string;
    readonly kind: string;
    readonly branchId?: string;
    readonly definition: Readonly<Record<string, unknown>>;
    readonly defaults?: Readonly<Record<string, unknown>>;
    readonly ui?: Readonly<Record<string, unknown>>;
    readonly validators?: readonly TemplateValidator[];
    readonly tags?: readonly string[];
    readonly category?: string;
    readonly published?: boolean;
}

export interface TemplateUpdatePatch {
    readonly name?: string;
    readonly kind?: string;
    readonly branchId?: string | null;
    readonly definition?: Readonly<Record<string, unknown>>;
    readonly defaults?: Readonly<Record<string, unknown>> | null;
    readonly ui?: Readonly<Record<string, unknown>> | null;
    readonly validators?: readonly TemplateValidator[] | null;
    readonly tags?: readonly string[] | null;
    readonly category?: string | null;
    readonly published?: boolean;
}

export interface TemplatesBackend {
    list(params: TemplatesListParams): Result<readonly FieldTemplate[]>;
    get(id: string): Result<FieldTemplate | null>;
    getByKey(
        workspaceId: string,
        key: string,
        branchId?: string,
    ): Result<FieldTemplate | null>;
    create(
        workspaceId: string,
        input: TemplateCreateInput,
    ): Result<FieldTemplate>;
    update(id: string, patch: TemplateUpdatePatch): Result<FieldTemplate>;
    clone(
        source: Readonly<{ id?: string; key?: string }>,
        opts?: Readonly<{
            newKey?: string;
            name?: string;
            branchId?: string;
            asDraft?: boolean;
        }>,
    ): Result<FieldTemplate>;
    publish(id: string): Result<FieldTemplate>;
    unpublish(id: string): Result<FieldTemplate>;
    delete(id: string): Result<void>;
    refresh(
        params: Omit<TemplatesListParams, "q" | "tags" | "category">,
    ): Result<readonly FieldTemplate[]>;
}

/* ---------------- live channel (unchanged) ---------------- */

export type WorkspaceEvent =
    | { type: "authors.updated"; since?: number | string }
    | { type: "permissions.updated" }
    | { type: "branch.created"; branch: Branch }
    | { type: "branch.deleted"; branchId: string }
    | { type: "branch.setMain"; branchId: string }
    | { type: "branch.merged"; sourceId: string; targetId: string }
    | { type: "template.created"; template: FieldTemplate }
    | { type: "template.updated"; template: FieldTemplate }
    | { type: "template.deleted"; templateId: string }
    | { type: "snapshot.autosaved"; branchId: string; draft: Draft }
    | { type: "snapshot.saved"; branchId: string; commit: Commit }
    | { type: "snapshot.published"; branchId: string; commit: Commit }
    | { type: "snapshot.discarded"; branchId: string };

export type LiveOptions =
    | { mode: "off" }
    | { mode: "poll"; intervalMs?: number }
    | { mode: "sse"; url: string; headers?: Readonly<Record<string, string>> }
    | { mode: "ws"; url: string; protocols?: readonly string[] };

/* ---------------- authors / permissions / branches ---------------- */

export interface AuthorsBackend {
    list(workspaceId: string): Result<readonly Author[]>;
    get(authorId: string): Result<Author | null>;
    refresh(workspaceId: string): Result<readonly Author[]>;
}

export interface PermissionsBackend {
    get(workspaceId: string, actor: Actor): Result<PermissionsMap>;
    refresh(workspaceId: string, actor: Actor): Result<PermissionsMap>;
}

export interface BranchesBackend {
    list(workspaceId: string): Result<readonly Branch[]>;
    create(
        workspaceId: string,
        name: string,
        opts?: Readonly<{ fromId?: string }>,
    ): Result<Branch>;
    setMain(workspaceId: string, branchId: string): Result<Branch>;
    merge(
        workspaceId: string,
        sourceId: string,
        targetId: string,
    ): Result<MergeResult>;
    delete(workspaceId: string, branchId: string): Result<void>;
    refresh(workspaceId: string): Result<readonly Branch[]>;
}

/* ---------------- workspace backend root ---------------- */

export interface WorkspaceBackend<
    TData extends object = Record<string, unknown>,
> {
    readonly authors: AuthorsBackend;
    readonly permissions: PermissionsBackend;
    readonly branches: BranchesBackend;
    readonly templates: TemplatesBackend;
    readonly snapshots: SnapshotsBackend<TData>;

    /**
     * @deprecated Asset/file semantics have been replaced by templates.
     * If present, this shim MAY forward to `templates` under the hood.
     */
    readonly assets?: AssetsBackendShim;
}

/* ---------------- DEPRECATED asset shim (compat only) ---------------- */

/** @deprecated - use FieldTemplate instead. */
export type Asset = FieldTemplate;

/** @deprecated - legacy list params mapped to TemplatesListParams. */
export interface AssetsListParamsShim {
    readonly workspaceId: string;
    readonly branchId?: string;
    readonly q?: string;
    readonly since?: string | number;
}

/** @deprecated - legacy upload params are not supported for templates. */
export interface AssetsUploadParamsShim {
    readonly workspaceId: string;
    readonly branchId?: string;
    readonly file: {
        readonly name: string;
        readonly size: number;
        readonly mime?: string;
        readonly type?: string;
        readonly data: unknown;
    };
    readonly meta?: Readonly<Record<string, unknown>>;
}

/** @deprecated - minimal surface so old callers don’t crash. */
export interface AssetsBackendShim {
    list(params: AssetsListParamsShim): Result<readonly Asset[]>;
    get(assetId: string): Result<Asset | null>;
    rename(assetId: string, name: string): Result<Asset>;
    move(assetId: string, to: Readonly<{ branchId?: string }>): Result<Asset>;
    delete(assetId: string): Result<void>;
    /** always returns ok("") or an error; templates do not have URLs */
    url(assetId: string, kind?: "view" | "download" | "thumb"): Result<string>;
    refresh(params: Omit<AssetsListParamsShim, "q">): Result<readonly Asset[]>;
    /** always returns error; not supported for templates */
    upload(params: AssetsUploadParamsShim): Result<Asset>;
}
