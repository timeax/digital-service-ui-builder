import type { NodeProps } from "reactflow";

export type NodeKind = "tag" | "field" | "comment" | "option";
export type EdgeKind =
    | "child"
    | "bind"
    | "include"
    | "exclude"
    | "error"
    | "anchor";

export type GraphNode = {
    id: string;
    kind: NodeKind;
    bind_type?: "bound" | "utility" | null; // for fields: bound vs unbound helper
    errors?: string[]; // node-local error codes
    label: string;
};

export type GraphEdge = {
    from: string;
    to: string;
    kind: EdgeKind;
    meta?: Record<string, unknown>;
};

export type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

export type FlowNode = NodeProps<{
    node: GraphNode;
    [x: string]: any;
}>;
