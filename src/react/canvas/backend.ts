// Transport-agnostic backend interfaces the HOST must implement

import type { CommentAnchor, CommentMessage, CommentThread } from "./comments";
import { BackendError } from "@/react/workspace/context/backend";

export { type BackendError } from "@/react/workspace/context/backend";

export type Result<T> =
    | { ok: true; data: T }
    | { ok: false; error: BackendError };

// Minimal identity for annotation; permissions enforced server-side
export type Actor = { id: string; name?: string; avatarUrl?: string };

/**
 * Wire format is intentionally the same shape as headless types, so hosts can
 * pass data through if they like. They may add backend-specific fields via `meta`.
 */
export type CommentThreadDTO = CommentThread;
export type CommentMessageDTO = CommentMessage;

export interface CommentsBackend {
    // Load all threads for a canvas/workspace
    listThreads(ctx: {
        workspaceId: string;
    }): Promise<Result<CommentThreadDTO[]>>;

    // Create thread with initial message
    createThread(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            anchor: CommentAnchor;
            body: string;
            meta?: Record<string, unknown>;
        },
    ): Promise<Result<CommentThreadDTO>>;

    addMessage(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
            body: string;
            meta?: Record<string, unknown>;
        },
    ): Promise<Result<CommentMessageDTO>>;

    editMessage(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
            messageId: string;
            body: string;
        },
    ): Promise<Result<CommentMessageDTO>>;

    deleteMessage(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
            messageId: string;
        },
    ): Promise<Result<void>>;

    moveThread(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
            anchor: CommentAnchor;
        },
    ): Promise<Result<CommentThreadDTO>>;

    resolveThread(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
            resolved: boolean;
        },
    ): Promise<Result<CommentThreadDTO>>;

    deleteThread(
        ctx: { workspaceId: string; actor?: Actor },
        input: {
            threadId: string;
        },
    ): Promise<Result<void>>;
}

export type CanvasBackend = {
    comments?: CommentsBackend;
};

export type CanvasBackendOptions = {
    backend?: CanvasBackend;
    workspaceId?: string; // host-provided scope for loading/saving
    actor?: Actor;
};
