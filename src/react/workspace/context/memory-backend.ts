//@ts-nocheck
// src/react/workspace/memory-backend.ts
// In-memory WorkspaceBackend with Field Templates (plus a deprecated assets shim).
// noinspection JSConstantReassignment,JSDeprecatedSymbols

import type {
    Actor,
    Author,
    BackendError,
    Branch,
    BranchesBackend,
    Commit,
    Draft,
    FieldTemplate,
    MergeResult,
    PermissionsMap,
    Result,
    ServiceSnapshot,
    SnapshotsBackend,
    SnapshotsLoadResult,
    TemplateCreateInput,
    TemplateUpdatePatch,
    TemplatesBackend,
    TemplatesListParams,
    WorkspaceBackend,
    // deprecated shim types
    AssetsBackendShim,
    AssetsListParamsShim,
    AssetsUploadParamsShim,
    Asset,
} from "./backend";

/* ---------------- utilities ---------------- */

type Id = string;
const nowIso = () => new Date().toISOString();
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const err = (
    code: string,
    message: string,
    hint?: string,
): { ok: false; error: BackendError } => ({
    ok: false,
    error: { code, message, hint },
});

function clone<T>(v: T): T {
    if (Array.isArray(v)) return v.slice() as unknown as T;
    if (typeof v === "object" && v !== null) return { ...(v as object) } as T;
    return v;
}
const genId = (p: string, i: number): Id => `${p}-${i}`;

/* ---------------- seed & store ---------------- */

export interface MemorySeed<TData extends object = Record<string, unknown>> {
    workspaceId: string;
    authors?: Author[];
    permissionsForActor?: (ctx: {
        workspaceId: string;
        actor: Actor;
    }) => PermissionsMap;
    branchNames?: string[]; // default ["main"]
    initialSnapshot?: ServiceSnapshot<TData>;
    initialHeadMessage?: string;
    initialDraft?: boolean;

    /** Pre-seed field templates */
    templates?: ReadonlyArray<
        Pick<
            FieldTemplate,
            | "key"
            | "name"
            | "kind"
            | "definition"
            | "defaults"
            | "ui"
            | "validators"
            | "tags"
            | "category"
            | "published"
        > & { branchId?: string }
    >;
}

interface Store<TData extends object> {
    readonly workspaceId: string;
    authors: Author[];
    permissionsForActor: (actor: Actor) => PermissionsMap;

    branches: Branch[];
    mainId: string;

    templates: FieldTemplate[];

    snapshot: ServiceSnapshot<TData>;
    head?: Commit;
    draft?: Draft;

    counters: { id: number; version: number; template: number };
}

/* ---------------- factory ---------------- */

export function createMemoryWorkspaceBackend<
    TData extends object = Record<string, unknown>,
