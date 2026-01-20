// src/react/workspace/context/provider/slices/use-authors-slice.ts
import * as React from "react";
import type { Author, BackendError, WorkspaceBackend } from "../../backend";
import type { Loadable } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";

export interface AuthorsSliceApi {
    readonly authors: Loadable<readonly Author[]>;
    readonly refreshAuthors: () => Promise<void>;
    readonly invalidateAuthors: () => void;
}

function setLoadableError<T>(
    updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
    error: BackendError,
): void {
    updater((s) => ({ ...s, loading: false, error }));
}

export interface UseAuthorsSliceParams {
    readonly backend: WorkspaceBackend;
    readonly workspaceId: string;
    readonly initialAuthors?: readonly Author[] | null;
    readonly runtime: BackendRuntime;
}

export function useAuthorsSlice(
    params: UseAuthorsSliceParams,
): AuthorsSliceApi {
    const { backend, workspaceId, initialAuthors, runtime } = params;

    const [authors, setAuthors] = React.useState<Loadable<readonly Author[]>>({
        data: initialAuthors ?? null,
        loading: false,
        updatedAt: initialAuthors ? runtime.now() : undefined,
    });

    const refreshAuthors = React.useCallback(async (): Promise<void> => {
        setAuthors((s) => ({ ...s, loading: true }));
        const res = await backend.authors.refresh(workspaceId);

        if (res.ok) {
            setAuthors({
                data: res.value,
                loading: false,
                updatedAt: runtime.now(),
            });
        } else {
            setLoadableError(setAuthors, res.error);
        }
    }, [backend.authors, workspaceId, runtime]);

    const invalidateAuthors = React.useCallback((): void => {
        setAuthors((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    return React.useMemo<AuthorsSliceApi>(
        () => ({ authors, refreshAuthors, invalidateAuthors }),
        [authors, refreshAuthors, invalidateAuthors],
    );
}
