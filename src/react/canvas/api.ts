import { EventBus } from "./events";
import type {
    CanvasEvents,
    CanvasOptions,
    CanvasState,
    NodePositions,
    Viewport,
    DraftWire,
} from "../../schema/canvas-types";
import type { Builder } from "../../core";
import type { EdgeKind, GraphSnapshot } from "../../schema/graph";
import { CommentsAPI } from "./comments";
import { CanvasBackendOptions } from "./backend";
import { Editor } from "./editor";

export class CanvasAPI {
    private bus = new EventBus<CanvasEvents>();
    private readonly state: CanvasState;
    private builder: Builder;
    public readonly editor: Editor;
    private readonly autoEmit: boolean;
    readonly comments: CommentsAPI;

    constructor(
        builder: Builder,
        opts: CanvasOptions & CanvasBackendOptions = {},
    ) {
        this.builder = builder;
        this.autoEmit = opts.autoEmitState ?? true;

        const graph = builder.tree();
        this.state = {
            graph,
            positions: {},
            selection: new Set(),
            highlighted: new Set(),
            viewport: { x: 0, y: 0, zoom: 1, ...opts.initialViewport },
            version: 1,
        };

        // compose comments with backend (if provided)
        this.comments = new CommentsAPI(this.bus, {
            backend: opts.backend?.comments,
            workspaceId: opts.workspaceId,
            actor: opts.actor,
        });

        this.editor = new Editor(builder, this, {
            serviceMap: builder.getServiceMap(),
            serviceExists: (id) => builder.getServiceMap().hasOwnProperty(id),
            ...opts,
        });

        if (this.autoEmit) this.bus.emit("state:change", this.snapshot());
    }

    /* ─── Events ─────────────────────────────────────────────── */
    on = this.bus.on.bind(this.bus);
    once = this.bus.once.bind(this.bus);

    public emit<K extends keyof CanvasEvents>(
        event: K,
        payload: CanvasEvents[K],
    ): void {
        this.bus.emit(event, payload);
    }

    /* ─── State accessors ───────────────────────────────────── */
    snapshot(): CanvasState {
        // return an immutable-looking view
        return {
            ...this.state,
            selection: new Set(this.state.selection),
            highlighted: new Set(this.state.highlighted),
            graph: {
                nodes: [...this.state.graph.nodes],
                edges: [...this.state.graph.edges],
            },
            positions: { ...this.state.positions },
        };
    }

    getGraph(): GraphSnapshot {
        return this.state.graph;
    }

    getSelection(): string[] {
        return Array.from(this.state.selection);
    }

    getViewport(): Viewport {
        return { ...this.state.viewport };
    }

    /* ─── Graph lifecycle ───────────────────────────────────── */
    refreshGraph(): void {
        this.state.graph = this.builder.tree();
        this.bump();
        this.bus.emit("graph:update", this.state.graph);
    }

    setPositions(pos: NodePositions): void {
        this.state.positions = { ...this.state.positions, ...pos };
        this.bump();
    }

    setPosition(id: string, x: number, y: number): void {
        this.state.positions[id] = { x, y };
        this.bump();
    }

