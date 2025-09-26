import {ReactFlowCanvas} from "./ReactFlowCanvas";
import {useCanvasAPI} from "../../canvas/context";

const FlowCanvas = () => {
    const api = useCanvasAPI();

    return (
        <div>
            <ReactFlowCanvas api={api}/>
        </div>
    )
}

export default FlowCanvas