>(seed: MemorySeed<TData>): WorkspaceBackend<TData> {
    const wsId = seed.workspaceId;
    let idCounter = 1;
    let versionCounter = 1;
    let templateCounter = 1;

    // branches
    const names = seed.branchNames?.length ? seed.branchNames : ["main"];
    const branches: Branch[] = names.map(
        (name): Branch => ({
            id: genId("branch", idCounter++),
            name,
            isMain: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        }),
    );
    const mainIdx = Math.max(
        0,
        branches.findIndex((b) => b.name.toLowerCase() === "main"),
    );
    branches.forEach((b, i) => (b.isMain = i === (mainIdx >= 0 ? mainIdx : 0)));
    const mainId = branches.find((b) => b.isMain)!.id;

    // authors / permissions
    const authors = seed.authors ?? [];
    const perms = seed.permissionsForActor
        ? (actor: Actor) =>
              seed.permissionsForActor!({ workspaceId: wsId, actor })
        : (_actor: Actor) => ({ "*": true });

    // snapshot pointers
    const snapshot: ServiceSnapshot<TData> = seed.initialSnapshot ?? {
        schema_version: "1.0",
        data: {} as TData,
    };
    const head: Commit | undefined = seed.initialHeadMessage
        ? {
              id: genId("commit", versionCounter++),
              branchId: mainId,
              message: seed.initialHeadMessage,
              versionId: genId("version", versionCounter++),
              etag: `etag-${Date.now()}`,
              createdAt: nowIso(),
          }
        : undefined;
    const draft: Draft | undefined = seed.initialDraft
        ? {
              id: genId("draft", versionCounter++),
              branchId: mainId,
              status: "uncommitted",
              etag: `draft-${Date.now()}`,
              createdAt: nowIso(),
              updatedAt: nowIso(),
          }
        : undefined;

    // templates
    const templates: FieldTemplate[] = (seed.templates ?? []).map(
        (t): FieldTemplate => ({
            id: genId("tpl", templateCounter++),
            key: t.key,
            name: t.name,
            kind: t.kind,
            branchId: t.branchId,
            definition: clone(t.definition ?? {}),
            defaults: t.defaults ? clone(t.defaults) : undefined,
            ui: t.ui ? clone(t.ui) : undefined,
            validators: t.validators ? clone(t.validators) : undefined,
            tags: t.tags ? clone(t.tags) : undefined,
            category: t.category,
            published: t.published ?? false,
            version: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        }),
    );

    const store: Store<TData> = {
        workspaceId: wsId,
        authors,
        permissionsForActor: perms,
        branches,
        mainId,
        templates,
        snapshot,
        head,
        draft,
        counters: {
            id: idCounter,
            version: versionCounter,
            template: templateCounter,
        },
    };

    /* ---------------- authors backend ---------------- */

    const authorsBackend = {
        async list(workspaceId: string): Result<readonly Author[]> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            return ok(clone(store.authors));
        },
        async get(authorId: string): Result<Author | null> {
            const a = store.authors.find((x) => x.id === authorId) ?? null;
            return ok(a ? clone(a) : null);
        },
        async refresh(workspaceId: string): Result<readonly Author[]> {
            return this.list(workspaceId);
        },
    };

    /* ---------------- permissions backend ---------------- */

    const permissionsBackend = {
        async get(workspaceId: string, actor: Actor): Result<PermissionsMap> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            return ok(clone(store.permissionsForActor(actor)));
        },
        async refresh(
            workspaceId: string,
            actor: Actor,
        ): Result<PermissionsMap> {
            return this.get(workspaceId, actor);
        },
    };

    /* ---------------- branches backend ---------------- */

    const branchesBackend: BranchesBackend = {
        async list(workspaceId: string): Result<readonly Branch[]> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            return ok(clone(store.branches));
        },
        async create(
            workspaceId: string,
            name: string,
            opts?: Readonly<{ fromId?: string }>,
        ): Result<Branch> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const now = nowIso();
            const fromId = opts?.fromId;
            const headVersionId = fromId
                ? store.branches.find((b) => b.id === fromId)?.headVersionId
                : undefined;
            const b: Branch = {
                id: genId("branch", ++store.counters.id),
                name,
                isMain: false,
                headVersionId,
                createdAt: now,
                updatedAt: now,
            };
            store.branches.push(b);
            return ok(clone(b));
        },
        async setMain(workspaceId: string, branchId: string): Result<Branch> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const target = store.branches.find((b) => b.id === branchId);
            if (!target) return err("not_found", "Branch not found");
            store.branches.forEach((b) => (b.isMain = b.id === branchId));
            store.mainId = branchId;
            target.updatedAt = nowIso();
            return ok(clone(target));
        },
        async merge(
            workspaceId: string,
            sourceId: string,
            targetId: string,
        ): Result<MergeResult> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const src = store.branches.find((b) => b.id === sourceId);
            const tgt = store.branches.find((b) => b.id === targetId);
            if (!src || !tgt)
                return err("not_found", "Source or target branch not found");
            const merge: MergeResult = {
                sourceId,
                targetId,
                conflicts: 0,
                message: "Fast-forward (memory)",
            };
            tgt.headVersionId = genId("version", ++store.counters.version);
            tgt.updatedAt = nowIso();
            return ok(merge);
        },
        async delete(workspaceId: string, branchId: string): Result<void> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const idx = store.branches.findIndex((b) => b.id === branchId);
            if (idx < 0) return err("not_found", "Branch not found");
            if (store.branches[idx].isMain)
                return err("forbidden", "Cannot delete main branch");
            store.branches.splice(idx, 1);
            return ok(undefined);
        },
        async refresh(workspaceId: string): Result<readonly Branch[]> {
            return this.list(workspaceId);
        },
    };

    /* ---------------- templates backend ---------------- */

    const templatesBackend: TemplatesBackend = {
        async list(
            params: TemplatesListParams,
        ): Result<readonly FieldTemplate[]> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            let items = store.templates.slice();
            if (params.branchId)
                items = items.filter((t) => t.branchId === params.branchId);
            if (params.q) {
                const q = params.q.toLowerCase();
                items = items.filter(
                    (t) =>
                        t.name.toLowerCase().includes(q) ||
                        t.key.toLowerCase().includes(q) ||
                        (t.tags ?? []).some((tag) =>
                            tag.toLowerCase().includes(q),
                        ),
                );
            }
            if (params.tags?.length) {
                items = items.filter((t) => {
                    const set = new Set(
                        (t.tags ?? []).map((x) => x.toLowerCase()),
                    );
                    return params.tags!.every((tg) =>
                        set.has(tg.toLowerCase()),
                    );
                });
            }
            if (params.category) {
                items = items.filter(
                    (t) =>
                        (t.category ?? "").toLowerCase() ===
                        params.category!.toLowerCase(),
                );
            }
            return ok(clone(items));
        },

        async get(id: string): Result<FieldTemplate | null> {
            const t = store.templates.find((x) => x.id === id) ?? null;
            return ok(t ? clone(t) : null);
        },

        async getByKey(
            workspaceId: string,
            key: string,
            branchId?: string,
        ): Result<FieldTemplate | null> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const t =
                store.templates.find(
                    (x) =>
                        x.key === key &&
                        (branchId ? x.branchId === branchId : true),
                ) ?? null;
            return ok(t ? clone(t) : null);
        },

        async create(
            workspaceId: string,
            input: TemplateCreateInput,
        ): Result<FieldTemplate> {
            if (workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            const key = input.key ?? suggestKey(input.name);
            if (
                store.templates.some(
                    (t) =>
                        t.key === key &&
                        (input.branchId
                            ? t.branchId === input.branchId
                            : !t.branchId),
                )
            ) {
                return err("conflict", "Template key already exists");
            }
            const t: FieldTemplate = {
                id: genId("tpl", ++store.counters.template),
                key,
                name: input.name,
                kind: input.kind,
                branchId: input.branchId,
                definition: clone(input.definition ?? {}),
                defaults: input.defaults ? clone(input.defaults) : undefined,
                ui: input.ui ? clone(input.ui) : undefined,
                validators: input.validators
                    ? clone(input.validators)
                    : undefined,
                tags: input.tags ? clone(input.tags) : undefined,
                category: input.category,
                published: input.published ?? false,
                version: 1,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            store.templates.push(t);
            return ok(clone(t));
        },

        async update(
            id: string,
            patch: TemplateUpdatePatch,
        ): Result<FieldTemplate> {
            const t = store.templates.find((x) => x.id === id);
            if (!t) return err("not_found", "Template not found");
            if (patch.name !== undefined) t.name = patch.name;
            if (patch.kind !== undefined) t.kind = patch.kind;
            if (patch.branchId !== undefined)
                t.branchId = patch.branchId ?? undefined;
            if (patch.definition !== undefined)
                t.definition = clone(patch.definition);
            if (patch.defaults !== undefined)
                t.defaults = patch.defaults ? clone(patch.defaults) : undefined;
            if (patch.ui !== undefined)
                t.ui = patch.ui ? clone(patch.ui) : undefined;
            if (patch.validators !== undefined)
                t.validators = patch.validators
                    ? clone(patch.validators)
                    : undefined;
            if (patch.tags !== undefined)
                t.tags = patch.tags ? clone(patch.tags) : undefined;
            if (patch.category !== undefined)
                t.category = patch.category ?? undefined;
            if (patch.published !== undefined) t.published = patch.published;
            t.version += 1;
            t.updatedAt = nowIso();
            return ok(clone(t));
        },

        async clone(
            source: Readonly<{ id?: string; key?: string }>,
            opts?: Readonly<{
                newKey?: string;
                name?: string;
                branchId?: string;
                asDraft?: boolean;
            }>,
        ): Result<FieldTemplate> {
            const orig =
                (source.id &&
                    store.templates.find((x) => x.id === source.id)) ||
                (source.key &&
                    store.templates.find((x) => x.key === source.key)) ||
                null;
            if (!orig) return err("not_found", "Source template not found");
            const key = opts?.newKey ?? uniqueKey(orig.key);
            const t: FieldTemplate = {
                ...clone(orig),
                id: genId("tpl", ++store.counters.template),
                key,
                name: opts?.name ?? `${orig.name} Copy`,
                branchId: opts?.branchId ?? orig.branchId,
                published: opts?.asDraft ? false : orig.published,
                version: 1,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            store.templates.push(t);
            return ok(clone(t));
        },

        async publish(id: string): Result<FieldTemplate> {
            const t = store.templates.find((x) => x.id === id);
            if (!t) return err("not_found", "Template not found");
            t.published = true;
            t.version += 1;
            t.updatedAt = nowIso();
            return ok(clone(t));
        },

        async unpublish(id: string): Result<FieldTemplate> {
            const t = store.templates.find((x) => x.id === id);
            if (!t) return err("not_found", "Template not found");
            t.published = false;
            t.version += 1;
            t.updatedAt = nowIso();
            return ok(clone(t));
        },

        async delete(id: string): Result<void> {
            const i = store.templates.findIndex((x) => x.id === id);
            if (i < 0) return err("not_found", "Template not found");
            store.templates.splice(i, 1);
            return ok(undefined);
        },

        async refresh(
            params: Omit<TemplatesListParams, "q" | "tags" | "category">,
        ): Result<readonly FieldTemplate[]> {
            return this.list(params as TemplatesListParams);
        },
    };

    function suggestKey(name: string): string {
        const base = name
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9\-]/g, "");
        return uniqueKey(base || "template");
    }
    function uniqueKey(base: string): string {
        let k = base;
        let i = 1;
        while (store.templates.some((t) => t.key === k)) {
            k = `${base}-${++i}`;
        }
        return k;
    }

    /* ---------------- snapshots backend ---------------- */

    const snapshotsBackend: SnapshotsBackend<TData> = {
        async load(params): Result<SnapshotsLoadResult<TData>> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            return ok({
                head: store.head ? clone(store.head) : undefined,
                draft: store.draft ? clone(store.draft) : undefined,
                snapshot: clone(store.snapshot),
            });
        },
        async autosave(params): Result<{ draft: Draft }> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            store.snapshot = clone(params.snapshot);
            const d: Draft = {
                id: store.draft?.id ?? genId("draft", ++store.counters.version),
                branchId: params.branchId,
                status: "uncommitted",
                etag: `draft-${Date.now()}`,
                createdAt: store.draft?.createdAt ?? nowIso(),
                updatedAt: nowIso(),
            };
            store.draft = d;
            return ok({ draft: clone(d) });
        },
        async save(params): Result<{ commit: Commit }> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            store.snapshot = clone(params.snapshot);
            const commit: Commit = {
                id: genId("commit", ++store.counters.version),
                branchId: params.branchId,
                message: params.message ?? "Save (memory)",
                versionId: genId("version", ++store.counters.version),
                etag: `etag-${Date.now()}`,
                createdAt: nowIso(),
            };
            store.head = commit;
            store.draft = undefined;
            const tgt = store.branches.find((b) => b.id === params.branchId);
            if (tgt) {
                tgt.headVersionId = commit.versionId;
                tgt.updatedAt = nowIso();
            }
            return ok({ commit: clone(commit) });
        },
        async publish(params): Result<{ commit: Commit }> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            if (!store.draft || store.draft.id !== params.draftId)
                return err("not_found", "Draft not found");
            const commit: Commit = {
                id: genId("commit", ++store.counters.version),
                branchId: store.draft.branchId,
                message: params.message ?? "Publish (memory)",
                versionId: genId("version", ++store.counters.version),
                etag: `etag-${Date.now()}`,
                createdAt: nowIso(),
            };
            store.head = commit;
            store.draft = undefined;
            const tgt = store.branches.find((b) => b.id === commit.branchId);
            if (tgt) {
                tgt.headVersionId = commit.versionId;
                tgt.updatedAt = nowIso();
            }
            return ok({ commit: clone(commit) });
        },
        async discard(params): Result<void> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            if (!store.draft || store.draft.id !== params.draftId)
                return err("not_found", "Draft not found");
            store.draft = undefined;
            return ok(undefined);
        },
        async refresh(params): Result<{ head?: Commit; draft?: Draft }> {
            if (params.workspaceId !== store.workspaceId)
                return err("bad_workspace", "Unknown workspace id");
            return ok({
                head: store.head ? clone(store.head) : undefined,
                draft: store.draft ? clone(store.draft) : undefined,
            });
        },
    };

    /* ---------------- deprecated assets shim (for old callers) ---------------- */

    const assetsShim: AssetsBackendShim = {
        async list(params: AssetsListParamsShim): Result<readonly Asset[]> {
            const res = await templatesBackend.list({
                workspaceId: params.workspaceId,
                branchId: params.branchId,
                since: params.since,
            });
            return res.ok ? ok(res.value as readonly Asset[]) : res;
        },
        async get(assetId: string): Result<Asset | null> {
            const res = await templatesBackend.get(assetId);
            return res.ok ? ok((res.value as Asset) ?? null) : res;
        },
        async rename(assetId: string, name: string): Result<Asset> {
            const res = await templatesBackend.update(assetId, { name });
            return res.ok ? ok(res.value as Asset) : res;
        },
        async move(
            assetId: string,
            to: Readonly<{ branchId?: string }>,
        ): Result<Asset> {
            const res = await templatesBackend.update(assetId, {
                branchId: to.branchId ?? null,
            });
            return res.ok ? ok(res.value as Asset) : res;
        },
        async delete(assetId: string): Result<void> {
            return templatesBackend.delete(assetId);
        },
        async url(
            _assetId: string,
            _kind?: "view" | "download" | "thumb",
        ): Result<string> {
            // Not applicable for templates
            return ok("");
        },
        async refresh(
            params: Omit<AssetsListParamsShim, "q">,
        ): Result<readonly Asset[]> {
            const res = await templatesBackend.refresh({
                workspaceId: params.workspaceId,
                branchId: params.branchId,
                since: params.since,
            });
            return res.ok ? ok(res.value as readonly Asset[]) : res;
        },
        async upload(_params: AssetsUploadParamsShim): Result<Asset> {
            return err(
                "not_supported",
                "Upload is not supported for templates",
            );
        },
    };

    /* ---------------- compose backend ---------------- */

    const backend: WorkspaceBackend<TData> = {
        authors: authorsBackend,
        permissions: permissionsBackend,
        branches: branchesBackend,
        templates: templatesBackend,
        snapshots: snapshotsBackend,
        assets: assetsShim, // deprecated shim, present for compatibility
    };

    return backend;
}
