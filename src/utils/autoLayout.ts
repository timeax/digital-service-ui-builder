/* src/utils/autoLayout.ts
 * ELK.js-powered auto-layout (layered → RIGHT, orthogonal edges)
 * - Preserves already-placed nodes (treat (0,0) as "unplaced" by default)
 * - Places only unpositioned nodes
 * - Exposes optional orthogonal edge routes (waypoints)
 */

import Elk, { ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs";

import type {
    GraphSnapshot,
    GraphNode,
    GraphEdge,
    EdgeKind,
} from "@/schema/graph";

import type { NodePos, NodePositions } from "@/schema/canvas-types";

/* ───────────────────────────── Options & Types ───────────────────────────── */

export type Direction = "RIGHT" | "LEFT" | "DOWN" | "UP";
export type EdgeRouting = "ORTHOGONAL" | "POLYLINE" | "SPLINES" | "UNDEFINED";

export interface AutoLayoutOptions {
    readonly treatZeroZeroAsUnplaced: boolean; // default true
    readonly direction: Direction; // default RIGHT
    readonly edgeRouting: EdgeRouting; // default ORTHOGONAL
    readonly nodeNodeSpacing: number; // default 56
    readonly nodeEdgeSpacing: number; // default 24
    readonly edgeEdgeSpacing: number; // default 16
    readonly componentSpacing: number; // default 64
    readonly padding: {
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
        readonly left: number;
    }; // 48/64/48/64
    readonly commentOffset: { readonly dx: number; readonly dy: number }; // 24/16
}

export interface Size {
    readonly width: number;
    readonly height: number;
}
export type SizeEstimator = (node: GraphNode) => Size;

export interface EdgeRoutePoint {
    readonly x: number;
    readonly y: number;
}
export interface EdgeRoute {
    readonly id: string;
    readonly points: ReadonlyArray<EdgeRoutePoint>;
}

export interface RouteOptions {
    /** Filter which edges to route. Default: route all edges. */
    readonly routeFilter?: (edge: GraphEdge) => boolean;
}

/* ───────────────────────────── Defaults ───────────────────────────── */

const DEFAULT_OPTS: AutoLayoutOptions = {
    treatZeroZeroAsUnplaced: true,
    direction: "RIGHT",
    edgeRouting: "ORTHOGONAL",
    nodeNodeSpacing: 56,
    nodeEdgeSpacing: 24,
    edgeEdgeSpacing: 16,
    componentSpacing: 64,
    padding: { top: 48, right: 64, bottom: 48, left: 64 },
    commentOffset: { dx: 24, dy: 16 },
};

const DEFAULT_SIZE_OF: SizeEstimator = (n: GraphNode): Size => {
    const labelLen: number = Math.min(40, (n.label ?? "").length);
    const baseByKind: Record<GraphNode["kind"], Size> = {
        tag: { width: 220, height: 56 },
        field: { width: 260, height: 48 },
        comment: { width: 220, height: 96 },
        option: { width: 160, height: 40 },
    };
    const base: Size = baseByKind[n.kind] ?? { width: 200, height: 48 };
    const growth: number = 6 * labelLen + (n.kind === "field" ? 40 : 0);
    const optionHint: number =
        n.kind === "field" && /\b(choices|options|select|list)\b/i.test(n.label)
            ? 80
            : 0;

    return {
        width: base.width + growth + optionHint,
        height: base.height,
    };
};

/* ───────────────────────────── Public API ───────────────────────────── */

/**
 * Compute positions for all nodes, preserving already-placed ones (fixed)
 * and placing only previously-unplaced nodes via ELK.
 */
export async function computeAutoLayout(
    graph: GraphSnapshot,
    prev?: NodePositions,
    opts?: Partial<AutoLayoutOptions>,
    sizeOf?: SizeEstimator,
): Promise<NodePositions> {
    const { positions } = await computeAutoLayoutWithRoutes(
        graph,
        prev,
        opts,
        sizeOf,
    );
    return positions;
}

/**
 * Same as computeAutoLayout, but also extracts orthogonal edge routes (waypoints).
 */
export async function computeAutoLayoutWithRoutes(
    graph: GraphSnapshot,
    prev?: NodePositions,
    opts?: Partial<AutoLayoutOptions>,
    sizeOf?: SizeEstimator,
    routeOpts?: RouteOptions,
): Promise<{ positions: NodePositions; routes: EdgeRoute[] }> {
    const elk = new Elk();
    const options: AutoLayoutOptions = { ...DEFAULT_OPTS, ...(opts ?? {}) };
    const measure: SizeEstimator = sizeOf ?? DEFAULT_SIZE_OF;

    const prevPos: NodePositions = prev ?? {};
    const treat00: boolean = options.treatZeroZeroAsUnplaced;

    const isFixed = (id: string): boolean => {
        const p: NodePos | undefined = prevPos[id];
        if (!p) return false;
        return treat00 ? !(p.x === 0 && p.y === 0) : true;
    };

    // Build ELK nodes
    const elkChildren: ElkNode[] = graph.nodes.map((n: GraphNode): ElkNode => {
        const sz: Size = measure(n);
        const fixed: boolean = isFixed(n.id);
        const prevP: NodePos | undefined = prevPos[n.id];

        // Anchor seeding for comments: if comment → anchor(target) and target is fixed, seed near it
        const anchorTargetId: string | null = findAnchorTargetId(graph, n.id);
        const anchorPos: NodePos | undefined =
            anchorTargetId && isFixed(anchorTargetId)
                ? prevPos[anchorTargetId]
                : undefined;

        // Decide initial x/y
        const xSeed: number | undefined = fixed
            ? prevP?.x
            : anchorPos
              ? anchorPos.x + options.commentOffset.dx
              : undefined;
        const ySeed: number | undefined = fixed
            ? prevP?.y
            : anchorPos
              ? anchorPos.y + options.commentOffset.dy
              : undefined;

        const layoutOptions: Record<string, any> = {};
        if (fixed) {
            // Keep previously placed nodes untouched by layout
            layoutOptions["org.eclipse.elk.noLayout"] = true;
        }
        // If we seeded a comment near an anchor, freeze it for stability on this pass
        if (!fixed && n.kind === "comment" && anchorPos) {
            layoutOptions["org.eclipse.elk.noLayout"] = true;
        }

        return {
            id: n.id,
            width: Math.max(10, Math.round(sz.width)),
            height: Math.max(10, Math.round(sz.height)),
            x: xSeed,
            y: ySeed,
            layoutOptions,
        };
    });

    // Build ELK edges (all of them; routing will avoid noLayout nodes)
    const elkEdges: ElkExtendedEdge[] = graph.edges.map(
        (e: GraphEdge, i: number): ElkExtendedEdge => ({
            id: buildEdgeId(e, i),
            sources: [e.from],
            targets: [e.to],
        }),
    );

    // Root ELK graph
    const elkRoot: ElkNode = {
        id: "root",
        layoutOptions: rootLayoutOptions(options),
        children: elkChildren,
        edges: elkEdges,
    };

    const laidOut: ElkNode = await elk.layout(elkRoot, {
        layoutOptions: elkRoot.layoutOptions,
    });

    // Read positions from ELK
    const positions: NodePositions = {};
    for (const child of laidOut.children ?? []) {
        if (
            child.id &&
            typeof child.x === "number" &&
            typeof child.y === "number"
        ) {
            positions[child.id] = { x: child.x, y: child.y };
        }
    }

    // Merge: fixed nodes keep prev; unplaced take ELK coords (fallback to prev or 0,0)
    for (const n of graph.nodes) {
        const wasFixed: boolean = isFixed(n.id);
        const pPrev: NodePos | undefined = prevPos[n.id];
        const pElk: NodePos | undefined = positions[n.id];
        if (wasFixed) {
            positions[n.id] = pPrev ?? pElk ?? { x: 0, y: 0 };
        } else {
            positions[n.id] = pElk ?? pPrev ?? { x: 0, y: 0 };
        }
    }

    // Extract edge routes (waypoints)
    const routes: EdgeRoute[] = extractEdgeRoutes(laidOut, graph, routeOpts);

    return { positions, routes };
}

/** Merge two positions maps (optionally only for previously-unplaced nodes). */
export function mergePositions(
    prev: NodePositions | undefined,
    next: NodePositions,
    args?: {
        readonly onlyUnplaced?: boolean;
        readonly treatZeroZeroAsUnplaced?: boolean;
    },
): NodePositions {
    const onlyUnplaced: boolean = args?.onlyUnplaced ?? true;
    const treat00: boolean = args?.treatZeroZeroAsUnplaced ?? true;

    const out: NodePositions = { ...(prev ?? {}) };

    if (!onlyUnplaced) {
        for (const id of Object.keys(next)) out[id] = next[id];
        return out;
    }

    // Only overwrite when previous was missing/unplaced
    for (const id of Object.keys(next)) {
        const had: NodePos | undefined = prev?.[id];
        const wasUnplaced: boolean =
            !had || (treat00 ? had.x === 0 && had.y === 0 : false);
        if (wasUnplaced) out[id] = next[id];
    }
    return out;
}

/** IDs whose position changed from prev→next (helpful for fitView-on-new-nodes). */
export function placedIdsFrom(
    prev: NodePositions | undefined,
    next: NodePositions,
): string[] {
    const out: string[] = [];
    for (const id of Object.keys(next)) {
        const a: NodePos | undefined = prev?.[id];
        const b: NodePos = next[id];
        if (!a || a.x !== b.x || a.y !== b.y) out.push(id);
    }
    return out;
}

/* ───────────────────────────── Internals ───────────────────────────── */

function rootLayoutOptions(opts: AutoLayoutOptions): LayoutOptions {
    const lo: LayoutOptions = {
        "elk.algorithm": "layered",
        "elk.direction": opts.direction,
        // orthogonal routing gives right-angled bends
        "elk.edgeRouting": opts.edgeRouting,

        // Spacing / padding
        "elk.spacing.nodeNode": String(opts.nodeNodeSpacing),
        "elk.spacing.nodeNodeBetweenLayers": String(opts.nodeNodeSpacing),
        "elk.spacing.nodeEdge": String(opts.nodeEdgeSpacing),
        "elk.spacing.edgeEdge": String(opts.edgeEdgeSpacing),
        "elk.spacing.componentComponent": String(opts.componentSpacing),

        "elk.padding.top": String(opts.padding.top),
        "elk.padding.right": String(opts.padding.right),
        "elk.padding.bottom": String(opts.padding.bottom),
        "elk.padding.left": String(opts.padding.left),

        // Stability: keep model order where possible to reduce jitter
        "org.eclipse.elk.layered.considerModelOrder.strategy":
            "NODES_AND_EDGES",
    };
    return lo;
}

/** Find the *target* of an anchor edge whose source is `nodeId` (first found). */
function findAnchorTargetId(
    graph: GraphSnapshot,
    nodeId: string,
): string | null {
    const e: GraphEdge | undefined = graph.edges.find(
        (ed: GraphEdge) => ed.kind === "anchor" && ed.from === nodeId,
    );
    return e ? e.to : null;
}

function buildEdgeId(e: GraphEdge, i: number): string {
    // Deterministic id; include index to avoid accidental duplicates
    return `${e.from}→${e.to}:${e.kind}#${i}`;
}

/** Extracts orthogonal waypoints from ELK's layout result. */
function extractEdgeRoutes(
    root: ElkNode,
    graph: GraphSnapshot,
    routeOpts?: RouteOptions,
): EdgeRoute[] {
    const routes: EdgeRoute[] = [];
    const seen: Set<string> = new Set<string>();
    const allow: (edge: GraphEdge) => boolean =
        routeOpts?.routeFilter ?? (() => true);

    // Map from elk edge id back to GraphEdge (by index match)
    const elkIdForIndex: (idx: number) => string = (idx: number): string =>
        buildEdgeId(graph.edges[idx], idx);

    // Prefer edges on the root (elk usually places them there), but recurse defensively
    const stack: ElkNode[] = [root];
    while (stack.length) {
        const node: ElkNode = stack.pop() as ElkNode;

        if (node.edges) {
            node.edges.forEach((edge: any, idx: number) => {
                const elkEdgeId: string =
                    typeof edge.id === "string" ? edge.id : elkIdForIndex(idx);
                if (seen.has(elkEdgeId)) return;

                // Find corresponding GraphEdge (best-effort by id or by source/target match)
                const gEdge: GraphEdge | undefined = matchGraphEdge(
                    graph,
                    edge,
                );
                if (gEdge && !allow(gEdge)) return;

                const sections: any[] = Array.isArray(edge.sections)
                    ? edge.sections
                    : [];
                if (!sections.length) return;

                let segIndex = 0;
                for (const section of sections) {
                    const pts: EdgeRoutePoint[] = [];
                    if (section.startPoint)
                        pts.push({
                            x: section.startPoint.x,
                            y: section.startPoint.y,
                        });
                    if (Array.isArray(section.bendPoints)) {
                        for (const bp of section.bendPoints)
                            pts.push({ x: bp.x, y: bp.y });
                    }
                    if (section.endPoint)
                        pts.push({
                            x: section.endPoint.x,
                            y: section.endPoint.y,
                        });

                    if (pts.length >= 2) {
                        const rid: string =
                            segIndex === 0
                                ? elkEdgeId
                                : `${elkEdgeId}:${segIndex}`;
                        routes.push({ id: rid, points: pts });
                        seen.add(rid);
                        segIndex++;
                    }
                }
            });
        }

        if (node.children) {
            for (const c of node.children) stack.push(c);
        }
    }

    return routes;
}

/** Try to map an ELK edge back to a GraphEdge by (source,target,kind) where possible. */
function matchGraphEdge(
    graph: GraphSnapshot,
    elkEdge: any,
): GraphEdge | undefined {
    const from: string | undefined = Array.isArray(elkEdge.sources)
        ? elkEdge.sources[0]
        : undefined;
    const to: string | undefined = Array.isArray(elkEdge.targets)
        ? elkEdge.targets[0]
        : undefined;

    // Quick match by endpoints
    if (from && to) {
        const candidate: GraphEdge | undefined = graph.edges.find(
            (ge) => ge.from === from && ge.to === to,
        );
        if (candidate) return candidate;
    }
    // Fallback: if id embeds kind "…:kind#i", try to recover it
    if (typeof elkEdge.id === "string") {
        const m = elkEdge.id.match(
            /:(child|bind|include|exclude|error|anchor)#\d+$/,
        );
        if (m) {
            const k = m[1] as EdgeKind;
            const byKind = graph.edges.find(
                (ge) => ge.kind === k && ge.from === from && ge.to === to,
            );
            if (byKind) return byKind;
        }
    }
    return undefined;
}
