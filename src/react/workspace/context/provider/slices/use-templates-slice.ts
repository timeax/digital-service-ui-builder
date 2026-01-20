// src/react/workspace/context/provider/slices/use-templates-slice.ts
import * as React from "react";
import type {
    BackendError,
    FieldTemplate,
    TemplateCreateInput,
    TemplateUpdatePatch,
    TemplatesListParams,
    WorkspaceBackend,
} from "../../backend";
import type { Loadable, WorkspaceAPI } from "../types";
import type { BackendRuntime } from "../runtime/use-backend-runtime";

export interface TemplatesSliceApi {
    readonly templates: Loadable<readonly FieldTemplate[]>;

    readonly refreshTemplates: (
        params?: Partial<Pick<TemplatesListParams, "branchId" | "since">>,
    ) => Promise<void>;

    readonly createTemplate: WorkspaceAPI["createTemplate"];
    readonly updateTemplate: WorkspaceAPI["updateTemplate"];
    readonly cloneTemplate: WorkspaceAPI["cloneTemplate"];
    readonly publishTemplate: WorkspaceAPI["publishTemplate"];
    readonly unpublishTemplate: WorkspaceAPI["unpublishTemplate"];
    readonly deleteTemplate: WorkspaceAPI["deleteTemplate"];

    readonly invalidateTemplates: () => void;

    /** internal setters for branch-cache composition */
    readonly __setTemplatesState: React.Dispatch<
        React.SetStateAction<Loadable<readonly FieldTemplate[]>>
    >;

    readonly resetTemplatesForBranch: () => void;
}

function setLoadableError<T>(
    updater: React.Dispatch<React.SetStateAction<Loadable<T>>>,
    error: BackendError,
): void {
    updater((s) => ({ ...s, loading: false, error }));
}

export interface UseTemplatesSliceParams {
    readonly backend: WorkspaceBackend;
    readonly workspaceId: string;

    readonly getCurrentBranchId: () => string | undefined;

    readonly initialTemplates?: readonly FieldTemplate[] | null;

    readonly runtime: BackendRuntime;
}

export function useTemplatesSlice(
    params: UseTemplatesSliceParams,
): TemplatesSliceApi {
    const {
        backend,
        workspaceId,
        getCurrentBranchId,
        initialTemplates,
        runtime,
    } = params;

    const [templates, setTemplates] = React.useState<
        Loadable<readonly FieldTemplate[]>
    >({
        data: initialTemplates ?? null,
        loading: false,
        updatedAt: initialTemplates ? runtime.now() : undefined,
    });

    const refreshTemplates = React.useCallback(
        async (
            params?: Partial<Pick<TemplatesListParams, "branchId" | "since">>,
        ): Promise<void> => {
            const branchId: string | undefined =
                params?.branchId ?? getCurrentBranchId();
            if (!branchId) return;

            setTemplates((s) => ({ ...s, loading: true }));

            const res = await backend.templates.refresh({
                workspaceId,
                branchId,
                since: params?.since ?? templates.updatedAt,
            });

            if (res.ok) {
                setTemplates({
                    data: res.value,
                    loading: false,
                    updatedAt: runtime.now(),
                });
            } else {
                setLoadableError(setTemplates, res.error);
            }
        },
        [
            backend.templates,
            workspaceId,
            getCurrentBranchId,
            templates.updatedAt,
            runtime,
        ],
    );

    const createTemplate = React.useCallback<WorkspaceAPI["createTemplate"]>(
        async (input: TemplateCreateInput) => {
            const res = await backend.templates.create(workspaceId, {
                ...input,
                branchId: input.branchId ?? getCurrentBranchId(),
            });

            if (res.ok) {
                await refreshTemplates({
                    branchId: res.value.branchId ?? getCurrentBranchId(),
                });
            }

            return res;
        },
        [backend.templates, workspaceId, getCurrentBranchId, refreshTemplates],
    );

    const updateTemplate = React.useCallback<WorkspaceAPI["updateTemplate"]>(
        async (id: string, patch: TemplateUpdatePatch) => {
            const res = await backend.templates.update(id, patch);

            if (res.ok) {
                await refreshTemplates({
                    branchId: res.value.branchId ?? getCurrentBranchId(),
                });
            }

            return res;
        },
        [backend.templates, getCurrentBranchId, refreshTemplates],
    );

    const cloneTemplate = React.useCallback<WorkspaceAPI["cloneTemplate"]>(
        async (source, opts) => {
            const res = await backend.templates.clone(
                source,
                opts ?? { branchId: getCurrentBranchId() ?? undefined },
            );

            if (res.ok) {
                await refreshTemplates({
                    branchId: res.value.branchId ?? getCurrentBranchId(),
                });
            }

            return res;
        },
        [backend.templates, getCurrentBranchId, refreshTemplates],
    );

    const publishTemplate = React.useCallback<WorkspaceAPI["publishTemplate"]>(
        async (id: string) => {
            const res = await backend.templates.publish(id);
            if (res.ok) {
                await refreshTemplates({ branchId: getCurrentBranchId() });
            }
            return res;
        },
        [backend.templates, getCurrentBranchId, refreshTemplates],
    );

    const unpublishTemplate = React.useCallback<
        WorkspaceAPI["unpublishTemplate"]
    >(
        async (id: string) => {
            const res = await backend.templates.unpublish(id);
            if (res.ok) {
                await refreshTemplates({ branchId: getCurrentBranchId() });
            }
            return res;
        },
        [backend.templates, getCurrentBranchId, refreshTemplates],
    );

    const deleteTemplate = React.useCallback<WorkspaceAPI["deleteTemplate"]>(
        async (id: string) => {
            const res = await backend.templates.delete(id);
            if (res.ok) {
                await refreshTemplates({ branchId: getCurrentBranchId() });
            }
            return res;
        },
        [backend.templates, getCurrentBranchId, refreshTemplates],
    );

    const invalidateTemplates = React.useCallback((): void => {
        setTemplates((s) => ({ ...s, updatedAt: undefined }));
    }, []);

    const resetTemplatesForBranch = React.useCallback((): void => {
        setTemplates((s) => ({ ...s, data: null, error: undefined }));
    }, []);

    return React.useMemo<TemplatesSliceApi>(
        () => ({
            templates,
            refreshTemplates,
            createTemplate,
            updateTemplate,
            cloneTemplate,
            publishTemplate,
            unpublishTemplate,
            deleteTemplate,
            invalidateTemplates,
            __setTemplatesState: setTemplates,
            resetTemplatesForBranch,
        }),
        [
            templates,
            refreshTemplates,
            createTemplate,
            updateTemplate,
            cloneTemplate,
            publishTemplate,
            unpublishTemplate,
            deleteTemplate,
            invalidateTemplates,
            resetTemplatesForBranch,
        ],
    );
}
