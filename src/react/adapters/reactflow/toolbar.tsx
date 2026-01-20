import React, { useMemo, useState, useCallback } from "react";
import { useReactFlow } from "reactflow";
import type { CanvasAPI } from "../../canvas/api";
import { resolveTools } from "./toolbar/merge";
import type {
    ResolvedTools,
    ToolContext,
    ToolsConfig,
    LabelPlacement,
    ToolDescriptor,
} from "./toolbar/types";
import { Icons } from "./toolbar/icons";

export type ToolbarProps = {
    api: CanvasAPI;
    mode?: "dev" | "prod";
    showGrid: boolean;
    setShowGrid: (v: boolean) => void;
    showMiniMap: boolean;
    setShowMiniMap: (v: boolean) => void;

    tools?: ToolsConfig;
    /** Default: 'tooltip' (hidden label, shown as native tooltip) */
    labelPlacement?: LabelPlacement;
    /** Optional custom button renderer */
    renderButton?: (t: ToolRender, key: string) => React.ReactNode;
};

export type ToolRender = {
    id: string;
    label?: string;
    icon?: React.ReactNode;
    active: boolean;
    disabled: boolean;
    disabledReason?: string;
    onClick: () => void;
    group?: string;
    hasMenu?: boolean;
    open?: boolean;
    onToggleMenu?: () => void;
    children?: ToolRender[];
};

export function Toolbar({
    api,
    mode = "dev",
    showGrid,
    setShowGrid,
    showMiniMap,
    setShowMiniMap,
    tools,
    labelPlacement = "tooltip",
    renderButton,
}: ToolbarProps) {
    const rf = useReactFlow();
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    const selectionCount = api.getSelection().length;
    const relation = api.getEdgeRel();
    const canUndo = true;
    const canRedo = true;

    const ctx: ToolContext = useMemo(
        () => ({
            api,
            env: { mode },
            state: {
                relation,
                selectionCount,
                canUndo,
                canRedo,
                showGrid,
                showMiniMap,
            },
            flow: {
                zoomIn: () => rf.zoomIn?.(),
                zoomOut: () => rf.zoomOut?.(),
                fitView: () => rf.fitView?.(),
            },
            setRelation: (rel) => api.setEdgeRel(rel),
            toggleGrid: () => setShowGrid(!showGrid),
            toggleMiniMap: () => setShowMiniMap(!showMiniMap),
        }),
        [
            api,
            mode,
            relation,
            selectionCount,
            showGrid,
            showMiniMap,
            rf,
            setShowGrid,
            setShowMiniMap,
        ],
    );

    const descriptors: ResolvedTools = useMemo(
        () => resolveTools({ base: defaultTools(), ...(tools ?? {}) }),
        [tools],
    );

    const buildRenderable = useCallback(
        (defs: ToolDescriptor[]): ToolRender[] => {
            return defs
                .filter((t) => (t.when ? !!t.when(ctx) : true))
                .map((t) => {
                    const en = t.enabled ? t.enabled(ctx) : true;
                    const enabledOk =
                        typeof en === "boolean" ? en : en.ok !== false;
                    const reason =
                        typeof en === "boolean" ? undefined : en.reason;
                    const active = t.active ? !!t.active(ctx) : false;

                    let iconNode: React.ReactNode | undefined;
                    if (typeof t.icon === "function")
                        iconNode = t.icon(active, !enabledOk);
                    else if (typeof t.icon === "string")
                        iconNode = mapIcon(t.icon, active);

                    const onClick = async () => {
                        if (!enabledOk || !t.action) return;
                        try {
                            t.onBefore?.(ctx);
                            await t.action(ctx);
                            t.onAfter?.(ctx);
                        } catch (err) {
                            t.onError?.(ctx, err);
                            api.emit("error", {
                                message:
                                    (err as any)?.message ??
                                    "Tool action failed",
                                meta: { tool: t.id },
                            });
                        }
                    };

                    const hasMenu = !!(t.children && t.children.length);
                    const children = hasMenu
                        ? buildRenderable(t.children!)
                        : undefined;

                    return {
                        id: t.id,
                        label: t.label,
                        icon: iconNode,
                        active,
                        disabled: !enabledOk,
                        disabledReason: reason,
                        onClick,
                        group: t.group,
                        hasMenu,
                        open: hasMenu && openMenuId === t.id,
                        onToggleMenu: hasMenu
                            ? () =>
                                  setOpenMenuId(
                                      openMenuId === t.id ? null : t.id,
                                  )
                            : undefined,
                        children,
                    } as ToolRender;
                });
        },
        [ctx, api, openMenuId],
    );

    const items: ToolRender[] = buildRenderable(descriptors);
    const groups = groupBy(items, (i) => i.group ?? "view");

    return (
        <div className="dsb-toolbar pointer-events-none absolute left-2 top-2 z-10 grid gap-2">
            {Object.entries(groups).map(([g, arr]) => (
                <div
                    key={g}
                    className="dsb-toolbar__group pointer-events-auto flex gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-sm"
                >
                    {arr.map((btn) =>
                        renderButton ? (
                            renderButton(btn, btn.id)
                        ) : (
                            <DefaultTool
                                key={btn.id}
                                {...btn}
                                labelPlacement={labelPlacement}
                            />
                        ),
                    )}
                </div>
            ))}
        </div>
    );
}

