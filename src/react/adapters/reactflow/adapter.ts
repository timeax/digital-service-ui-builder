import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    Node,
    Edge,
    OnConnect,
    OnEdgesChange,
    OnNodesChange,
    Viewport as RFViewport,
    IsValidConnection,
    Connection,
    OnConnectStart,
    OnConnectEnd,
} from "reactflow";
import type { CanvasAPI } from "../../canvas/api";
import type { CanvasState } from "../../../schema/canvas-types";
import type { EdgeKind } from "../../../schema/graph";
import { CommentThread } from "../../canvas/comments";

/* ───────────────────────────── Types & options ───────────────────────────── */

export type AdapterOptions = {
    // validation & policy
    beforeConnect?: (arg: {
        from: string;
        to: string;
        kind: EdgeKind;
        api: CanvasAPI;
    }) => { ok: boolean; reason?: string };
    afterConnect?: (arg: {
        from: string;
        to: string;
        kind: EdgeKind;
        created: boolean;
        api: CanvasAPI;
    }) => void;
    // behavior
    allowEdgeDelete?: boolean; // (reserved) host-level handling
    enableShortcuts?: boolean; // reserved (keyboard to be added in wrapper)
    // snapping & perf
    snapToGrid?: boolean | { x: number; y: number };
    throttleMs?: number; // default 80ms
    // mapping/decoration
    nodeDecorators?: (nodeId: string) => Partial<Node>;
    edgeDecorators?: (edgeId: string) => Partial<Edge>;
};

type RFModel = { nodes: Node[]; edges: Edge[] };

/* ───────────────────────────── Utilities ───────────────────────────── */

function rafThrottle<T extends (...args: any[]) => void>(fn: T, minMs = 80): T {
    let frame = 0;
    let last = 0;
    let queuedArgs: any[] | null = null;

    const run = (now: number) => {
        frame = 0;
        last = now;
        const args = queuedArgs!;
        queuedArgs = null;
        fn(...(args as Parameters<T>));
    };

    return ((...args: any[]) => {
        queuedArgs = args;
        const now = performance.now();
        if (!frame) {
            if (now - last >= minMs) {
                run(now);
            } else {
                frame = requestAnimationFrame(run);
            }
        }
    }) as T;
}

const isCommentId = (id: string) => id.startsWith("c::");

/* ───────────────────────────── Mapping helpers ───────────────────────────── */

function commentPosition(
    th: CommentThread,
    state: CanvasState,
): { x: number; y: number } {
    const a = th.anchor;
    if (a.type === "free") return { x: a.position.x, y: a.position.y };
    if (a.type === "node") {
        const base = state.positions[a.nodeId] ?? { x: 0, y: 0 };
        const dx = a.offset?.dx ?? 32;
        const dy = a.offset?.dy ?? -16;
        return { x: base.x + dx, y: base.y + dy };
    }
    // edge-anchored: simple fallback (edge geometry not available here)
    return { x: 0, y: 0 };
}

function commentNodes(state: CanvasState, api: CanvasAPI): Node[] {
    return api.comments.list().map((th) => ({
        id: `c::${th.id}`,
        type: "comment",
        position: commentPosition(th, state),
        draggable: true,
        selectable: true,
        data: { thread: th },
    }));
}

function toRF(
    state: CanvasState,
    api: CanvasAPI,
    opts?: AdapterOptions,
): RFModel {
    const nodes: Node[] = state.graph.nodes.map((n) => {
        const base: Node = {
            id: n.id,
            type: n.kind,
            data: { node: n },
            position: state.positions[n.id] ?? { x: 0, y: 0 },
            selected: state.selection.has(n.id),
        };
        return opts?.nodeDecorators
            ? { ...base, ...(opts.nodeDecorators(n.id) ?? {}) }
            : base;
    });

    const edges: Edge[] = state.graph.edges.map((e) => {
        const id = `${e.kind}:${e.from}->${e.to}`;
        const base: Edge = {
            id,
            source: e.from,
            target: e.to,
            type: e.kind,
            data: { edge: e },
            // @ts-ignore
            selectable: true,
        };
        return opts?.edgeDecorators
            ? { ...base, ...(opts.edgeDecorators(id) ?? {}) }
            : base;
    });

    nodes.push(...commentNodes(state, api));
    return { nodes, edges };
}

