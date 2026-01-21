// src/react/workspace/context/backend/memory/memory-backend.ts

import type {
    Actor,
    Author,
    AuthorsBackend,
    BackendScope,
    Branch,
    BranchAccessBackend,
    BranchParticipant,
    BranchesBackend,
    CommentsBackend,
    Commit,
    Draft,
    FieldTemplate,
    MergeResult,
    PermissionsBackend,
    PermissionsMap,
    ServiceSnapshot,
    ServicesBackend,
    ServicesInput,
    SnapshotsBackend,
    SnapshotsLoadResult,
    TemplatesBackend,
    TemplatesListParams,
    TemplateCreateInput,
    TemplateUpdatePatch,
    WorkspaceBackend,
    WorkspaceInfo,
} from "../backend";

import type {
    CommentAnchor,
    CommentId,
    CommentMessage,
    CommentThread,
    ThreadId,
} from "@/schema/comments";

import {
    bumpEtag,
    newBranchId,
    newCommitId,
    newDraftId,
    newMessageId,
    newTemplateId,
    newTemplateKey,
    newThreadId,
} from "./ids";
import { ok, fail } from "./errors";
import { isoNow } from "./time";
import type {
    CreateMemoryWorkspaceBackendOptions,
    MemoryBackendSeed,
} from "./seed";
import {
    ensureThread,
    findMessageIndex,
    newBranchSnapshotState,
    newCommentsBranchState,
    type MemoryWorkspaceStore,
} from "./store";

function emptySnapshot(): ServiceSnapshot {
    // EditorSnapshot shape is host-defined; keep memory backend generic.
    return {
        schema_version: "1",
        data: {} as unknown as any,
    };
}

function permissivePermissions(): PermissionsMap {
    const handler: ProxyHandler<Record<string, boolean>> = {
        get: (
            _target: Record<string, boolean>,
            prop: string | symbol,
        ): boolean => {
            if (typeof prop === "symbol") return true;
            return true;
        },
        has: (): boolean => true,
        ownKeys: (): ArrayLike<string | symbol> => [],
        getOwnPropertyDescriptor: (): PropertyDescriptor | undefined =>
            undefined,
    };

    const p: PermissionsMap = new Proxy<Record<string, boolean>>(
        {},
        handler,
    ) as unknown as PermissionsMap;
    return p;
}

function normalizeInfo(
    workspaceId: string,
    seed?: Partial<WorkspaceInfo>,
): WorkspaceInfo {
    return {
        id: seed?.id ?? workspaceId,
        name: seed?.name ?? "Memory Workspace",
        description: seed?.description,
        createdAt: seed?.createdAt ?? isoNow(),
        updatedAt: seed?.updatedAt ?? isoNow(),
        meta: seed?.meta,
    };
}

function normalizeBranch(
    input: Partial<Branch> & Pick<Branch, "id" | "name">,
): Branch {
    const createdAt: string = input.createdAt ?? isoNow();
    const updatedAt: string = input.updatedAt ?? createdAt;

    return {
        id: input.id,
        name: input.name,
        isMain: Boolean(input.isMain),
        headVersionId: input.headVersionId,
        createdAt,
        updatedAt,
    };
}

function normalizeAuthor(
    input: Partial<Author> & Pick<Author, "id" | "name">,
): Author {
    return {
        id: input.id,
        name: input.name,
        handle: input.handle,
        avatarUrl: input.avatarUrl,
        meta: input.meta,
        createdAt: input.createdAt ?? isoNow(),
        updatedAt: input.updatedAt ?? isoNow(),
    };
}