/* ------------------- Built-in tools (with Tailwind icons) ------------------- */

function defaultTools(): ToolDescriptor[] {
    return [
        {
            id: "mode:bind",
            kind: "mode",
            group: "relation",
            order: 10,
            label: "Bind",
            icon: (active) => Icons.bind(active),
            active: (ctx) => ctx.state.relation === "bind",
            action: (ctx) => ctx.setRelation("bind"),
        },
        {
            id: "mode:include",
            kind: "mode",
            group: "relation",
            order: 20,
            label: "Include",
            icon: (active) => Icons.include(active),
            active: (ctx) => ctx.state.relation === "include",
            action: (ctx) => ctx.setRelation("include"),
        },
        {
            id: "mode:exclude",
            kind: "mode",
            group: "relation",
            order: 30,
            label: "Exclude",
            icon: (active) => Icons.exclude(active),
            active: (ctx) => ctx.state.relation === "exclude",
            action: (ctx) => ctx.setRelation("exclude"),
        },

        {
            id: "view:grid",
            kind: "toggle",
            group: "view",
            order: 10,
            label: "Grid",
            icon: (a) => Icons.grid(a),
            active: (ctx) => ctx.state.showGrid,
            action: (ctx) => ctx.toggleGrid(),
        },
        {
            id: "view:minimap",
            kind: "toggle",
            group: "view",
            order: 20,
            label: "Minimap",
            icon: (a) => Icons.minimap(a),
            active: (ctx) => ctx.state.showMiniMap,
            action: (ctx) => ctx.toggleMiniMap(),
        },

        // Example dropdown (menu) with viewport controls
        {
            id: "zoom:menu",
            kind: "menu",
            group: "viewport",
            order: 5,
            label: "Viewport",
            icon: () => Icons.fit(),
            children: [
                {
                    id: "zoom:in",
                    kind: "command",
                    label: "Zoom In",
                    icon: () => Icons.zoomIn(),
                    action: (ctx) => ctx.flow.zoomIn(),
                },
                {
                    id: "zoom:out",
                    kind: "command",
                    label: "Zoom Out",
                    icon: () => Icons.zoomOut(),
                    action: (ctx) => ctx.flow.zoomOut(),
                },
                {
                    id: "zoom:fit",
                    kind: "command",
                    label: "Fit",
                    icon: () => Icons.fit(),
                    action: (ctx) => ctx.flow.fitView(),
                },
            ],
        },
    ];
}

