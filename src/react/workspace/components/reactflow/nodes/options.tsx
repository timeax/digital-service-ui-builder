import Node from "./node";
import { NodeProps } from "reactflow";
import { GraphNode } from "@/schema/graph";
import React from "react";

const Options: React.FC<NodeProps<GraphNode>> = ({ id, data: { label } }) => {
    return <Node label={label} id={id} type={"option"} />;
};

export default Options;
