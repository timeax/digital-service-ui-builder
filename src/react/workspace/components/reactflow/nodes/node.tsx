import React, { ReactNode, useEffect, useRef } from "react";
import { LiaTagsSolid } from "react-icons/lia";
import { RxInput } from "react-icons/rx";
import { TbHandClick } from "react-icons/tb";
import { LuTextSelect } from "react-icons/lu";
import { TfiComments } from "react-icons/tfi";
import { Handle, Position } from "reactflow";
import { useCanvasAPI } from "@/react/workspace/context/context";
import { clsx } from "clsx";

interface Errors {
    title?: string;
    description: string;
    meta?: Record<string, unknown>;
}
interface NodeProps {
    children?: (
        label: ReactNode,
        icon: ReactNode,
        errors?: Errors[],
    ) => React.ReactNode;
    description?: string;
    label: string;
    id: string;
    type: "tag" | "field" | "option" | "button" | "comment";
    errors?: Errors[];
    meta?: Record<string, unknown>;
}

function getIcon(
    type: NodeProps["type"],
): React.FC<React.SVGProps<SVGSVGElement>> {
    switch (type) {
        case "tag":
            return LiaTagsSolid;
        case "field":
            return RxInput;
        case "option":
            return LuTextSelect;
        case "button":
            return TbHandClick;
        case "comment":
            return TfiComments;
    }
}
const Node: React.FC<NodeProps> = ({
    children,
    label,
    errors,
    id,
    type,
    description,
}) => {
    const labelRef = useRef<HTMLDivElement>(null);
    const descRef = useRef<HTMLDivElement>(null);
    const { editor } = useCanvasAPI();

    useEffect(() => {
        if (labelRef.current && labelRef.current.innerText !== label) {
            labelRef.current.innerText = label;
        }
        if (
            descRef.current &&
            descRef.current.innerText !== (description ?? "")
        ) {
            descRef.current.innerText = description ?? "";
        }
    }, [label, description]);
    const Icon = getIcon(type);
    const Label = (
        <div
            contentEditable
            suppressContentEditableWarning
            tabIndex={0} // make it focusable
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
                e.preventDefault(); // prevent default context menu
                labelRef.current?.focus(); // focus the editable div
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                labelRef.current?.focus();
            }}
            onBlur={() => {
                const newText = labelRef.current?.innerText.trim() || "";
                if (newText && newText !== label) {
                    editor.reLabel(id, newText);
                }
            }}
            className="text-[12px] outline-none w-full cursor-text text-center"
        >
            {label}
        </div>
    );
    return (
        <div
            className={clsx(
                "px-4 items-center gap-2 relative min-h-[40px] flex h-fit bg-card ring ring-grey-100 rounded-md shadow text-card-foreground font-black",
            )}
        >
            {children ? (
                children(Label, <Icon />, errors)
            ) : (
                <span className={"flex gap-2 items-center"}>
                    <Icon /> {Label}
                </span>
            )}

            <Handle
                id="mid-top"
                type="target"
                position={Position.Top}
                style={{
                    top: 0,
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    zIndex: 10,
                }}
            />
            <Handle
                id="mid-top"
                type="source"
                position={Position.Top}
                style={{
                    top: 0,
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    zIndex: 10,
                }}
            />

            {/* mid-bottom: target + source */}
            <Handle
                id="mid-bottom"
                type="target"
                position={Position.Bottom}
                style={{
                    bottom: 0,
                    left: "50%",
                    transform: "translate(-50%, 50%)",
                    zIndex: 10,
                }}
            />
            <Handle
                id="mid-bottom"
                type="source"
                position={Position.Bottom}
                style={{
                    bottom: 0,
                    left: "50%",
                    transform: "translate(-50%, 50%)",
                    zIndex: 10,
                }}
            />
        </div>
    );
};

export default Node;