/* ------------------- Renderers ------------------- */

function DefaultTool({
    id,
    label,
    icon,
    active,
    disabled,
    disabledReason,
    onClick,
    hasMenu,
    open,
    onToggleMenu,
    children,
    group,
    labelPlacement,
}: ToolRender & { labelPlacement: LabelPlacement }) {
    const baseBtn =
        "dsb-tool inline-flex items-center justify-center rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground " +
        (active ? "ring-1 ring-ring bg-accent text-accent-foreground" : "") +
        (disabled ? " opacity-50 cursor-not-allowed" : "");

    const title =
        labelPlacement === "tooltip"
            ? disabled
                ? (disabledReason ?? label)
                : label
            : undefined;

    const content = (
        <>
            {icon ?? null}
            {labelPlacement === "inline" && label && (
                <span className="ml-1">{label}</span>
            )}
            {labelPlacement === "below" && label && (
                <span className="mt-0.5 block text-[10px] leading-3 text-muted-foreground">
                    {label}
                </span>
            )}
            {hasMenu && <span className="ml-1">{Icons.chevronDown()}</span>}
        </>
    );

    if (!hasMenu) {
        return (
            <button
                type="button"
                title={title}
                aria-pressed={active}
                disabled={disabled}
                onClick={onClick}
                className={
                    baseBtn +
                    " h-8 w-8 " +
                    (labelPlacement === "below" ? "flex-col" : "")
                }
            >
                {content}
            </button>
        );
    }

    // Menu root
    return (
        <div className="relative">
            <button
                type="button"
                title={title}
                aria-expanded={open ? "true" : "false"}
                disabled={disabled}
                onClick={onToggleMenu}
                className={
                    baseBtn +
                    " h-8 w-8 " +
                    (labelPlacement === "below" ? "flex-col" : "")
                }
            >
                {content}
            </button>

            {open && (
                <div
                    className="absolute left-0 z-20 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover shadow-lg"
                    role="menu"
                >
                    <ul className="divide-y divide-border">
                        {children?.map((ch) => (
                            <li key={ch.id} className="p-0">
                                <button
                                    type="button"
                                    role="menuitem"
                                    title={
                                        labelPlacement === "tooltip"
                                            ? ch.disabled
                                                ? (ch.disabledReason ??
                                                  ch.label)
                                                : ch.label
                                            : undefined
                                    }
                                    disabled={ch.disabled}
                                    onClick={ch.onClick}
                                    className={
                                        "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground " +
                                        (ch.disabled
                                            ? "opacity-50 cursor-not-allowed"
                                            : "")
                                    }
                                >
                                    {ch.icon ?? null}
                                    {labelText(ch.label, "inline")}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function labelText(label?: string, placement: LabelPlacement = "tooltip") {
    if (!label || placement === "none" || placement === "tooltip") return null;
    if (placement === "inline") return <span>{label}</span>;
    if (placement === "below")
        return (
            <span className="block text-[10px] leading-3 text-muted-foreground">
                {label}
            </span>
        );
    return null;
}

function mapIcon(token: string, active: boolean): React.ReactNode {
    switch (token) {
        case "bind":
            return Icons.bind(active);
        case "include":
            return Icons.include(active);
        case "exclude":
            return Icons.exclude(active);
        case "zoom-in":
            return Icons.zoomIn();
        case "zoom-out":
            return Icons.zoomOut();
        case "fit":
            return Icons.fit();
        case "grid":
            return Icons.grid(active);
        case "minimap":
            return Icons.minimap(active);
        default:
            return (
                <span className="text-xs text-muted-foreground">{token}</span>
            );
    }
}

function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
    const out: Record<string, T[]> = {};
    for (const x of arr) {
        const k = key(x);
        if (!out[k]) out[k] = [];
        out[k].push(x);
    }
    return out;
}
