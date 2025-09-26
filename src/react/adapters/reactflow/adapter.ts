import {useEffect, useState} from 'react';
import type {
    Node,
    Edge,
    OnConnect,
    OnEdgesChange,
    OnNodesChange,
    EdgeChange,
    Viewport as RFViewport
} from 'reactflow';
import type {CanvasAPI} from '../../canvas/api';
import type {CanvasState} from '../../canvas/types';
import {CommentThread} from "../../canvas/comments";

// Map graph → RF nodes/edges
function commentPosition(th: CommentThread, state: CanvasState): { x: number; y: number } {
    const a = th.anchor;
    if (a.type === 'free') return {x: a.position.x, y: a.position.y};
    if (a.type === 'node') {
        const base = state.positions[a.nodeId] ?? {x: 0, y: 0};
        const dx = a.offset?.dx ?? 32;
        const dy = a.offset?.dy ?? -16;
        return {x: base.x + dx, y: base.y + dy};
    }
    // edge-anchored: simple fallback (could interpolate if you have edge geometry)
    return {x: 0, y: 0};
}

function commentNodes(state: CanvasState, api: CanvasAPI): Node[] {
    return api.comments.list().map(th => ({
        id: `c::${th.id}`,
        type: 'comment',
        position: commentPosition(th, state),
        draggable: true,
        selectable: true,
        data: {thread: th},
    }));
}

function toRF(state: CanvasState, api: CanvasAPI) {
    const nodes: Node[] = state.graph.nodes.map(n => ({
        id: n.id,
        type: n.kind,
        data: {node: n},
        position: state.positions[n.id] ?? {x: 0, y: 0},
        selected: state.selection.has(n.id),
    }));

    const edges = state.graph.edges.map(e => ({
        id: `${e.kind}:${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: e.kind,
        data: {edge: e},
        selectable: true,
    }));

    // add comments on top
    nodes.push(...commentNodes(state, api));
    return {nodes, edges};
}

export function useReactFlowAdapter(api: CanvasAPI) {
    const [rf, setRF] = useState(() => toRF(api.snapshot(), api));

    useEffect(() => {
        const offState = api.on('state:change', (s) => setRF(toRF(s, api)));
        const offGraph = api.on('graph:update', () => setRF(toRF(api.snapshot(), api)));
        const offCom1 = api.on('comment:thread:create', () => setRF(toRF(api.snapshot(), api)));
        const offCom2 = api.on('comment:thread:update', () => setRF(toRF(api.snapshot(), api)));
        const offCom3 = api.on('comment:thread:delete', () => setRF(toRF(api.snapshot(), api)));
        const offCom4 = api.on('comment:move', () => setRF(toRF(api.snapshot(), api)));
        const offCom5 = api.on('comment:resolve', () => setRF(toRF(api.snapshot(), api)));
        return () => {
            offState();
            offGraph();
            offCom1();
            offCom2();
            offCom3();
            offCom4();
            offCom5();
        };
    }, [api]);

    const onNodesChange: OnNodesChange = (changes) => {
        const posUpdates: Record<string, { x: number; y: number }> = {};
        let selectionDirty = false;
        const keep = new Set(api.getSelection());

        for (const c of changes) {
            if (c.type === 'position' && c.position) {
                if (c.id.startsWith('c::')) {
                    // move comment
                    const threadId = c.id.slice(3);
                    const th = api.comments.get(threadId);
                    if (!th) continue;
                    const a = th.anchor;
                    if (a.type === 'free') {
                        api.comments.move(threadId, {type: 'free', position: c.position});
                    } else if (a.type === 'node') {
                        const nodePos = api.snapshot().positions[a.nodeId] ?? {x: 0, y: 0};
                        api.comments.move(threadId, {
                            type: 'node',
                            nodeId: a.nodeId,
                            offset: {dx: c.position.x - nodePos.x, dy: c.position.y - nodePos.y},
                        });
                    }
                    continue;
                }
                posUpdates[c.id] = c.position;
            } else if (c.type === 'select') {
                if (!c.id.startsWith('c::')) {
                    selectionDirty = true;
                    if (c.selected) keep.add(c.id); else keep.delete(c.id);
                } else {
                    // comment selection routed via its own event
                    api.selectComments(c.selected ? c.id.slice(3) : undefined);
                }
            }
        }

        if (Object.keys(posUpdates).length) api.setPositions(posUpdates);
        if (selectionDirty) api.select(keep);
    };
    const onEdgesChange: OnEdgesChange = (_changes: EdgeChange[]) => {
        // You can reflect edge selection similarly if you want
    };

    const onConnect: OnConnect = (params) => {
        // Let host decide what a connection means (bind/include). We just emit via wire API.
        const from = params.source!;
        const to = params.target!;
        api.startWire(from, 'bind' as any);
        api.commitWire(to);
    };

    const onMoveEnd = (_evt: any, viewport: RFViewport) => {
        api.setViewport({x: viewport.x, y: viewport.y, zoom: viewport.zoom});
    };

    const onSelectionChange = ({nodes}: { nodes: Node[]; edges: Edge[] }) => {
        api.select(nodes.map(n => n.id));
    };

    return {
        nodes: rf.nodes,
        edges: rf.edges,
        onNodesChange,
        onEdgesChange,
        onConnect,
        onMoveEnd,
        onSelectionChange,
    };
}