function normalizeTemplate(input: any): FieldTemplate {
    const now: string = isoNow();

    const id: string = String(input?.id ?? newTemplateId());
    const key: string = String(input?.key ?? newTemplateKey());

    return {
        id,
        key,
        name: String(input?.name ?? "Template"),
        kind: String(input?.kind ?? "text"),
        branchId: input?.branchId ?? undefined,
        definition: (input?.definition ?? {}) as Readonly<
            Record<string, unknown>
        >,
        defaults: (input?.defaults ?? undefined) as
            | Readonly<Record<string, unknown>>
            | undefined,
        ui: (input?.ui ?? undefined) as
            | Readonly<Record<string, unknown>>
            | undefined,
        validators: (input?.validators ?? undefined) as
            | readonly any[]
            | undefined,
        tags: (input?.tags ?? undefined) as readonly string[] | undefined,
        category: (input?.category ?? undefined) as string | undefined,
        published: Boolean(input?.published ?? true),
        version: Number.isFinite(Number(input?.version))
            ? Number(input.version)
            : 1,
        createdAt: String(input?.createdAt ?? now),
        updatedAt: String(input?.updatedAt ?? now),
    };
}

function matchesSince(
    updatedAt: string | undefined,
    since?: string | number,
): boolean {
    if (!since) return true;
    if (!updatedAt) return false;

    const t: number = Date.parse(updatedAt);
    const s: number =
        typeof since === "number" ? since : Date.parse(String(since));
    if (!Number.isFinite(t) || !Number.isFinite(s)) return true;
    return t >= s;
}

function templateVisibleForBranch(
    tpl: FieldTemplate,
    branchId?: string,
): boolean {
    const tplBid: string | undefined = tpl.branchId ?? undefined;
    if (!branchId) return !tplBid;
    return !tplBid || tplBid === branchId;
}

function seedStore(
    opts: CreateMemoryWorkspaceBackendOptions,
): MemoryWorkspaceStore {
    const seed: MemoryBackendSeed | undefined = opts.seed;

    const store: MemoryWorkspaceStore = {
        info: normalizeInfo(opts.workspaceId, seed?.info),

        authors: new Map<string, Author>(),
        permissionsByActor: new Map<string, PermissionsMap>(),

        branches: new Map<string, Branch>(),
        participantsByBranch: new Map<string, readonly BranchParticipant[]>(),

        services: (seed?.services ?? null) as ServicesInput | null,

        templates: new Map<string, FieldTemplate>(),

        snapshotsByBranch: new Map<string, any>(),

        commentsByBranch: new Map<string, any>(),
    };

    // authors
    if (seed?.authors) {
        for (const a of seed.authors) {
            const na: Author = normalizeAuthor({ ...a });
            store.authors.set(na.id, na);
        }
    }

    // ensure actor-author
    const ensureActorAuthor: boolean = opts.ensureActorAuthor ?? true;
    const actorId: string | undefined = opts.actorId;
    if (ensureActorAuthor && actorId && !store.authors.has(actorId)) {
        store.authors.set(
            actorId,
            normalizeAuthor({
                id: actorId,
                name: seed?.actor?.name ?? "Actor",
                handle: seed?.actor?.meta ? undefined : undefined,
            }),
        );
    }

    // permissions
    if (seed?.permissions) {
        const p: unknown = seed.permissions as unknown;
        if (
            typeof p === "object" &&
            p !== null &&
            !Array.isArray(p) &&
            Object.values(p as Record<string, unknown>).every(
                (v: unknown) => typeof v === "object" && v !== null,
            )
        ) {
            const perActor: Record<string, PermissionsMap> = p as Record<
                string,
                PermissionsMap
            >;
            for (const [k, v] of Object.entries(perActor)) {
                store.permissionsByActor.set(k, v);
            }
        } else {
            store.permissionsByActor.set(
                "*",
                seed.permissions as PermissionsMap,
            );
        }
    }

    // branches
    if (seed?.branches) {
        for (const b of seed.branches) {
            const nb: Branch = normalizeBranch({ ...b });
            store.branches.set(nb.id, nb);
        }
    }

    const ensureMain: boolean = opts.ensureMain ?? true;
    if (ensureMain) {
        if (store.branches.size === 0) {
            const id: string = newBranchId();
            store.branches.set(
                id,
                normalizeBranch({
                    id,
                    name: "main",
                    isMain: true,
                }),
            );
        } else {
            const branches: Branch[] = Array.from(store.branches.values());
            const hasMain: boolean = branches.some((b: Branch) => b.isMain);
            if (!hasMain) {
                const first: Branch = branches[0];
                store.branches.set(first.id, { ...first, isMain: true });
            }
        }
    }

    // participants
    if (seed?.participants) {
        for (const [branchId, list] of Object.entries(seed.participants)) {
            store.participantsByBranch.set(branchId, list);
        }
    }

    // templates
    if (seed?.templates) {
        for (const t of seed.templates) {
            const nt: FieldTemplate = normalizeTemplate(t);
            store.templates.set(nt.id, nt);
        }
    }

    // snapshots
    for (const b of store.branches.values()) {
        store.snapshotsByBranch.set(b.id, newBranchSnapshotState());
    }
    if (seed?.snapshots) {
        for (const [branchId, snapSeed] of Object.entries(seed.snapshots)) {
            const state =
                store.snapshotsByBranch.get(branchId) ??
                newBranchSnapshotState();

            if (snapSeed.head) {
                state.head = { ...snapSeed.head };
                state.commits.set(snapSeed.head.id, {
                    commit: { ...snapSeed.head },
                    snapshot: snapSeed.snapshot ?? emptySnapshot(),
                });
                state.headSnapshot = snapSeed.snapshot ?? emptySnapshot();
            } else if (snapSeed.snapshot) {
                state.headSnapshot = snapSeed.snapshot;
            }

            if (snapSeed.draft) {
                const aId: string = opts.actorId ?? "actor";
                state.drafts.set(aId, {
                    draft: { ...snapSeed.draft },
                    snapshot: snapSeed.snapshot ?? emptySnapshot(),
                });
            }

            store.snapshotsByBranch.set(branchId, state);
        }
    }

    // comments
    for (const b of store.branches.values()) {
        store.commentsByBranch.set(b.id, newCommentsBranchState());
    }
    if (seed?.comments) {
        for (const [branchId, threads] of Object.entries(seed.comments)) {
            const st =
                store.commentsByBranch.get(branchId) ??
                newCommentsBranchState();
            st.threads.clear();
            for (const th of threads) {
                st.threads.set(th.id as ThreadId, th);
            }
            store.commentsByBranch.set(branchId, st);
        }
    }

    return store;
}

