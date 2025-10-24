import type {CanvasAPI} from "../../../canvas/api";
import type React from "react";

export type ToolKind = 'command' | 'toggle' | 'mode' | 'menu';

export type ToolGroup =
    | 'relation'
    | 'viewport'
    | 'view'
    | 'edit'
    | (string & {});

export type EnabledState = boolean | { ok: boolean; reason?: string };

export type ToolbarIcon =
    | string
    | ((active: boolean, disabled: boolean) => React.ReactNode);

export type LabelPlacement = 'tooltip' | 'inline' | 'below' | 'none';

export type ToolDescriptor = {
    id: string;
    kind: ToolKind;
    label?: string;
    group?: ToolGroup;
    order?: number;
    icon?: ToolbarIcon;
    hotkey?: string;

    /** Optional dropdown children (rendered as a menu). */
    children?: ToolDescriptor[];

    // Visibility and state
    when?: (ctx: ToolContext) => boolean;
    enabled?: (ctx: ToolContext) => EnabledState;
    active?: (ctx: ToolContext) => boolean;

    // Mutations
    action?: (ctx: ToolContext) => void | Promise<void>;
    onBefore?: (ctx: ToolContext) => void;
    onAfter?: (ctx: ToolContext) => void;
    onError?: (ctx: ToolContext, err: unknown) => void;

    // Placement helpers
    insertBefore?: string;
    insertAfter?: string;
};

export type ToolContext = {
    api: CanvasAPI;
    env: { mode: 'dev' | 'prod' };
    state: {
        relation: ReturnType<CanvasAPI['getEdgeRel']>;
        selectionCount: number;
        canUndo: boolean;
        canRedo: boolean;
        showGrid: boolean;
        showMiniMap: boolean;
    };
    flow: {
        zoomIn: () => void;
        zoomOut: () => void;
        fitView: () => void;
    };
    setRelation: (rel: ReturnType<CanvasAPI['getEdgeRel']>) => void;
    toggleGrid: () => void;
    toggleMiniMap: () => void;
};

export type ToolsConfig = {
    base?: ToolDescriptor[];
    extend?: ToolDescriptor[];
    hidden?: string[];
};

export type ResolvedTools = ToolDescriptor[];