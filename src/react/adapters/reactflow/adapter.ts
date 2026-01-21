// src/react/adapters/reactflow/adapter.ts
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
import { applyNodeChanges, applyEdgeChanges } from "reactflow";
import type { CanvasAPI } from "@/react";
import type { CanvasState } from "@/schema/canvas-types";
import type { EdgeKind } from "@/schema/graph";
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
    allowEdgeDelete?: boolean; // reserved
    enableShortcuts?: boolean; // reserved

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

function sameIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    for (const id of b) if (!s.has(id)) return false;
    return true;
}

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
    opts?: Pick<AdapterOptions, "nodeDecorators" | "edgeDecorators">,
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

// Parse "kind:from->to"
const parseEdgeId = (
    id: string,
): { kind: EdgeKind; from: string; to: string } | null => {
    const [k, rest] = id.split(":");
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
    // derive, don’t mutate incoming options
    const throttleMs = options.throttleMs ?? 80;
    const snapToGridOpt = options.snapToGrid;
    const nodeDecorators = options.nodeDecorators;
    const edgeDecorators = options.edgeDecorators;

    // Stable refs for validation callbacks
    const beforeConnectRef = useRef(options.beforeConnect);
    const afterConnectRef = useRef(options.afterConnect);
    useEffect(() => {
        beforeConnectRef.current = options.beforeConnect;
    }, [options.beforeConnect]);
    useEffect(() => {
        afterConnectRef.current = options.afterConnect;
    }, [options.afterConnect]);

    const [rf, setRF] = useState<RFModel>(() =>
        toRF(api.snapshot(), api, { nodeDecorators, edgeDecorators }),
    );

    const relRef = useRef<EdgeKind>(api.getEdgeRel());
    const dragStartRef = useRef<{ from?: string } | null>(null);
    const lastViewportRef = useRef<RFViewport | null>(null);

    // snap grid tuple
    const snapVector = useMemo<[number, number] | undefined>(() => {
        if (!snapToGridOpt) return undefined;
        if (snapToGridOpt === true) return [8, 8];
        return [snapToGridOpt.x || 8, snapToGridOpt.y || 8];
    }, [snapToGridOpt]);

    // Subscribe to API *structural* changes only.
    // Avoid re-mapping during drag/viewport churn (positions live update locally).
    useEffect(() => {
        const toModel = () =>
            setRF(
                toRF(api.snapshot(), api, { nodeDecorators, edgeDecorators }),
            );

        const offGraph = api.on("graph:update", toModel);
        const offC1 = api.on("comment:thread:create", toModel);
        const offC2 = api.on("comment:thread:update", toModel);
        const offC3 = api.on("comment:thread:delete", toModel);
        const offC4 = api.on("comment:move", toModel);
        const offC5 = api.on("comment:resolve", toModel);

        return () => {
            offGraph();
            offC1();
            offC2();
            offC3();
            offC4();
            offC5();
        };
    }, [api, nodeDecorators, edgeDecorators]);

    /* ── handlers ── */

    const applySnap = useCallback(
        (p: { x: number; y: number }) => {
            if (!snapVector) return p;
            const [gx, gy] = snapVector;
            return {
                x: Math.round(p.x / gx) * gx,
                y: Math.round(p.y / gy) * gy,
            };
        },
        [snapVector],
    );

    const setPositionsThrottled = useMemo(
        () =>
            rafThrottle(
                (pos: Record<string, { x: number; y: number }>) =>
                    api.setPositions(pos),
                throttleMs,
            ),
        [api, throttleMs],
    );

    const setViewportThrottled = useMemo(
        () =>
            rafThrottle(
                (v: RFViewport) =>
                    api.setViewport({ x: v.x, y: v.y, zoom: v.zoom }),
                throttleMs,
            ),
        [api, throttleMs],
    );

    const onNodesChange: OnNodesChange = useCallback(
        async (changes) => {
            // 1) Update RF locally for buttery dragging
            setRF((prev) => ({
                nodes: applyNodeChanges(changes, prev.nodes),
                edges: prev.edges,
            }));

            // 2) Collect batched position + selection updates for API
            const posUpdates: Record<string, { x: number; y: number }> = {};
            let selectionDirty = false;
            const keep = new Set<string>(
                Array.isArray(api.getSelection())
                    ? (api.getSelection() as string[])
                    : Array.from(api.getSelection() as unknown as Set<string>),
            );

            for (const c of changes) {
                if (c.type === "position" && c.position) {
                    // Comment dragging → move comment anchor in API
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
                            const nodePos = api.snapshot().positions[
                                a.nodeId
                            ] ?? { x: 0, y: 0 };
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
                        api.selectComments(
                            c.selected ? c.id.slice(3) : undefined,
                        );
                    }
                }
            }

            if (Object.keys(posUpdates).length)
                setPositionsThrottled(posUpdates);

            if (selectionDirty) {
                const next = Array.from(keep);
                const currRaw = api.getSelection();
                const curr = Array.isArray(currRaw)
                    ? (currRaw as string[])
                    : Array.from(currRaw as Set<string>);
                if (!sameIdSet(next, curr)) {
                    api.select(keep);
                }
            }
        },
        [api, applySnap, setPositionsThrottled],
    );

    const onEdgesChange: OnEdgesChange = useCallback(
        (changes) => {
            // 1) Update RF locally
            setRF((prev) => ({
                nodes: prev.nodes,
                edges: applyEdgeChanges(changes, prev.edges),
            }));

            // 2) Highlight + deletions to API
            const selectedEdgeIds: string[] = [];
            const deletions: Array<{
                kind: EdgeKind;
                from: string;
                to: string;
            }> = [];

            for (const c of changes) {
                if (c.type === "select") {
                    if (c.selected) selectedEdgeIds.push(c.id);
                } else if (c.type === "remove") {
                    const parsed = parseEdgeId(c.id);
                    if (parsed) deletions.push(parsed);
                }
            }

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

            for (const d of deletions) {
                api.emit("wire:delete" as any, d);
            }
        },
        [api],
    );

    const currentRel = useCallback(() => {
        const k = api.getEdgeRel();
        relRef.current = k;
        return k;
    }, [api]);

    const isValidConnection: IsValidConnection = useCallback(
        (conn: Connection | Edge) => {
            const kind = currentRel();
            const from = conn.source ?? "";
            const to = conn.target ?? "";
            if (!from || !to) return false;
            if (from === to) return false;
            if (isCommentId(from) || isCommentId(to)) return false;

            const check = beforeConnectRef.current;
            if (check) {
                try {
                    return !!check({ from, to, kind, api }).ok;
                } catch {
                    return false;
                }
            }
            return true;
        },
        [api, currentRel],
    );

    const onConnectStart: OnConnectStart = useCallback(
        (_, { nodeId }) => {
            if (!nodeId) return;
            dragStartRef.current = { from: nodeId };
            const kind = currentRel();
            api.startWire(nodeId, kind);
        },
        [api, currentRel],
    );

    const onConnectEnd: OnConnectEnd = useCallback(() => {
        dragStartRef.current = null;
        api.cancelWire();
    }, [api]);

    const onConnect: OnConnect = useCallback(
        (params) => {
            const from = params.source!;
            const to = params.target!;
            const kind = currentRel();

            const check = beforeConnectRef.current;
            if (check) {
                const res = check({ from, to, kind, api });
                if (!res.ok) {
                    api.cancelWire();
                    return;
                }
            }

            api.startWire(from, kind);
            api.commitWire(to);
            afterConnectRef.current?.({ from, to, kind, created: true, api });
            dragStartRef.current = null;
        },
        [api, currentRel],
    );

    const onMoveEnd = useCallback(
        (_evt: any, viewport: RFViewport) => {
            const prev = lastViewportRef.current;
            const changed =
                !prev ||
                Math.abs(prev.x - viewport.x) > 0.5 ||
                Math.abs(prev.y - viewport.y) > 0.5 ||
                Math.abs(prev.zoom - viewport.zoom) > 1e-4;

            if (changed) {
                lastViewportRef.current = viewport;
                setViewportThrottled(viewport);
            }
        },
        [setViewportThrottled],
    );

    const onSelectionChange = useCallback(
        ({ nodes }: { nodes: Node[]; edges: Edge[] }) => {
            console.log("onSelectionChange", nodes);
            const next = nodes.map((n) => n.id);
            const currRaw = api.getSelection();
            const curr = Array.isArray(currRaw)
                ? (currRaw as string[])
                : Array.from(currRaw as Set<string>);
            if (sameIdSet(next, curr)) return;
            api.select(next);
        },
        [api],
    );

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
