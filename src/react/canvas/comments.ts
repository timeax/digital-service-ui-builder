import type {EventBus} from './events';
import type {CanvasEvents} from './types';
import type {CommentsBackend, Actor, BackendError} from './backend';
import {RetryQueue, type RetryOptions as RetryOpts} from "../../utils/utils/retry-queue";

export type CommentId = string;
export type ThreadId = string;

export type CommentAnchor =
    | { type: 'node'; nodeId: string; offset?: { dx: number; dy: number } }
    | { type: 'edge'; edgeId: string; t?: number }
    | { type: 'free'; position: { x: number; y: number } };

export type CommentMessage = {
    id: CommentId;
    authorId?: string;
    authorName?: string;
    body: string;
    createdAt: number;
    editedAt?: number;
    meta?: Record<string, unknown>;
};

export type CommentThread = {
    id: ThreadId;
    anchor: CommentAnchor;
    resolved: boolean;
    createdAt: number;
    updatedAt: number;
    messages: CommentMessage[];
    meta?: Record<string, unknown>;
    // local sync flags (not persisted by server)
    _sync?: 'pending' | 'synced' | 'error';
};

let __seq = 0;
const newLocalId = (p = 'loc'): string => `${p}_${Date.now().toString(36)}_${(++__seq).toString(36)}`;

type CommentsDeps = {
    backend?: CommentsBackend;
    workspaceId?: string;
    actor?: Actor;
    retry?: RetryOpts;
};

export class CommentsAPI {
    private threads = new Map<ThreadId, CommentThread>();
    private bus: EventBus<CanvasEvents>;
    private deps: CommentsDeps;
    private retry: RetryQueue;

    constructor(bus: EventBus<CanvasEvents>, deps: CommentsDeps = {}) {
        this.bus = bus;
        this.deps = deps;
        this.retry = new RetryQueue(deps.retry);
    }

    private emitSync(op: CanvasEvents['comment:sync']['op'], threadId: string, messageId: string | undefined, status: CanvasEvents['comment:sync']['status'], meta: {
        attempt: number;
        nextDelayMs?: number;
        error?: BackendError | unknown
    }) {
        this.bus.emit('comment:sync', {
            op,
            threadId,
            messageId,
            status,
            attempt: meta.attempt,
            nextDelayMs: meta.nextDelayMs,
            error: meta.error
        });
    }

    /* ─── Persistence bridge ───────────────────────────── */

    async loadAll(): Promise<void> {
        if (!this.deps.backend || !this.deps.workspaceId) return;
        const res = await this.deps.backend.listThreads({workspaceId: this.deps.workspaceId});
        if (!res.ok) {
            this.bus.emit('error', {message: res.error.message, code: res.error.code, meta: res.error.meta});
            return;
        }
        this.threads.clear();
        for (const th of res.data) this.threads.set(th.id, {...th, _sync: 'synced'});
        this.bus.emit('comment:thread:update', {thread: undefined as any}); // signal refresh
    }

    /* ─── Query ─────────────────────────────────────────── */
    list(): CommentThread[] {
        return Array.from(this.threads.values()).sort((a, b) => a.createdAt - b.createdAt);
    }

    get(id: ThreadId): CommentThread | undefined {
        return this.threads.get(id);
    }

    /* ─── Mutations (optimistic if backend present) ─────── */

