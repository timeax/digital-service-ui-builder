import Tag from "./nodes/tags";
import Field from "./nodes/field";
import Options from "./nodes/options";

const nodeTypes = {
    tag: Tag,
    field: Field,
    option: Options,
};

const edgeTypes = {};

export { nodeTypes, edgeTypes };
