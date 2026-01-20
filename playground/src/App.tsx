// playground/src/App.tsx
import React from "react";
import "reactflow/dist/style.css";
import "@/styles/global.css";

import {
    Workspace,
    createMemoryWorkspaceBackend,
} from "digital-service-ui-builder/workspace";
import type { EditorSnapshot } from "digital-service-ui-builder/schema/editor";
import { initialProps, serviceMap } from "./data";

// Actor (explicit type)
const actor: { id: string; name: string; roles: readonly string[] } = {
    id: "u1",
    name: "You",
    roles: ["super"],
};

// Valid EditorSnapshot: props + layout (nodes), no "canvas"
const editorData: EditorSnapshot = {
    props: initialProps,
    comments: [],
};

// In-memory backend
const backend: ReturnType<typeof createMemoryWorkspaceBackend> =
    createMemoryWorkspaceBackend({
        workspaceId: "lab-playground",
        branchNames: ["main", "feature-sample"],
        authors: [{ id: "a1", name: "Playground Admin" }],
        permissionsForActor: ({ actor: a }) => ({
            "lab-view": true,
            "lab-edit": true,
            "lab-approve": !!a.roles?.includes("super"),
        }),
        services: serviceMap, // DgpServiceMap or DgpServiceCapability[]
        initialSnapshot: {
            schema_version: initialProps.schema_version ?? "1.1.0",
            data: editorData,
        },
        initialHeadMessage: "Initial commit",
        initialDraft: false,
    });

export default function App(): JSX.Element {
    return (
        <Workspace
            backend={backend}
            actor={actor}
            live={{ mode: "poll", intervalMs: 15_000 }}
            autosaveMs={9_000}
            autoAutosave
            children={(tools) => {
                return <>tools</>;
            }}
        />
    );
}