    async create(anchor: CommentAnchor, initialBody: string, meta?: Record<string, unknown>): Promise<ThreadId> {
        const now = Date.now();
        const localId = newLocalId('t');
        const msgId = newLocalId('m');

        const local: CommentThread = {
            id: localId,
            anchor,
            resolved: false,
            createdAt: now,
            updatedAt: now,
            messages: [{id: msgId, body: initialBody, createdAt: now}],
            meta,
            _sync: this.deps.backend ? 'pending' : 'synced',
        };
        this.threads.set(localId, local);
        this.bus.emit('comment:thread:create', {thread: local});

        if (!this.deps.backend || !this.deps.workspaceId) return localId;

        const performOnce = async () => {
            const res = await this.deps.backend!.createThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {anchor, body: initialBody, meta}
            );
            if (!res.ok) throw res.error;
            // Swap local→server on success
            this.threads.delete(localId);
            const serverTh: CommentThread = {...res.data, _sync: 'synced'};
            this.threads.set(serverTh.id, serverTh);
            this.bus.emit('comment:thread:update', {thread: serverTh});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            // schedule retry
            const jobId = `comments:create_thread:${localId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async (_attempt) => {
                    try {
                        await performOnce();
                        return true;
                    } catch (e) {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('create_thread', localId, undefined, status, meta ?? {attempt: 0}),
            });
            // mark error locally (UI can show badge)
            local._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Create failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: local});
        }

        return localId;
    }

    async reply(threadId: ThreadId, body: string, meta?: Record<string, unknown>): Promise<CommentId> {
        const th = this.ensure(threadId);
        const now = Date.now();
        const localMid = newLocalId('m');
        const localMsg: CommentMessage = {id: localMid, body, createdAt: now, meta};
        th.messages.push(localMsg);
        th.updatedAt = now;
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:message:create', {threadId, message: localMsg});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return localMid;

        const performOnce = async () => {
            const res = await this.deps.backend!.addMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, body, meta}
            );
            if (!res.ok) throw res.error;
            const idx = th.messages.findIndex(m => m.id === localMid);
            if (idx >= 0) th.messages[idx] = res.data;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:add_message:${threadId}:${localMid}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('add_message', threadId, localMid, status, meta ?? {attempt: 0}),
            });
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Reply failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
        return localMid;
    }

    async editMessage(threadId: ThreadId, messageId: CommentId, body: string): Promise<void> {
        const th = this.ensure(threadId);
        const orig = th.messages.find(m => m.id === messageId);
        if (!orig) return;
        const previous = {...orig};
        orig.body = body;
        orig.editedAt = Date.now();
        th.updatedAt = orig.editedAt;
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.editMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, messageId, body}
            );
            if (!res.ok) throw res.error;
            const idx = th.messages.findIndex(m => m.id === messageId);
            if (idx >= 0) th.messages[idx] = res.data;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:edit_message:${threadId}:${messageId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('edit_message', threadId, messageId, status, meta ?? {attempt: 0}),
            });
            // rollback on immediate failure to keep UI honest
            const idx = th.messages.findIndex(m => m.id === messageId);
            if (idx >= 0) th.messages[idx] = previous;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Edit failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async deleteMessage(threadId: ThreadId, messageId: CommentId): Promise<void> {
        const th = this.ensure(threadId);
        const backup = [...th.messages];
        th.messages = th.messages.filter(m => m.id !== messageId);
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.deleteMessage(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, messageId}
            );
            if (!res.ok) throw res.error;
            th._sync = 'synced';
            this.bus.emit('comment:thread:update', {thread: th});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:delete_message:${threadId}:${messageId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('delete_message', threadId, messageId, status, meta ?? {attempt: 0}),
            });
            // rollback UI on immediate failure
            th.messages = backup;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Delete failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async move(threadId: ThreadId, anchor: CommentAnchor): Promise<void> {
        const th = this.ensure(threadId);
        const prev = th.anchor;
        th.anchor = anchor;
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:move', {thread: th});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.moveThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, anchor}
            );
            if (!res.ok) throw res.error;
            this.threads.set(th.id, {...res.data, _sync: 'synced'});
            this.bus.emit('comment:thread:update', {thread: this.threads.get(threadId)!});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:move_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('move_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            th.anchor = prev;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Move failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async resolve(threadId: ThreadId, value = true): Promise<void> {
        const th = this.ensure(threadId);
        const prev = th.resolved;
        th.resolved = value;
        th.updatedAt = Date.now();
        th._sync ??= this.deps.backend ? 'pending' : 'synced';
        this.bus.emit('comment:resolve', {thread: th, resolved: value});
        this.bus.emit('comment:thread:update', {thread: th});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.resolveThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId: th.id, resolved: value}
            );
            if (!res.ok) throw res.error;
            this.threads.set(th.id, {...res.data, _sync: 'synced'});
            this.bus.emit('comment:thread:update', {thread: this.threads.get(threadId)!});
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:resolve_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('resolve_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            th.resolved = prev;
            th._sync = 'error';
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Resolve failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: th});
        }
    }

    async deleteThread(threadId: ThreadId): Promise<void> {
        const prev = this.threads.get(threadId);
        if (!prev) return;
        this.threads.delete(threadId);
        this.bus.emit('comment:thread:delete', {threadId});

        if (!this.deps.backend || !this.deps.workspaceId) return;

        const performOnce = async () => {
            const res = await this.deps.backend!.deleteThread(
                {workspaceId: this.deps.workspaceId!, actor: this.deps.actor},
                {threadId}
            );
            if (!res.ok) throw res.error;
            return true;
        };

        try {
            await performOnce();
        } catch (err) {
            const jobId = `comments:delete_thread:${threadId}`;
            this.retry.enqueue({
                id: jobId,
                perform: async () => {
                    try {
                        await performOnce();
                        return true;
                    } catch {
                        return false;
                    }
                },
                onStatus: (status, meta) => this.emitSync('delete_thread', threadId, undefined, status, meta ?? {attempt: 0}),
            });
            // rollback deletion so user can retry
            this.threads.set(threadId, prev);
            this.bus.emit('error', {
                message: (err as BackendError)?.message ?? 'Delete thread failed',
                code: (err as BackendError)?.code,
                meta: err
            });
            this.bus.emit('comment:thread:update', {thread: prev!});
        }
    }

    // Optional helpers for UI controls
    retryJob(jobId: string): boolean {
        return this.retry.triggerNow(jobId);
    }

    cancelJob(jobId: string): boolean {
        return this.retry.cancel(jobId);
    }

    pendingJobs(): string[] {
        return this.retry.pendingIds();
    }

    /* ─── internal ────────────────────────────────────────── */
    private ensure(threadId: ThreadId): CommentThread {
        const th = this.threads.get(threadId);
        if (!th) throw new Error(`Comment thread not found: ${threadId}`);
        return th;
    }
}