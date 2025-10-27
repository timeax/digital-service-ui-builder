import { useWorkspace } from "@/context";
import Container from "@/components/container";
import { BsLayoutSidebar } from "react-icons/bs";
import { useLeftPanel } from "@/layout/left-panel-context";
import { GrDiamond } from "react-icons/gr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers } from "@/panels/left/layers";
export function LeftPanel() {
    const workspace = useWorkspace();
    const branch = workspace.branches.data.find(
        (b) => b.id === workspace.branches.currentId,
    );

    const layout = useLeftPanel();

    return layout.isCollapsed ? (
        <Container className="absolute top-2 left-3 p-3 rounded-md shadow-sm z-40 bg-white">
            <div className={"flex gap-6 items-center justify-between"}>
                <GrDiamond />
                <div className="flex gap-1">
                    <span className="capitalize">{branch?.name}</span> (
                    {branch?.isMain ? "default" : "other"})
                </div>
                <BsLayoutSidebar onClick={layout.expand} />
            </div>
        </Container>
    ) : (
        <Container className={"py-3"}>
            <div className="flex flex-col gap-4">
                <div className={"flex gap-1 items-center justify-between"}>
                    <GrDiamond />
                    <BsLayoutSidebar onClick={layout.collapse} />
                </div>
                <div className="flex flex-col">
                    <div className="flex gap-1 leading-tight">
                        <span className="capitalize">{branch?.name}</span> (
                        {branch?.isMain ? "default" : "other"})
                    </div>
                    <span className={"h-fit leading-tight"}>
                        <small>Drafts</small>
                    </span>
                </div>

                <Tabs defaultValue={"layers"}>
                    <TabsList>
                        <TabsTrigger value={"layers"}>Layers</TabsTrigger>
                        <TabsTrigger value={"assets"}>Assets</TabsTrigger>
                    </TabsList>

                    <TabsContent value={"layers"}>
                        <Layers />
                    </TabsContent>
                    <TabsContent value={"assets"}></TabsContent>
                </Tabs>
            </div>
        </Container>
    );
}
