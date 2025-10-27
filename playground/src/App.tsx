import React from "react";
import "reactflow/dist/style.css";
import "@/styles/global.css";

import {
    Workspace,
    createMemoryWorkspaceBackend,
} from "digital-service-ui-builder/workspace";
import type { ServiceProps } from "digital-service-ui-builder";
import { initialProps } from "./data";

// In-memory backend seeded with your ServiceProps snapshot
const backend = createMemoryWorkspaceBackend<ServiceProps>({
    workspaceId: "lab-playground",
    branchNames: ["main", "feature-sample"],
    authors: [{ id: "a1", name: "Playground Admin" }],
    permissionsForActor: ({ actor }) => ({
        "lab-view": true,
        "lab-edit": true,
        "lab-approve": !!actor.roles?.includes("super"),
    }),
    initialSnapshot: {
        // Persist exactly what the builder expects: service props as the snapshot data
        schema_version: initialProps.schema_version ?? "1.1.0",
        data: initialProps,
    },
    initialHeadMessage: "Initial commit",
    initialDraft: false,
});

export default function App() {
    return (
        <Workspace<ServiceProps>
            backend={backend}
            workspaceId="lab-playground"
            actor={{ id: "u1", name: "You", roles: ["super"] }}
            live={{ mode: "poll", intervalMs: 15000 }}
            autosaveMs={9000}
            autoAutosave
        />
    );
}
