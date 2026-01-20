// src/react/workspace/context/provider/slices/use-services-slice.ts
import * as React from "react";
import type { BackendError, WorkspaceBackend } from "../../backend";
import type { DgpServiceMap } from "@/schema/provider";
import type { Loadable } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";
import { toServiceMap } from "../helpers";

export interface ServicesSliceApi {
    readonly services: Loadable<DgpServiceMap>;
    readonly refreshServices: () => Promise<void>;
    readonly invalidateServices: () => void;
}

function setLoadableError<T>(
    updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
    error: BackendError,
): void {
    updater((s) => ({ ...s, loading: false, error }));
}

export interface UseServicesSliceParams {
    readonly backend: WorkspaceBackend;
    readonly workspaceId: string;
    readonly initialServices?: DgpServiceMap | null;
    readonly runtime: BackendRuntime;
}

export function useServicesSlice(
    params: UseServicesSliceParams,
): ServicesSliceApi {
    const { backend, workspaceId, initialServices, runtime } = params;

    const [services, setServices] = React.useState<Loadable<DgpServiceMap>>({
        data: initialServices ?? null,
        loading: false,
        updatedAt: initialServices ? runtime.now() : undefined,
    });

    const refreshServices = React.useCallback(async (): Promise<void> => {
        setServices((s) => ({ ...s, loading: true }));

        const res = await backend.services.refresh(workspaceId, {
            since: services.updatedAt,
        });

        if (!res.ok) {
            setLoadableError(setServices, res.error);
            return;
        }

        const map: DgpServiceMap | null = toServiceMap(res.value);
        setServices({
            data: map ?? ({} as DgpServiceMap),
            loading: false,
            updatedAt: runtime.now(),
        });
    }, [backend.services, workspaceId, services.updatedAt, runtime]);

    const invalidateServices = React.useCallback((): void => {
        setServices((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    return React.useMemo<ServicesSliceApi>(
        () => ({ services, refreshServices, invalidateServices }),
        [services, refreshServices, invalidateServices],
    );
}
