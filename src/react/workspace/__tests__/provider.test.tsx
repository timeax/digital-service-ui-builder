// src/react/workspace/context/provider/__tests__/workspace-provider.integration.test.ts
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WorkspaceProvider, useWorkspace } from "@/react";
import type { Actor, Branch } from "../context/backend";
import type { WorkspaceAPI } from "@/react";

import { createMemoryWorkspaceBackend } from "../context/memory";

/**
 * React’s act() warnings happen if the test environment doesn’t opt in.
 * This silences: “The current testing environment is not configured to support act(...)”
 */
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function makeActor(): Actor {
    return { id: "actor-1", name: "Tester" };
}

function makeBranch(id: string, isMain: boolean): Branch {
    const iso = new Date(0).toISOString();
    return { id, name: id, isMain, createdAt: iso, updatedAt: iso };
}

describe("WorkspaceProvider (integration)", () => {
    let container: HTMLDivElement;
    let root: Root | null;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        if (root) {
            act(() => root?.unmount());
            root = null;
        }
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("refresh.all() calls workspace-wide refreshers then current-branch context refreshers (memory backend)", async () => {
        const actor: Actor = makeActor();

        const backend = createMemoryWorkspaceBackend({
            workspaceId: "ws-1",
            actorId: actor.id,
            seed: {
                authors: [{ id: actor.id, name: actor.name ?? "Tester" }],
                branches: [makeBranch("b1", true)],
            },
        });

        // spy on the real backend methods
        const spyAuthorsRefresh = vi.spyOn(backend.authors, "refresh");
        const spyPermissionsRefresh = vi.spyOn(backend.permissions, "refresh");
        const spyBranchesRefresh = vi.spyOn(backend.branches, "refresh");
        const spyServicesRefresh = vi.spyOn(backend.services, "refresh");
        const spyAccessRefreshParticipants = vi.spyOn(
            backend.access,
            "refreshParticipants",
        );
        const spyTemplatesRefresh = vi.spyOn(backend.templates, "refresh");
        const spySnapshotsRefresh = vi.spyOn(backend.snapshots, "refresh");

        let api: WorkspaceAPI | null = null;

        function Capture(): null {
            const ctx: WorkspaceAPI = useWorkspace();
            React.useEffect(() => {
                api = ctx;
            }, [ctx]);
            return null;
        }

        await act(async () => {
            root?.render(
                <WorkspaceProvider
                    backend={backend}
                    actor={actor}
                    autoAutosave={false}
                    initial={{
                        branches: [makeBranch("b1", true)],
                        mainId: "b1",
                        currentBranchId: "b1",
                    }}
                >
                    <Capture />
                </WorkspaceProvider>,
            );
            await flushMicrotasks();
        });

        expect(api).not.toBeNull();

        vi.clearAllMocks();

        await act(async () => {
            await api!.refresh.all({ strict: true });
            await flushMicrotasks();
        });

        const wsId: string = backend.info.id;

        // workspace-wide
        expect(spyAuthorsRefresh).toHaveBeenCalledWith(wsId);
        expect(spyPermissionsRefresh).toHaveBeenCalledWith(wsId, actor);
        expect(spyBranchesRefresh).toHaveBeenCalledWith(wsId);

        // services.refresh(workspaceId, { since? }) — provider may pass a second arg
        expect(spyServicesRefresh).toHaveBeenCalledWith(
            wsId,
            expect.objectContaining({ since: undefined }),
        );

        // branch-local (participants, templates, snapshot pointers for current branch)
        expect(spyAccessRefreshParticipants).toHaveBeenCalledWith(
            wsId,
            "b1",
            expect.anything(),
        );

        expect(spyTemplatesRefresh).toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceId: wsId,
                branchId: "b1",
            }),
        );

        expect(spySnapshotsRefresh).toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceId: wsId,
                branchId: "b1",
                actorId: actor.id,
            }),
        );
    });

    it("refresh.branchContext({ includeWorkspaceData:false }) refreshes only branch-local context (memory backend)", async () => {
        const actor: Actor = makeActor();

        const backend = createMemoryWorkspaceBackend({
            workspaceId: "ws-1",
            actorId: actor.id,
            seed: {
                authors: [{ id: actor.id, name: actor.name ?? "Tester" }],
                branches: [makeBranch("b1", true)],
            },
        });

        const spyAuthorsRefresh = vi.spyOn(backend.authors, "refresh");
        const spyPermissionsRefresh = vi.spyOn(backend.permissions, "refresh");
        const spyServicesRefresh = vi.spyOn(backend.services, "refresh");

        const spyAccessRefreshParticipants = vi.spyOn(
            backend.access,
            "refreshParticipants",
        );
        const spyTemplatesRefresh = vi.spyOn(backend.templates, "refresh");
        const spySnapshotsRefresh = vi.spyOn(backend.snapshots, "refresh");

        let api: WorkspaceAPI | null = null;

        function Capture(): null {
            const ctx: WorkspaceAPI = useWorkspace();
            React.useEffect(() => {
                api = ctx;
            }, [ctx]);
            return null;
        }

        await act(async () => {
            root?.render(
                <WorkspaceProvider
                    backend={backend}
                    actor={actor}
                    autoAutosave={false}
                    initial={{
                        branches: [makeBranch("b1", true)],
                        mainId: "b1",
                        currentBranchId: "b1",
                    }}
                >
                    <Capture />
                </WorkspaceProvider>,
            );
            await flushMicrotasks();
        });

        expect(api).not.toBeNull();

        vi.clearAllMocks();

        await act(async () => {
            await (
                api!.refresh.branchContext as (
                    opts?: Readonly<{
                        branchId?: string;
                        strict?: boolean;
                        includeWorkspaceData?: boolean;
                    }>,
                ) => Promise<unknown>
            )({
                branchId: "b1",
                strict: true,
                includeWorkspaceData: false,
            });
            await flushMicrotasks();
        });

        const wsId: string = backend.info.id;

        // must NOT run workspace-wide refreshers
        expect(spyAuthorsRefresh).not.toHaveBeenCalled();
        expect(spyPermissionsRefresh).not.toHaveBeenCalled();
        expect(spyServicesRefresh).not.toHaveBeenCalled();

        // must run branch-local refreshers
        expect(spyAccessRefreshParticipants).toHaveBeenCalledWith(
            wsId,
            "b1",
            expect.anything(),
        );

        expect(spyTemplatesRefresh).toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceId: wsId,
                branchId: "b1",
            }),
        );

        expect(spySnapshotsRefresh).toHaveBeenCalledWith(
            expect.objectContaining({
                workspaceId: wsId,
                branchId: "b1",
                actorId: actor.id,
            }),
        );
    });
});