// put this helper near the top of the file (not exported)
const parseEdgeId = (
    id: string,
): { kind: EdgeKind; from: string; to: string } | null => {
    const [k, rest ] = id.split(":");
    if (!k || !rest) return null;
    const [from, to] = rest.split("->");
    if (!from || !to) return null;
    return { kind: k as EdgeKind, from, to };
};
/* ───────────────────────────── Hook ───────────────────────────── */

export function useReactFlowAdapter(
    api: CanvasAPI,
    options: AdapterOptions = {},
) {
    const opts = { throttleMs: 80, ...options };

    const [rf, setRF] = useState<RFModel>(() =>
        toRF(api.snapshot(), api, opts),
    );
    const relRef = useRef<EdgeKind>(api.getEdgeRel());
    const dragStartRef = useRef<{ from?: string } | null>(null);

    // keep a snap vector for RF prop passthrough
    const snapVector = useMemo<[number, number] | undefined>(() => {
        if (!opts.snapToGrid) return undefined;
        if (opts.snapToGrid === true) return [8, 8];
        return [opts.snapToGrid.x || 8, opts.snapToGrid.y || 8];
    }, [opts.snapToGrid]);

    useEffect(() => {
        const toModel = () => setRF(toRF(api.snapshot(), api, opts));
        const offState = api.on("state:change", toModel);
        const offGraph = api.on("graph:update", toModel);
        const offC1 = api.on("comment:thread:create", toModel);
        const offC2 = api.on("comment:thread:update", toModel);
        const offC3 = api.on("comment:thread:delete", toModel);
        const offC4 = api.on("comment:move", toModel);
        const offC5 = api.on("comment:resolve", toModel);
        return () => {
            offState();
            offGraph();
            offC1();
            offC2();
            offC3();
            offC4();
            offC5();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, opts.nodeDecorators, opts.edgeDecorators]);

    /* ── handlers ── */

    const applySnap = useCallback(
        (p: { x: number; y: number }) => {
            if (!opts.snapToGrid) return p;
            const [gx, gy] = snapVector ?? [8, 8];
            return {
                x: Math.round(p.x / gx) * gx,
                y: Math.round(p.y / gy) * gy,
            };
        },
        [opts.snapToGrid, snapVector],
    );

    const setPositionsThrottled = useMemo(
        () =>
            rafThrottle(
                (pos: Record<string, { x: number; y: number }>) =>
                    api.setPositions(pos),
                opts.throttleMs,
            ),
        [api, opts.throttleMs],
    );

    const setViewportThrottled = useMemo(
        () =>
            rafThrottle(
                (v: RFViewport) =>
                    api.setViewport({ x: v.x, y: v.y, zoom: v.zoom }),
                opts.throttleMs,
            ),
        [api, opts.throttleMs],
    );

    const onNodesChange: OnNodesChange = async (changes) => {
        const posUpdates: Record<string, { x: number; y: number }> = {};
        let selectionDirty = false;
        const keep = new Set(api.getSelection());

        for (const c of changes) {
            if (c.type === "position" && c.position) {
                // Comment dragging → move comment anchor
                if (isCommentId(c.id)) {
                    const threadId = c.id.slice(3);
                    const th = api.comments.get(threadId);
                    if (!th) continue;
                    const a = th.anchor;
                    if (a.type === "free") {
                        await api.comments.move(threadId, {
                            type: "free",
                            position: c.position,
                        });
                    } else if (a.type === "node") {
                        const nodePos = api.snapshot().positions[a.nodeId] ?? {
                            x: 0,
                            y: 0,
                        };
                        await api.comments.move(threadId, {
                            type: "node",
                            nodeId: a.nodeId,
                            offset: {
                                dx: c.position.x - nodePos.x,
                                dy: c.position.y - nodePos.y,
                            },
                        });
                    }
                    continue;
                }
                posUpdates[c.id] = applySnap(c.position);
            } else if (c.type === "select") {
                if (!isCommentId(c.id)) {
                    selectionDirty = true;
                    if (c.selected) keep.add(c.id);
                    else keep.delete(c.id);
                } else {
                    api.selectComments(c.selected ? c.id.slice(3) : undefined);
                }
            }
        }

        if (Object.keys(posUpdates).length) setPositionsThrottled(posUpdates);
        if (selectionDirty) api.select(keep);
    };

    const onEdgesChange: OnEdgesChange = (changes) => {
        const selectedEdgeIds: string[] = [];
        const deletions: Array<{ kind: EdgeKind; from: string; to: string }> =
            [];

        for (const c of changes) {
            if (c.type === "select") {
                if (c.selected) selectedEdgeIds.push(c.id);
            } else if (c.type === "remove") {
                const parsed = parseEdgeId(c.id);
                if (parsed) deletions.push(parsed);
            }
        }

        // Highlight endpoints of selected edges
        if (selectedEdgeIds.length) {
            const endpointIds = new Set<string>();
            for (const id of selectedEdgeIds) {
                const p = parseEdgeId(id);
                if (!p) continue;
                endpointIds.add(p.from);
                endpointIds.add(p.to);
            }
            api.setHighlighted(endpointIds);
        } else {
            api.setHighlighted([]);
        }

        // Bubble delete intents so the host/editor can unbind/include/exclude in Builder
        for (const d of deletions) {
            api.emit("wire:delete" as any, d);
            // or, if you add one later: api.editor.disconnect(d.kind, d.from, d.to)
        }
    };

    const currentRel = () => {
        const k = api.getEdgeRel();
        relRef.current = k;
        return k;
    };

    const isValidConnection: IsValidConnection = (conn: Connection | Edge) => {
        const kind = currentRel();
        const from = conn.source ?? "";
        const to = conn.target ?? "";
        if (!from || !to) return false;
        if (from === to) return false;
        if (isCommentId(from) || isCommentId(to)) return false;
        if (opts.beforeConnect) {
            try {
                return !!opts.beforeConnect({ from, to, kind, api }).ok;
            } catch {
                return false;
            }
        }
        return true;
    };

    const onConnectStart: OnConnectStart = (_, { nodeId }) => {
        if (!nodeId) return;
        dragStartRef.current = { from: nodeId };
        const kind = currentRel();
        api.startWire(nodeId, kind);
    };

    const onConnectEnd: OnConnectEnd = () => {
        dragStartRef.current = null;
        api.cancelWire();
    };

    const onConnect: OnConnect = (params) => {
        const from = params.source!;
        const to = params.target!;
        const kind = currentRel();

        // host validation
        if (opts.beforeConnect) {
            const res = opts.beforeConnect({ from, to, kind, api });
            if (!res.ok) {
                api.cancelWire();
                return;
            }
        }

        api.startWire(from, kind);
        api.commitWire(to);

        try {
            opts.afterConnect?.({ from, to, kind, created: true, api });
        } finally {
            dragStartRef.current = null;
        }
    };

    const onMoveEnd = (_evt: any, viewport: RFViewport) => {
        setViewportThrottled(viewport);
    };

    const onSelectionChange = ({ nodes }: { nodes: Node[]; edges: Edge[] }) => {
        api.select(nodes.map((n) => n.id));
    };

    /* ── helpers for the wrapper (require RF instance, so we expose signatures only) ── */

    return {
        nodes: rf.nodes,
        edges: rf.edges,
        onNodesChange,
        onEdgesChange,
        onConnect,
        onConnectStart,
        onConnectEnd,
        onMoveEnd,
        onSelectionChange,
        isValidConnection,
        snapVector,
    };
}
