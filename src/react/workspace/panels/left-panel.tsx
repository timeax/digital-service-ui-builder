import { useWorkspace } from "@/context";

interface LeftPanelProps {}
export function LeftPanel() {
    const workspace = useWorkspace();
    return (
        <>
            <div>
                <div className="flex"></div>
            </div>
        </>
    );
}
