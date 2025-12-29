import type { GraphSnapshot, GraphNode, GraphEdge, EdgeKind } from "./graph";
import { CommentMessage, CommentThread } from "../react/canvas/comments";

export type Viewport = { x: number; y: number; zoom: number };

export type NodePos = { x: number; y: number };
export type NodePositions = Record<string, NodePos>;

export type DraftWire = { from: string; kind: EdgeKind };

export type CanvasState = {
    graph: GraphSnapshot;
    positions: NodePositions;
    selection: Set<string>;
    highlighted: Set<string>;
    hoverId?: string;
    viewport: Viewport;
    draftWire?: DraftWire;
    version: number; // bump on any state change
};

export type CanvasEvents = {
    "graph:update": GraphSnapshot;
    "state:change": CanvasState;
    "selection:change": { ids: string[] };
    "viewport:change": Viewport;
    "hover:change": { id?: string };
    "wire:preview": { from: string; to?: string; kind: EdgeKind };
    "wire:commit": { from: string; to: string; kind: EdgeKind };
    "wire:cancel": { from: string };
    error: { message: string; code?: string; meta?: any };
    "comment:thread:create": { thread: CommentThread };
    "comment:thread:update": { thread: CommentThread };
    "comment:thread:delete": { threadId: string };
    "comment:message:create": { threadId: string; message: CommentMessage };
    "comment:resolve": { thread: CommentThread; resolved: boolean };
    "comment:move": { thread: CommentThread };
    "comment:select": { threadId?: string };
    "edge:change": EdgeKind;
    "comment:sync": {
        op:
            | "create_thread"
            | "add_message"
            | "edit_message"
            | "delete_message"
            | "move_thread"
            | "resolve_thread"
            | "delete_thread";
        threadId: string;
        messageId?: string;
        status: "scheduled" | "retrying" | "succeeded" | "failed" | "cancelled";
        attempt: number;
        nextDelayMs?: number;
        error?: any;
    };
};

export type NodeView = GraphNode & { position?: NodePos };
export type EdgeView = GraphEdge;

export type CanvasOptions = {
    initialViewport?: Partial<Viewport>;
    autoEmitState?: boolean; // default true
};
