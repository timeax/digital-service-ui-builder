// src/react/workspace/context/provider/compose/use-branch-cache.ts
import * as React from "react";
import type { BranchCacheEntry, Loadable, SnapshotSlice } from "../types";
import type { FieldTemplate, BranchParticipant } from "../../backend";

export interface BranchCacheApi {
    readonly clear: () => void;

    readonly switchBranch: (
        args: Readonly<{
            nextId: string;
            prevId?: string;

            templates: Loadable<readonly FieldTemplate[]>;
            participants: Loadable<readonly BranchParticipant[]>;
            snapshot: SnapshotSlice;

            setTemplates: React.Dispatch<
                React.SetStateAction<Loadable<readonly FieldTemplate[]>>
            >;
            setParticipants: React.Dispatch<
                React.SetStateAction<Loadable<readonly BranchParticipant[]>>
            >;
            setSnapshot: React.Dispatch<React.SetStateAction<SnapshotSlice>>;

            resetTemplates: () => void;
            resetParticipants: () => void;
            resetSnapshot: () => void;

            setCurrentBranchId: (id: string) => void;

            hasInitialSnapshot: boolean;

            loadSnapshotForBranch: (branchId: string) => void;
        }>,
    ) => void;
}

export function useBranchCache(): BranchCacheApi {
    const cacheRef = React.useRef<Record<string, BranchCacheEntry>>({});

    const clear = React.useCallback((): void => {
        cacheRef.current = {};
    }, []);

    const switchBranch = React.useCallback(
        (
            args: Readonly<{
                nextId: string;
                prevId?: string;

                templates: Loadable<readonly FieldTemplate[]>;
                participants: Loadable<readonly BranchParticipant[]>;
                snapshot: SnapshotSlice;

                setTemplates: React.Dispatch<
                    React.SetStateAction<Loadable<readonly FieldTemplate[]>>
                >;
                setParticipants: React.Dispatch<
                    React.SetStateAction<Loadable<readonly BranchParticipant[]>>
                >;
                setSnapshot: React.Dispatch<
                    React.SetStateAction<SnapshotSlice>
                >;

                resetTemplates: () => void;
                resetParticipants: () => void;
                resetSnapshot: () => void;

                setCurrentBranchId: (id: string) => void;

                hasInitialSnapshot: boolean;

                loadSnapshotForBranch: (branchId: string) => void;
            }>,
        ): void => {
            const prevId = args.prevId;

            // cache previous branch scope
            if (prevId && prevId !== args.nextId) {
                cacheRef.current[prevId] = {
                    templates: args.templates,
                    participants: args.participants,
                    snapshot: args.snapshot,
                };
            }

            const cached: BranchCacheEntry | undefined =
                cacheRef.current[args.nextId];

            if (cached) {
                args.setTemplates(cached.templates);
                args.setParticipants(cached.participants);
                args.setSnapshot(cached.snapshot);
            } else {
                args.resetTemplates();
                args.resetParticipants();
                args.resetSnapshot();
            }

            args.setCurrentBranchId(args.nextId);

            const hasCachedSnapshot: boolean = Boolean(
                cached?.snapshot?.data && cached?.snapshot?.schemaVersion,
            );

            if (!hasCachedSnapshot && !args.hasInitialSnapshot) {
                args.loadSnapshotForBranch(args.nextId);
            }
        },
        [],
    );

    return React.useMemo<BranchCacheApi>(
        () => ({ clear, switchBranch }),
        [clear, switchBranch],
    );
}
