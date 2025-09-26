export type NodeKind = 'tag' | 'field' | 'comment';
export type EdgeKind = 'child' | 'bind' | 'include' | 'exclude' | 'error' | 'anchor';

export type GraphNode = {
    id: string;
    kind: NodeKind;
    bind_type?: 'bound' | 'utility' | null; // for fields: bound vs unbound helper
    errors?: string[];                       // node-local error codes
};

export type GraphEdge = { from: string; to: string; kind: EdgeKind };

export type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };