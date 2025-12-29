import Tag from "@/components/reactflow/nodes/tags";
import Field from "@/components/reactflow/nodes/field";
import Options from "@/components/reactflow/nodes/options";

const nodeTypes = {
    tag: Tag,
    field: Field,
    option: Options,
};

const edgeTypes = {};

export { nodeTypes, edgeTypes };
