import Node from "@/components/reactflow/nodes/node";
import React from "react";
import type { FlowNode } from "../../../../../schema/graph";

const Tag: React.FC<FlowNode> = ({
    id,
    data: {
        node: { label },
    },
}) => {
    return <Node type={"tag"} label={label} id={id} />;
};

export default Tag;
