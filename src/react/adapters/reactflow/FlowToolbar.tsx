import React, { useMemo, useState } from "react";
import { useReactFlow } from "reactflow";
import type { CanvasAPI } from "../../canvas/api";
import type { EdgeKind } from "../../../schema/graph";

type Placement = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type FlowToolbarProps = {
    api: CanvasAPI;
    placement?: Placement;
    showRelation?: boolean;
    showViewport?: boolean;
    showLayers?: boolean;
    onToggleMiniMap?: (next: boolean) => void;
    onToggleBackground?: (next: boolean) => void;
    miniMapOn?: boolean;
    backgroundOn?: boolean;
};

const RELS: EdgeKind[] = ["bind", "include", "exclude"];

export function FlowToolbar({
    api,
    placement = "top-right",
    showRelation = true,
    showViewport = true,
    showLayers = true,
    onToggleMiniMap,
    onToggleBackground,
    miniMapOn,
    backgroundOn,
}: FlowToolbarProps) {
    const rf = useReactFlow();
    const [rel, setRel] = useState<EdgeKind>(api.getEdgeRel());

    const posClass = useMemo(() => {
        switch (placement) {
            case "top-left":
                return "left-2 top-2";
            case "top-right":
                return "right-2 top-2";
            case "bottom-left":
                return "left-2 bottom-2";
            case "bottom-right":
                return "right-2 bottom-2";
        }
    }, [placement]);

    const btnBase =
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground " +
        "hover:bg-accent hover:text-accent-foreground " +
        "aria-pressed:bg-accent aria-pressed:text-accent-foreground " +
        "data-active:ring-1 data-active:ring-ring";

    const groupBase =
        "pointer-events-auto flex gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-sm";

    return (
        <div className={`pointer-events-none absolute z-10 ${posClass}`}>
            <div className="pointer-events-auto grid gap-2">
                <div className={`dsb-toolbar__group ${groupBase}`}>
                    {showRelation && (
                        <div className="flex gap-1">
                            {RELS.map((k) => (
                                <button
                                    key={k}
                                    type="button"
                                    title={`Connect mode: ${k}`}
                                    aria-pressed={rel === k}
                                    data-active={rel === k || undefined}
                                    onClick={() => {
                                        setRel(k);
                                        api.setEdgeRel(k);
                                    }}
                                    className={btnBase}
                                >
                                    <span className="sr-only">{k}</span>
                                    <span className="h-4 w-4 rounded-sm bg-primary/10" />
                                </button>
                            ))}
                        </div>
                    )}

                    {showViewport && (
                        <div className="flex gap-1">
                            <button
                                type="button"
                                title="Fit view"
                                onClick={() => rf.fitView?.()}
                                className={btnBase}
                            >
                                <span className="sr-only">Fit</span>
                                <span className="h-4 w-4 rounded-sm bg-primary/10" />
                            </button>
                            <button
                                type="button"
                                title="Zoom in"
                                onClick={() => rf.zoomIn?.()}
                                className={btnBase}
                            >
                                +
                            </button>
                            <button
                                type="button"
                                title="Zoom out"
                                onClick={() => rf.zoomOut?.()}
                                className={btnBase}
                            >
                                −
                            </button>
                        </div>
                    )}

                    {showLayers && (
                        <div className="flex gap-1">
                            <button
                                type="button"
                                title="Toggle MiniMap"
                                aria-pressed={!!miniMapOn}
                                data-active={!!miniMapOn || undefined}
                                onClick={() => onToggleMiniMap?.(!miniMapOn)}
                                className={btnBase}
                            >
                                MM
                            </button>
                            <button
                                type="button"
                                title="Toggle Grid"
                                aria-pressed={!!backgroundOn}
                                data-active={!!backgroundOn || undefined}
                                onClick={() =>
                                    onToggleBackground?.(!backgroundOn)
                                }
                                className={btnBase}
                            >
                                Grid
                            </button>
                        </div>
                    )}

                    <div className="flex gap-1">
                        <button
                            type="button"
                            title="Undo"
                            onClick={() => api.undo?.()}
                            className={btnBase}
                        >
                            ↶
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
