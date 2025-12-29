import { useWorkspace } from "@/context";
import Container from "@/components/container";
import { BsLayoutSidebar } from "react-icons/bs";
import { useLeftPanel } from "@/layout/left-panel-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers } from "@/panels/left/layers";
import { TbFileSettings } from "react-icons/tb";
import { SmartDropdown } from "@/components/smart-dropdown";
export function LeftPanel() {
    const workspace = useWorkspace();
    const branch = workspace.branches.data.find(
        (b) => b.id === workspace.branches.currentId,
    );

    const layout = useLeftPanel();

    const Settings = (
        <SmartDropdown
            align={"start"}
            menu={[
                {
                    label: "Show hidden fields",
                },
            ]}
        >
            <TbFileSettings />
        </SmartDropdown>
    );

    return layout.isCollapsed ? (
        <Container className="absolute top-2 left-3 p-3 rounded-md shadow-sm z-40 bg-white">
            <div className={"flex gap-6 items-center justify-between"}>
                {Settings}
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
                    <div className="flex items-center gap-4">
                        {Settings}
                        <span className="capitalize">
                            {workspace.info?.name}
                        </span>
                    </div>
                    <BsLayoutSidebar onClick={layout.collapse} />
                </div>
                <div className="flex flex-col">
                    <span className={"h-fit leading-tight"}>
                        <small>Drafts</small>
                    </span>
                </div>

                <Tabs defaultValue={"layers"}>
                    <TabsList className={"p-0!"}>
                        <TabsTrigger
                            className={"pl-0! text-[12px]!"}
                            value={"layers"}
                        >
                            Layers
                        </TabsTrigger>
                        <TabsTrigger
                            value={"assets"}
                            className={"text-[12px]! pl-0!"}
                        >
                            Assets
                        </TabsTrigger>
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
