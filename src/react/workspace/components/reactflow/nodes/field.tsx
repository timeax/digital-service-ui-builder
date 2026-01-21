import Node from "./node";
import React from "react";
import { FlowNode } from "@/schema/graph";

const Field: React.FC<FlowNode> = (props) => {
    const {
        id,
        data: {
            node: { label },
        },
    } = props;
    return (
        <Node label={label} id={id} type={"field"}>
            {(label, icon) => {
                return (
                    <span className="flex gap-2 items-center">
                        {icon}
                        {label}
                    </span>
                );
            }}
        </Node>
    );
};

export default Field;
