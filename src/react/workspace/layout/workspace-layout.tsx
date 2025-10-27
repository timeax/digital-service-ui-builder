import React from "react";
import clsx from "clsx";
import { useLeftPanel } from "./left-panel-context";
import { BottomOverlay } from "@/layout/bottom-bar";

export interface WorkspaceLayoutProps {
    /** Children: [Left, Middle, Right, BottomOverlay] */
    children: [
        React.ReactNode,
        React.ReactNode,
        React.ReactNode,
        React.ReactNode,
    ];
    /** Minimum builder width (tablet-only). Default: 800px */
    minWorkspaceWidthPx?: number;
}

/** Internal layout constraints (px) */
const LEFT_MIN = 200;
const LEFT_MAX = 480;
const LEFT_COLLAPSED = 0;

const RIGHT_MIN = 300;
const RIGHT_MAX = 560;

const MIDDLE_MIN = 300;

const DEFAULT_LEFT = 320;
const DEFAULT_RIGHT = 360;

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({
    children,
    minWorkspaceWidthPx = 800,
}) => {
    if (!Array.isArray(children) || children.length !== 4) {
        throw new Error(
            `WorkspaceLayout expects 4 children, got: ${Array.isArray(children) ? children.length : "invalid"}`,
        );
    }
    const [leftPanel, middlePanel, rightPanel, bottomPanel] = children;

    const { isCollapsed, getContainerProps, toggle, onPanelResized } =
        useLeftPanel();

    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const [containerW, setContainerW] = React.useState<number>(0);

    const [leftW, setLeftW] = React.useState<number>(DEFAULT_LEFT);
    const [rightW, setRightW] = React.useState<number>(DEFAULT_RIGHT);
    const lastExpandedLeftWRef = React.useRef<number>(DEFAULT_LEFT);

    // Keep container width updated
    React.useLayoutEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
        ro.observe(el);
        setContainerW(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    // Remember last expanded left width for collapse/expand UX
    React.useEffect(() => {
        if (!isCollapsed && leftW > LEFT_COLLAPSED + 8) {
            lastExpandedLeftWRef.current = leftW;
        }
    }, [isCollapsed, leftW]);

    // When collapsed, visually force rail width; when expanded, restore prior width (bounded).
    const effectiveLeftW = isCollapsed
        ? LEFT_COLLAPSED
        : clamp(leftW, LEFT_MIN, LEFT_MAX);
    const effectiveRightW = clamp(rightW, RIGHT_MIN, RIGHT_MAX);

    // Derived middle width (not stored)
    Math.max(
        MIDDLE_MIN,
        containerW - effectiveLeftW - effectiveRightW,
    );
// Convert a px width to % (for context bookkeeping)
    const pxToPct = React.useCallback(
        (px: number) => {
            if (!containerW) return 0;
            return (px / containerW) * 100;
        },
        [containerW],
    );

    // ----- Edge drag logic (invisible handles) -----
    const draggingRef = React.useRef<null | {
        type: "left" | "right";
        startX: number;
        startLeft: number;
        startRight: number;
    }>(null);

    const onMouseMove = React.useCallback(
        (e: MouseEvent) => {
            const d = draggingRef.current;
            if (!d || !rootRef.current) return;

            const dx = e.clientX - d.startX;
            if (d.type === "left") {
                if (isCollapsed) return; // ignore drags while collapsed
                let next = clamp(d.startLeft + dx, LEFT_MIN, LEFT_MAX);

                // Ensure middle has enough space
                const remaining = containerW - next - effectiveRightW;
                if (remaining < MIDDLE_MIN) {
                    next = containerW - effectiveRightW - MIDDLE_MIN;
                }
                next = clamp(next, LEFT_MIN, LEFT_MAX);

                setLeftW(next);
                onPanelResized(pxToPct(next)); // keep context informed
            } else {
                // right edge drag
                let next = clamp(d.startRight - dx, RIGHT_MIN, RIGHT_MAX); // dragging right edge left increases rightW
                const remaining = containerW - effectiveLeftW - next;
                if (remaining < MIDDLE_MIN) {
                    next = containerW - effectiveLeftW - MIDDLE_MIN;
                }
                next = clamp(next, RIGHT_MIN, RIGHT_MAX);
                setRightW(next);
            }
        },
        [
            containerW,
            effectiveLeftW,
            effectiveRightW,
            isCollapsed,
            onPanelResized,
            pxToPct,
        ],
    );

    const endDrag = React.useCallback(() => {
        draggingRef.current = null;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", endDrag);
    }, [onMouseMove]);

    const beginDrag = React.useCallback(
        (type: "left" | "right") => (e: React.MouseEvent) => {
            // Only start drag when using primary button
            if (e.button !== 0) return;
            draggingRef.current = {
                type,
                startX: e.clientX,
                startLeft: leftW,
                startRight: rightW,
            };
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", endDrag);
            e.preventDefault();
            e.stopPropagation();
        },
        [leftW, rightW, onMouseMove, endDrag],
    );

    // Double-click on left edge toggles collapse/expand (Figma-like)
    const onLeftEdgeDoubleClick = React.useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            if (!isCollapsed) {
                // collapsing: remember last expanded
                lastExpandedLeftWRef.current = leftW;
            } else {
                // expanding: restore last expanded (bounded and middle-safe)
                const restore = clamp(
                    lastExpandedLeftWRef.current,
                    LEFT_MIN,
                    LEFT_MAX,
                );
                const remaining = containerW - restore - effectiveRightW;
                const adjusted =
                    remaining < MIDDLE_MIN
                        ? containerW - effectiveRightW - MIDDLE_MIN
                        : restore;
                setLeftW(clamp(adjusted, LEFT_MIN, LEFT_MAX));
                onPanelResized(pxToPct(adjusted));
            }
            toggle();
        },
        [
            containerW,
            effectiveRightW,
            isCollapsed,
            leftW,
            onPanelResized,
            pxToPct,
            toggle,
        ],
    );

    const leftProps = getContainerProps();

    return (
        <div
            ref={rootRef}
            className="relative h-full w-full"
            style={{ minWidth: `${minWorkspaceWidthPx}px` }}
        >
            {/* Grid columns: Left(px) | Middle(fr) | Right(px) */}
            <div
                className="h-full grid"
                style={{
                    gridTemplateColumns: `${effectiveLeftW}px 1fr ${effectiveRightW}px`,
                }}
            >
                {/* Left */}
                <div
                    {...leftProps}
                    className={clsx(
                        "h-full border-r overflow-hidden",
                        leftProps["data-collapsed"]
                            ? "w-0 min-w-[0px] max-w-[0px]"
                            : "min-w-[200px] max-w-[480px]",
                    )}
                >
                    {leftPanel}
                </div>

                {/* Middle */}
                <div className="h-full overflow-hidden">{middlePanel}</div>

                {/* Right */}
                <div className="h-full border-l overflow-hidden min-w-[300px] max-w-[560px]">
                    {rightPanel}
                </div>

                {/* Invisible vertical edges (absolute over the grid) */}
                {/* Left⇄Middle edge */}
                <div
                    title="" // keep tooltips off
                    onMouseDown={beginDrag("left")}
                    onDoubleClick={onLeftEdgeDoubleClick}
                    className="absolute top-0 h-full"
                    style={{
                        left: `${effectiveLeftW - 2}px`,
                        width: "4px",
                        cursor: isCollapsed ? "default" : "col-resize",
                        // invisible but catches pointer events
                        background: "transparent",
                        zIndex: 10,
                    }}
                />
                {/* Middle⇄Right edge */}
                <div
                    title=""
                    onMouseDown={beginDrag("right")}
                    className="absolute top-0 h-full"
                    style={{
                        left: `${containerW - effectiveRightW - 2}px`,
                        width: "4px",
                        cursor: "col-resize",
                        background: "transparent",
                        zIndex: 10,
                    }}
                />
            </div>

            {/* Bottom overlay (rendered last to stack above) */}
            <BottomOverlay>{bottomPanel}</BottomOverlay>
        </div>
    );
};
