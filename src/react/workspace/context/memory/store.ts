// src/react/workspace/context/backend/memory/store.ts

import type {
    Author,
    Branch,
    BranchParticipant,
    Commit,
    Draft,
    FieldTemplate,
    PermissionsMap,
    ServiceSnapshot,
    ServicesInput,
    WorkspaceInfo,
} from "../backend";

import type {
    CommentAnchor,
    CommentId,
    CommentMessage,
    CommentThread,
    ThreadId,
} from "@/schema/comments";

export interface BranchSnapshotState {
    head?: Commit;
    headSnapshot?: ServiceSnapshot;

    /** drafts keyed by actorId */
    drafts: Map<string, { draft: Draft; snapshot: ServiceSnapshot }>;

    /** commits keyed by commitId (versionId) */
    commits: Map<string, { commit: Commit; snapshot: ServiceSnapshot }>;
}

export interface CommentsBranchState {
    threads: Map<ThreadId, CommentThread>;
    // message index is derived; no separate store needed
}

export interface MemoryWorkspaceStore {
    info: WorkspaceInfo;

    authors: Map<string, Author>;

    /** permissions by actorId */
    permissionsByActor: Map<string, PermissionsMap>;

    branches: Map<string, Branch>;
    participantsByBranch: Map<string, readonly BranchParticipant[]>;

    services: ServicesInput | null;

    templates: Map<string, FieldTemplate>;

    snapshotsByBranch: Map<string, BranchSnapshotState>;

    commentsByBranch: Map<string, CommentsBranchState>;
}

export function newBranchSnapshotState(): BranchSnapshotState {
    return {
        drafts: new Map<string, { draft: Draft; snapshot: ServiceSnapshot }>(),
        commits: new Map<
            string,
            { commit: Commit; snapshot: ServiceSnapshot }
        >(),
    };
}

export function newCommentsBranchState(): CommentsBranchState {
    return {
        threads: new Map<ThreadId, CommentThread>(),
    };
}

// helpers that don’t need to know about backend.ts shapes beyond comment schemas
export function findMessageIndex(
    thread: CommentThread,
    messageId: CommentId,
): number {
    const msgs: readonly CommentMessage[] = (thread.messages ??
        []) as readonly CommentMessage[];
    for (let i: number = 0; i < msgs.length; i += 1) {
        if (msgs[i].id === messageId) return i;
    }
    return -1;
}

export function ensureThread(
    state: CommentsBranchState,
    threadId: ThreadId,
): CommentThread {
    const th: CommentThread | undefined = state.threads.get(threadId);
    if (!th) {
        throw new Error(`Comment thread not found: ${String(threadId)}`);
    }
    return th;
}

export function setThreadAnchor(
    thread: CommentThread,
    anchor: CommentAnchor,
): CommentThread {
    return { ...(thread as object), anchor } as CommentThread;
}
