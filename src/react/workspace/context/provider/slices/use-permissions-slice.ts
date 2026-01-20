// src/react/workspace/context/provider/slices/use-permissions-slice.ts
import * as React from "react";
import type {
    Actor,
    BackendError,
    PermissionsMap,
    WorkspaceBackend,
} from "../../backend";
import type { Loadable } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";

export interface PermissionsSliceApi {
    readonly permissions: Loadable<PermissionsMap>;
    readonly refreshPermissions: () => Promise<void>;
    readonly invalidatePermissions: () => void;
}

function setLoadableError<T>(
    updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
    error: BackendError,
): void {
    updater((s) => ({ ...s, loading: false, error }));
}

export interface UsePermissionsSliceParams {
    readonly backend: WorkspaceBackend;
    readonly workspaceId: string;
    readonly actor: Actor;
    readonly initialPermissions?: PermissionsMap | null;
    readonly runtime: BackendRuntime;
}

export function usePermissionsSlice(
    params: UsePermissionsSliceParams,
): PermissionsSliceApi {
    const { backend, workspaceId, actor, initialPermissions, runtime } = params;

    const [permissions, setPermissions] = React.useState<
        Loadable<PermissionsMap>
    >({
        data: initialPermissions ?? null,
        loading: false,
        updatedAt: initialPermissions ? runtime.now() : undefined,
    });

    const refreshPermissions = React.useCallback(async (): Promise<void> => {
        setPermissions((s) => ({ ...s, loading: true }));
        const res = await backend.permissions.refresh(workspaceId, actor);

        if (res.ok) {
            setPermissions({
                data: res.value,
                loading: false,
                updatedAt: runtime.now(),
            });
        } else {
            setLoadableError(setPermissions, res.error);
        }
    }, [backend.permissions, workspaceId, actor, runtime]);

    const invalidatePermissions = React.useCallback((): void => {
        setPermissions((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    return React.useMemo<PermissionsSliceApi>(
        () => ({ permissions, refreshPermissions, invalidatePermissions }),
        [permissions, refreshPermissions, invalidatePermissions],
    );
}