export function createMemoryWorkspaceBackend(
    opts: CreateMemoryWorkspaceBackendOptions,
): WorkspaceBackend {
    const store: MemoryWorkspaceStore = seedStore(opts);

    const info: WorkspaceInfo = store.info;

    const authors: AuthorsBackend = {
        list: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            return ok(Array.from(store.authors.values()));
        },
        get: async (authorId: string) => {
            const a: Author | undefined = store.authors.get(authorId);
            return ok(a ?? null);
        },
        refresh: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            return ok(Array.from(store.authors.values()));
        },
    };

    const permissions: PermissionsBackend = {
        get: async (workspaceId: string, actor: Actor) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const seeded: PermissionsMap | undefined =
                store.permissionsByActor.get(actor.id) ??
                store.permissionsByActor.get("*") ??
                undefined;

            return ok(seeded ?? permissivePermissions());
        },
        refresh: async (workspaceId: string, actor: Actor) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const seeded: PermissionsMap | undefined =
                store.permissionsByActor.get(actor.id) ??
                store.permissionsByActor.get("*") ??
                undefined;

            return ok(seeded ?? permissivePermissions());
        },
    };

    const branches: BranchesBackend = {
        list: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            return ok(Array.from(store.branches.values()));
        },

        create: async (
            workspaceId: string,
            name: string,
            opts2?: Readonly<{ fromId?: string }>,
        ) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const id: string = newBranchId();
            const b: Branch = normalizeBranch({
                id,
                name,
                isMain: false,
            });

            store.branches.set(id, b);
            store.snapshotsByBranch.set(id, newBranchSnapshotState());
            store.commentsByBranch.set(id, newCommentsBranchState());

            // optional: copy snapshot from fromId
            if (opts2?.fromId) {
                const from = store.snapshotsByBranch.get(opts2.fromId);
                const to = store.snapshotsByBranch.get(id);
                if (from && to) {
                    const snap: ServiceSnapshot =
                        from.headSnapshot ??
                        (from.head
                            ? from.commits.get(from.head.id)?.snapshot
                            : undefined) ??
                        emptySnapshot();

                    to.headSnapshot = snap;
                    const cmId: string = newCommitId();
                    const commit: Commit = {
                        id: cmId,
                        branchId: id,
                        createdAt: isoNow(),
                        versionId: cmId,
                    };
                    to.head = commit;
                    to.commits.set(cmId, { commit, snapshot: snap });
                    store.branches.set(id, {
                        ...b,
                        headVersionId: cmId,
                        updatedAt: isoNow(),
                    });
                }
            }

            return ok(store.branches.get(id)!);
        },

        setMain: async (workspaceId: string, branchId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const b: Branch | undefined = store.branches.get(branchId);
            if (!b) return fail("not_found", "Branch not found.");

            for (const br of store.branches.values()) {
                if (br.isMain && br.id !== branchId) {
                    store.branches.set(br.id, {
                        ...br,
                        isMain: false,
                        updatedAt: isoNow(),
                    });
                }
            }
            const next: Branch = { ...b, isMain: true, updatedAt: isoNow() };
            store.branches.set(branchId, next);
            return ok(next);
        },

        merge: async (
            workspaceId: string,
            sourceId: string,
            targetId: string,
        ) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const src: Branch | undefined = store.branches.get(sourceId);
            const tgt: Branch | undefined = store.branches.get(targetId);
            if (!src || !tgt) return fail("not_found", "Branch not found.");

            const srcState = store.snapshotsByBranch.get(sourceId);
            const tgtState = store.snapshotsByBranch.get(targetId);

            if (srcState && tgtState) {
                const snap: ServiceSnapshot =
                    srcState.headSnapshot ??
                    (srcState.head
                        ? srcState.commits.get(srcState.head.id)?.snapshot
                        : undefined) ??
                    emptySnapshot();

                const cmId: string = newCommitId();
                const commit: Commit = {
                    id: cmId,
                    branchId: targetId,
                    createdAt: isoNow(),
                    versionId: cmId,
                    message: `Merged ${sourceId} → ${targetId}`,
                };

                tgtState.head = commit;
                tgtState.headSnapshot = snap;
                tgtState.commits.set(cmId, { commit, snapshot: snap });

                const updated: Branch = {
                    ...tgt,
                    headVersionId: cmId,
                    updatedAt: isoNow(),
                };
                store.branches.set(targetId, updated);
            }

            const res: MergeResult = {
                sourceId,
                targetId,
                conflicts: 0,
                message: "Merged in memory",
            };
            return ok(res);
        },

        delete: async (workspaceId: string, branchId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            store.branches.delete(branchId);
            store.participantsByBranch.delete(branchId);
            store.snapshotsByBranch.delete(branchId);
            store.commentsByBranch.delete(branchId);
            return ok(undefined);
        },

        refresh: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            return ok(Array.from(store.branches.values()));
        },
    };

    const access: BranchAccessBackend = {
        listParticipants: async (workspaceId: string, branchId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const list: readonly BranchParticipant[] =
                store.participantsByBranch.get(branchId) ?? [];
            return ok(list);
        },
        refreshParticipants: async (workspaceId: string, branchId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const list: readonly BranchParticipant[] =
                store.participantsByBranch.get(branchId) ?? [];
            return ok(list);
        },
    };

    const services: ServicesBackend = {
        get: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            if (!store.services) return ok([] as ServicesInput);
            return ok(store.services);
        },
        refresh: async (workspaceId: string) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            if (!store.services) return ok([] as ServicesInput);
            return ok(store.services);
        },
    };

    const templates: TemplatesBackend = {
        list: async (params: TemplatesListParams) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const all: FieldTemplate[] = Array.from(store.templates.values());
            const filtered: FieldTemplate[] = all.filter((t: FieldTemplate) => {
                if (!templateVisibleForBranch(t, params.branchId)) return false;
                if (params.q) {
                    const q: string = params.q.toLowerCase();
                    if (
                        !t.name.toLowerCase().includes(q) &&
                        !t.key.toLowerCase().includes(q)
                    ) {
                        return false;
                    }
                }
                if (params.category && t.category !== params.category)
                    return false;
                if (params.tags && params.tags.length) {
                    const tset: Set<string> = new Set(t.tags ?? []);
                    for (const tag of params.tags) {
                        if (!tset.has(tag)) return false;
                    }
                }
                return !(
                    params.since && !matchesSince(t.updatedAt, params.since)
                );
            });

            return ok(filtered);
        },

        get: async (id: string) => {
            const t: FieldTemplate | undefined = store.templates.get(id);
            return ok(t ?? null);
        },

        getByKey: async (
            workspaceId: string,
            key: string,
            branchId?: string,
        ) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            for (const t of store.templates.values()) {
                if (t.key !== key) continue;
                if (!templateVisibleForBranch(t, branchId)) continue;
                return ok(t);
            }
            return ok(null);
        },

        create: async (workspaceId: string, input: TemplateCreateInput) => {
            if (workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const now: string = isoNow();
            const id: string = newTemplateId();
            const key: string = input.key ?? newTemplateKey();

            const tpl: FieldTemplate = {
                id,
                key,
                name: input.name,
                kind: input.kind,
                branchId: input.branchId ?? undefined,
                definition: input.definition,
                defaults: input.defaults,
                ui: input.ui,
                validators: input.validators,
                tags: input.tags,
                category: input.category,
                published: Boolean(input.published ?? true),
                version: 1,
                createdAt: now,
                updatedAt: now,
            };

            store.templates.set(id, tpl);
            return ok(tpl);
        },

        update: async (id: string, patch: TemplateUpdatePatch) => {
            const prev: FieldTemplate | undefined = store.templates.get(id);
            if (!prev) return fail("not_found", "Template not found.");

            const now: string = isoNow();

            const next: FieldTemplate = {
                ...prev,
                name: patch.name ?? prev.name,
                kind: patch.kind ?? prev.kind,
                branchId:
                    patch.branchId === null
                        ? undefined
                        : (patch.branchId ?? prev.branchId),
                definition: patch.definition ?? prev.definition,
                defaults:
                    patch.defaults === null
                        ? undefined
                        : (patch.defaults ?? prev.defaults),
                ui: patch.ui === null ? undefined : (patch.ui ?? prev.ui),
                validators:
                    patch.validators === null
                        ? undefined
                        : (patch.validators ?? prev.validators),
                tags:
                    patch.tags === null ? undefined : (patch.tags ?? prev.tags),
                category:
                    patch.category === null
                        ? undefined
                        : (patch.category ?? prev.category),
                published: patch.published ?? prev.published,
                version: prev.version + 1,
                updatedAt: now,
            };

            store.templates.set(id, next);
            return ok(next);
        },

        clone: async (
            source: Readonly<{ id?: string; key?: string }>,
            opts2?: Readonly<{
                newKey?: string;
                name?: string;
                branchId?: string;
                asDraft?: boolean;
            }>,
        ) => {
            const src: FieldTemplate | undefined = source.id
                ? store.templates.get(source.id)
                : undefined;

            let byKey: FieldTemplate | undefined = undefined;
            if (!src && source.key) {
                for (const t of store.templates.values()) {
                    if (t.key === source.key) {
                        byKey = t;
                        break;
                    }
                }
            }

            const base: FieldTemplate | undefined = src ?? byKey;
            if (!base) return fail("not_found", "Template source not found.");

            const now: string = isoNow();
            const id: string = newTemplateId();
            const key: string = opts2?.newKey ?? newTemplateKey();

            const next: FieldTemplate = {
                ...base,
                id,
                key,
                name: opts2?.name ?? `${base.name} (copy)`,
                branchId: opts2?.branchId ?? base.branchId,
                version: 1,
                createdAt: now,
                updatedAt: now,
                published: opts2?.asDraft ? false : base.published,
            };

            store.templates.set(id, next);
            return ok(next);
        },

        publish: async (id: string) => {
            const t: FieldTemplate | undefined = store.templates.get(id);
            if (!t) return fail("not_found", "Template not found.");
            const next: FieldTemplate = {
                ...t,
                published: true,
                updatedAt: isoNow(),
            };
            store.templates.set(id, next);
            return ok(next);
        },

        unpublish: async (id: string) => {
            const t: FieldTemplate | undefined = store.templates.get(id);
            if (!t) return fail("not_found", "Template not found.");
            const next: FieldTemplate = {
                ...t,
                published: false,
                updatedAt: isoNow(),
            };
            store.templates.set(id, next);
            return ok(next);
        },

        delete: async (id: string) => {
            store.templates.delete(id);
            return ok(undefined);
        },

        refresh: async (
            params: Omit<TemplatesListParams, "q" | "tags" | "category">,
        ) => {
            return templates.list({ ...params });
        },
    };

    const snapshots: SnapshotsBackend = {
        load: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const st = store.snapshotsByBranch.get(params.branchId);
            if (!st) return fail("not_found", "Branch not found.");

            const draftEntry = st.drafts.get(params.actorId);
            const headEntry = st.head ? st.commits.get(st.head.id) : undefined;

            // if versionId requested, try commit map
            if (params.versionId) {
                const v = st.commits.get(params.versionId);
                if (v) {
                    const out: SnapshotsLoadResult = {
                        head: st.head,
                        draft: draftEntry?.draft,
                        snapshot: v.snapshot,
                    };
                    return ok(out);
                }
            }

            const snapshot: ServiceSnapshot = (draftEntry?.snapshot ??
                headEntry?.snapshot ??
                st.headSnapshot ??
                emptySnapshot()) as ServiceSnapshot;

            const out: SnapshotsLoadResult = {
                head: st.head,
                draft: draftEntry?.draft,
                snapshot,
            };
            return ok(out);
        },

        autosave: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const st = store.snapshotsByBranch.get(params.branchId);
            if (!st) return fail("not_found", "Branch not found.");

            const prev = st.drafts.get(params.actorId);
            if (
                params.etag &&
                prev?.draft.etag &&
                params.etag !== prev.draft.etag
            ) {
                return fail("etag_mismatch", "Draft etag mismatch.", {
                    meta: { expected: prev.draft.etag, got: params.etag },
                });
            }

            const now: string = isoNow();
            const draftId: string = prev?.draft.id ?? newDraftId();
            const nextEtag: string = bumpEtag(prev?.draft.etag);

            const draft: Draft = {
                id: draftId,
                branchId: params.branchId,
                status: "uncommitted",
                etag: nextEtag,
                meta: prev?.draft.meta,
                createdAt: prev?.draft.createdAt ?? now,
                updatedAt: now,
            };

            st.drafts.set(params.actorId, { draft, snapshot: params.snapshot });

            return ok({ draft });
        },

        save: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const st = store.snapshotsByBranch.get(params.branchId);
            if (!st) return fail("not_found", "Branch not found.");

            // optional etag check against draft if draftId provided
            if (params.draftId) {
                const entry = st.drafts.get(params.actorId);
                if (entry && entry.draft.id === params.draftId) {
                    if (
                        params.etag &&
                        entry.draft.etag &&
                        params.etag !== entry.draft.etag
                    ) {
                        return fail("etag_mismatch", "Draft etag mismatch.", {
                            meta: {
                                expected: entry.draft.etag,
                                got: params.etag,
                            },
                        });
                    }
                }
            }

            const id: string = newCommitId();
            const commit: Commit = {
                id,
                branchId: params.branchId,
                message: params.message,
                versionId: id,
                etag: bumpEtag(undefined),
                createdAt: isoNow(),
            };

            st.commits.set(id, { commit, snapshot: params.snapshot });
            st.head = commit;
            st.headSnapshot = params.snapshot;

            // update branch head pointer
            const b: Branch | undefined = store.branches.get(params.branchId);
            if (b) {
                store.branches.set(params.branchId, {
                    ...b,
                    headVersionId: id,
                    updatedAt: isoNow(),
                });
            }

            // if saving from a draft, keep draft (user may still publish) unless you want to clear:
            // We keep it for now to avoid surprise data loss.

            return ok({ commit });
        },

        publish: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            // locate draft by id across branches for this actor
            let foundBranchId: string | null = null;
            let foundEntry: { draft: Draft; snapshot: ServiceSnapshot } | null =
                null;

            for (const [bid, st] of store.snapshotsByBranch.entries()) {
                const entry = st.drafts.get(params.actorId);
                if (entry && entry.draft.id === params.draftId) {
                    foundBranchId = bid;
                    foundEntry = entry;
                    break;
                }
            }

            if (!foundBranchId || !foundEntry) {
                return fail("not_found", "Draft not found.");
            }

            const st = store.snapshotsByBranch.get(foundBranchId)!;

            const id: string = newCommitId();
            const commit: Commit = {
                id,
                branchId: foundBranchId,
                message: params.message,
                versionId: id,
                etag: bumpEtag(undefined),
                createdAt: isoNow(),
            };

            st.commits.set(id, { commit, snapshot: foundEntry.snapshot });
            st.head = commit;
            st.headSnapshot = foundEntry.snapshot;

            // clear that draft
            st.drafts.delete(params.actorId);

            // update branch
            const b: Branch | undefined = store.branches.get(foundBranchId);
            if (b) {
                store.branches.set(foundBranchId, {
                    ...b,
                    headVersionId: id,
                    updatedAt: isoNow(),
                });
            }

            return ok({ commit });
        },

        discard: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            // find branch containing the draft
            for (const st of store.snapshotsByBranch.values()) {
                const entry = st.drafts.get(params.actorId);
                if (entry && entry.draft.id === params.draftId) {
                    st.drafts.delete(params.actorId);
                    return ok(undefined);
                }
            }

            return fail("not_found", "Draft not found.");
        },

        refresh: async (params) => {
            if (params.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");

            const st = store.snapshotsByBranch.get(params.branchId);
            if (!st) return fail("not_found", "Branch not found.");

            const draft = st.drafts.get(params.actorId)?.draft;
            const head = st.head;

            return ok({ head, draft });
        },
    };

    function ensureThreadContext(ctx: BackendScope, threadId: string) {
        if (ctx.workspaceId !== info.id)
            return fail("not_found", "Workspace not found.");
        const st =
            store.commentsByBranch.get(ctx.branchId) ??
            newCommentsBranchState();
        store.commentsByBranch.set(ctx.branchId, st);

        const th: CommentThread = ensureThread(
            st,
            threadId as ThreadId,
        );
        const nowN: number = Date.now();
        return ok({ st, th, nowN });
    }

    const commentsImpl: CommentsBackend<
        CommentThread,
        CommentMessage,
        CommentAnchor
    > = {
        listThreads: async (ctx: BackendScope) => {
            if (ctx.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const st =
                store.commentsByBranch.get(ctx.branchId) ??
                newCommentsBranchState();
            store.commentsByBranch.set(ctx.branchId, st);

            const list: readonly CommentThread[] = Array.from(
                st.threads.values(),
            );
            return ok(list);
        },

        createThread: async (ctx: BackendScope, input) => {
            if (ctx.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const st =
                store.commentsByBranch.get(ctx.branchId) ??
                newCommentsBranchState();
            store.commentsByBranch.set(ctx.branchId, st);

            const nowN: number = Date.now();
            const threadId: ThreadId = newThreadId() as ThreadId;
            const msgId: CommentId = newMessageId() as CommentId;

            const th: CommentThread = {
                id: threadId,
                anchor: input.anchor,
                resolved: false,
                createdAt: nowN as any,
                updatedAt: nowN as any,
                messages: [
                    {
                        id: msgId,
                        body: input.body,
                        createdAt: nowN as any,
                        meta: input.meta,
                    } as CommentMessage,
                ],
                meta: input.meta,
            } as CommentThread;

            st.threads.set(threadId, th);
            return ok(th);
        },

        addMessage: async (ctx: BackendScope, input) => {
            const res = ensureThreadContext(ctx, input.threadId);
            if (!res.ok) return res;
            const { st, th, nowN } = res.value;

            const msg: CommentMessage = {
                id: newMessageId() as CommentId,
                body: input.body,
                createdAt: nowN as any,
                meta: input.meta,
            } as CommentMessage;

            const msgs: CommentMessage[] = [
                ...((th.messages ?? []) as CommentMessage[]),
                msg,
            ];
            const next: CommentThread = {
                ...(th as object),
                messages: msgs,
                updatedAt: nowN as any,
            } as CommentThread;

            st.threads.set(th.id as ThreadId, next);
            return ok(msg);
        },

        editMessage: async (ctx: BackendScope, input) => {
            const res = ensureThreadContext(ctx, input.threadId);
            if (!res.ok) return res;
            const { st, th, nowN } = res.value;

            const idx: number = findMessageIndex(
                th,
                input.messageId as CommentId,
            );
            if (idx < 0) return fail("not_found", "Message not found.");

            const msgs: CommentMessage[] = [
                ...((th.messages ?? []) as CommentMessage[]),
            ];
            const prev: CommentMessage = msgs[idx] as CommentMessage;

            const nextMsg: CommentMessage = {
                ...(prev as object),
                body: input.body,
                editedAt: nowN as any,
            } as CommentMessage;

            msgs[idx] = nextMsg;

            const next: CommentThread = {
                ...(th as object),
                messages: msgs,
                updatedAt: nowN as any,
            } as CommentThread;

            st.threads.set(th.id as ThreadId, next);
            return ok(nextMsg);
        },

        deleteMessage: async (ctx: BackendScope, input) => {
            const res = ensureThreadContext(ctx, input.threadId);
            if (!res.ok) return res;
            const { st, th, nowN } = res.value;

            const msgs: CommentMessage[] = (
                (th.messages ?? []) as CommentMessage[]
            ).filter(
                (m: CommentMessage) => m.id !== (input.messageId as CommentId),
            );

            const next: CommentThread = {
                ...(th as object),
                messages: msgs,
                updatedAt: nowN as any,
            } as CommentThread;

            st.threads.set(th.id as ThreadId, next);
            return ok(undefined);
        },

        moveThread: async (ctx: BackendScope, input) => {
            const res = ensureThreadContext(ctx, input.threadId);
            if (!res.ok) return res;
            const { st, th, nowN } = res.value;

            const next: CommentThread = {
                ...(th as object),
                anchor: input.anchor,
                updatedAt: nowN as any,
            } as CommentThread;

            st.threads.set(th.id as ThreadId, next);
            return ok(next);
        },

        resolveThread: async (ctx: BackendScope, input) => {
            const res = ensureThreadContext(ctx, input.threadId);
            if (!res.ok) return res;
            const { st, th, nowN } = res.value;

            const next: CommentThread = {
                ...(th as object),
                resolved: input.resolved,
                updatedAt: nowN as any,
            } as CommentThread;

            st.threads.set(th.id as ThreadId, next);
            return ok(next);
        },

        deleteThread: async (ctx: BackendScope, input) => {
            if (ctx.workspaceId !== info.id)
                return fail("not_found", "Workspace not found.");
            const st =
                store.commentsByBranch.get(ctx.branchId) ??
                newCommentsBranchState();
            store.commentsByBranch.set(ctx.branchId, st);

            st.threads.delete(input.threadId as ThreadId);
            return ok(undefined);
        },
    };

    // WorkspaceBackend.comments expects CommentsBackend (default unknown generics);
    // we return a structurally compatible implementation.
    const comments: WorkspaceBackend["comments"] = commentsImpl;

    const backend: WorkspaceBackend = {
        info,
        authors,
        permissions,
        branches,
        access,
        services,
        templates,
        snapshots,
        comments,
    };

    return backend;
}