    /* ─── Selection ─────────────────────────────────────────── */
    select(ids: string[] | Set<string>): void {
        this.state.selection = new Set(ids as any);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    selectComments(threadId?: string): void {
        this.bus.emit("comment:select", { threadId });
    }

    addToSelection(ids: string[] | Set<string>): void {
        for (const id of ids as any) this.state.selection.add(id);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    toggleSelection(id: string): void {
        if (this.state.selection.has(id)) this.state.selection.delete(id);
        else this.state.selection.add(id);
        this.bump();
        this.bus.emit("selection:change", { ids: this.getSelection() });
    }

    clearSelection(): void {
        if (this.state.selection.size === 0) return;
        this.state.selection.clear();
        this.bump();
        this.bus.emit("selection:change", { ids: [] });
    }

    /* ─── Highlight / Hover ─────────────────────────────────── */
    setHighlighted(ids: string[] | Set<string>): void {
        this.state.highlighted = new Set(ids as any);
        this.bump();
    }

    setHover(id?: string): void {
        this.state.hoverId = id;
        this.bump();
        this.bus.emit("hover:change", { id });
    }

    /* ─── Viewport ──────────────────────────────────────────── */
    setViewport(v: Partial<Viewport>): void {
        this.state.viewport = { ...this.state.viewport, ...v };
        this.bump();
        this.bus.emit("viewport:change", this.getViewport());
    }

    /* ─── Wiring draft (for bind/include/exclude UX) ────────── */
    startWire(from: string, kind: DraftWire["kind"]): void {
        this.state.draftWire = { from, kind };
        this.bump();
        this.bus.emit("wire:preview", { from, kind });
    }

    previewWire(to?: string): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        this.bus.emit("wire:preview", { from: dw.from, to, kind: dw.kind });
    }

    commitWire(to: string): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        // Headless API emits; the adapter/host decides how to mutate Builder
        this.bus.emit("wire:commit", { from: dw.from, to, kind: dw.kind });
        this.state.draftWire = undefined;
        this.bump();
    }

    cancelWire(): void {
        const dw = this.state.draftWire;
        if (!dw) return;
        this.bus.emit("wire:cancel", { from: dw.from });
        this.state.draftWire = undefined;
        this.bump();
    }

    /* ─── Utilities ─────────────────────────────────────────── */
    private bump(): void {
        this.state.version++;
        if (this.autoEmit) this.bus.emit("state:change", this.snapshot());
    }

    dispose(): void {
        this.bus.clear();
    }

    undo() {
        this.builder.undo();
        this.refreshGraph();
    }

    private edgeRel: EdgeKind = "bind";
    getEdgeRel(): EdgeKind {
        return this.edgeRel;
    }

    public setEdgeRel(rel: EdgeKind) {
        if (this.edgeRel === rel) return; // ← correct: skip only if identical
        this.edgeRel = rel;
        this.refreshGraph();
    }

    /* ─── Option-node visibility (per field) ───────────────────────────────── */

    /** Internal mirror of which fields should show their options as nodes. */
    private shownOptionFields = new Set<string>();

    /** Return the field ids whose options are currently set to be visible as nodes. */
    getShownOptionFields(): string[] {
        return Array.from(this.shownOptionFields);
    }

    /** True if this field’s options are shown as nodes. */
    isFieldOptionsShown(fieldId: string): boolean {
        return this.shownOptionFields.has(String(fieldId));
    }

    /**
     * Set visibility of option nodes for a field, then rebuild the graph.
     * When shown = true, the Builder will emit option nodes for this field.
     */
    setFieldOptionsShown(fieldId: string, shown: boolean): void {
        const id = String(fieldId);
        const before = this.shownOptionFields.has(id);
        if (shown && !before) this.shownOptionFields.add(id);
        else if (!shown && before) this.shownOptionFields.delete(id);
        else return; // no-op

        // Push to builder options and refresh
        this.builder.setOptions({
            showOptionNodes: new Set(this.shownOptionFields),
        });
        this.refreshGraph();
    }

    /** Toggle option-node visibility for a field. Returns the new visibility. */
    toggleFieldOptions(fieldId: string): boolean {
        const next = !this.isFieldOptionsShown(fieldId);
        this.setFieldOptionsShown(fieldId, next);
        return next;
    }

    /**
     * Replace the whole set of fields whose options are visible as nodes.
     * Useful for restoring a saved UI state.
     */
    setShownOptionFields(ids: Iterable<string>): void {
        const next = new Set(Array.from(ids, String));
        // Fast-path: if identical set, skip work
        if (
            next.size === this.shownOptionFields.size &&
            Array.from(next).every((id) => this.shownOptionFields.has(id))
        ) {
            return;
        }
        this.shownOptionFields = next;
        this.builder.setOptions({
            showOptionNodes: new Set(this.shownOptionFields),
        });
        this.refreshGraph();
    }
}
