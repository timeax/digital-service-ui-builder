import type {ServiceProps} from './index';

export type CommentNode = {
    id: string;
    text: string;
    status: 'open' | 'resolved';
    anchor?: { kind: 'tag' | 'field' | 'option'; id: string };
    replies?: Array<{ id: string; text: string; created_at: string; author?: string }>;
    xy?: { x: number; y: number };
    meta?: Record<string, unknown>;
};

export type NodePosition = { id: string; x: number; y: number };
export type EdgeRoute = { id: string; points: Array<{ x: number; y: number }> };
export type LayoutState = { nodes: NodePosition[]; edges?: EdgeRoute[] };

export type EditorSnapshot = {
    props: ServiceProps;
    layout?: LayoutState;
    comments?: CommentNode[];
    meta?: Record<string, unknown>;
};