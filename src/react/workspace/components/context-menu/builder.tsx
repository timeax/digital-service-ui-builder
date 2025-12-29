import type { FileEntry } from '@/packages/library/backend';
import type { MenuItem } from '@/packages/library/providers/ContextMenuProvider';
import { FileManagerAPI } from '@/packages/library/providers/FileManagerContext';

export type ContextKind = 'file' | 'folder' | 'disk';

/* ───────────────────────── Base actions (zero-arg, target bound via closure) ───────────────────────── */
export interface BaseActions {
    preview(): void | Promise<void>;
    cut(): void | Promise<void>;
    copy(): void | Promise<void>;
    paste(): void | Promise<void>;
    download(): void | Promise<void>;
}

/* ───────────────────────── File & Folder action overrides ───────────────────────── */
export interface FileActions extends BaseActions {
    rename?(): void | Promise<void>;
    properties?(): void | Promise<void>;
    delete?(): void | Promise<void>;
}

export interface FolderActions extends BaseActions {
    open?(): void | Promise<void>;
    openInNewTab?(): void | Promise<void>;
    newFolder?(): void | Promise<void>;
    rename?(): void | Promise<void>;
    properties?(): void | Promise<void>;
    delete?(): void | Promise<void>;
}

/* ─────────────── Disk overrides (open, new folder, upload, rename, properties) ─────────────── */
export interface DiskActions {
    open?(): void | Promise<void>;
    newFolder?(): void | Promise<void>;
    upload?(): void | Promise<void>;
    rename?(): void | Promise<void>;
    properties?(): void | Promise<void>;
}

/* ───────────────────────── Targets (explicit per trigger) ───────────────────────── */
type From = { from: 'sidebar' | 'file-area' };
export type FileTarget = { file: FileEntry; selection?: FileEntry[] } & From;
export type FolderTarget = { disk: string; path: string; isRoot?: boolean } & From;
export type DiskTarget = { disk: string } & From;

/* ───────────────────────── Public overloads ───────────────────────── */
export function buildContext(kind: 'file', target: FileTarget, actions?: Partial<FileActions>): MenuItem[];
export function buildContext(kind: 'folder', target: FolderTarget, actions?: Partial<FolderActions>): MenuItem[];
export function buildContext(kind: 'disk', target: DiskTarget, actions?: Partial<DiskActions>): MenuItem[];

/* ───────────────────────── Implementation ───────────────────────── */
export function buildContext(
    kind: ContextKind,
    target: FileTarget | FolderTarget | DiskTarget,
    actions?: Partial<FileActions | FolderActions | DiskActions>,
): MenuItem[] {
    if (kind === 'file') {
        const { file, selection: sel } = target as FileTarget;
        const selection = (sel?.length ? sel : [file]) as FileEntry[];

        const defFile = (ctx: FileManagerAPI) => {
            const canPaste = !!(ctx as any).canPasteHere || !!(ctx as any).clipboard?.items?.length;
            const canRename = !!(file.permissions?.rename || file.permissions?.write);
            const canDelete = !!(file.permissions?.delete || file.permissions?.write);

            return {
                preview: () => ctx.getData(file.path) as any,
                cut: () => ctx.beginMove(selection),
                copy: () => ctx.beginCopy(selection),
                paste: () => ctx.pasteHere(),
                download: () => {
                    const url = ctx.downloadUrl(file.path, file.name);
                    if (url) window.open(url, '_blank');
                },
                rename: () => ctx.rename({ path: file.path, newName: file.name }),
                properties: () => {}, // UI-provided
                delete: () => ctx.delete(selection.map((f) => f.path)),
                guards: { canPaste, canRename, canDelete },
            };
        };

        const a = (actions ?? {}) as Partial<FileActions>;

        const items: MenuItem[] = [
            { label: 'Preview', onSelect: ({ ctx }) => (a.preview ?? defFile(ctx).preview)() },

            { divider: true },

            {
                label: 'Cut',
                hint: 'Ctrl+X',
                disabled: (ctx) => !a.cut && !defFile(ctx).guards.canRename,
                onSelect: ({ ctx }) => (a.cut ?? defFile(ctx).cut)(),
            },
            {
                label: 'Copy',
                hint: 'Ctrl+C',
                onSelect: ({ ctx }) => (a.copy ?? defFile(ctx).copy)(),
            },
            {
                label: 'Paste',
                hint: 'Ctrl+V',
                disabled: (ctx) => !defFile(ctx).guards.canPaste && !a.paste,
                onSelect: ({ ctx }) => (a.paste ?? defFile(ctx).paste)(),
            },

            { divider: true },

            { label: 'Download', onSelect: ({ ctx }) => (a.download ?? defFile(ctx).download)() },
            {
                label: 'Rename',
                hint: 'F2',
                disabled: (ctx) => !defFile(ctx).guards.canRename && !a.rename,
                onSelect: ({ ctx }) => (a.rename ?? defFile(ctx).rename)(),
            },

            { divider: true },

            { label: 'Properties', onSelect: ({ ctx }) => (a.properties ?? defFile(ctx).properties)() },
            {
                label: 'Delete',
                hint: 'Del',
                danger: true,
                disabled: (ctx) => !defFile(ctx).guards.canDelete && !a.delete,
                onSelect: ({ ctx }) => (a.delete ?? defFile(ctx).delete)(),
            },
        ];

        return items;
    }

    if (kind === 'folder') {
        const { disk, path, isRoot, from } = target as FolderTarget;
        const a = (actions ?? {}) as Partial<FolderActions>;

        const defFolder = (ctx: FileManagerAPI) => {
            const canPaste = !!(ctx as any).clipboard?.items?.length || !!(ctx as any).canPasteHere;

            return {
                preview: () => ctx.getData(path) as any,
                cut: () => ctx.beginMove([path]),
                copy: () => ctx.beginCopy([path]),
                paste: () => (ctx as any).pasteTo?.({ disk, path }) ?? ctx.pasteHere(),
                download: () => {
                    const url = ctx.downloadUrl(path);
                    if (url) window.open(url, '_blank');
                },

                open: () => ctx.cd({ disk, path }),
                openInNewTab: () => {},
                newFolder: () => (ctx as any).createFolder?.({ disk, path, name: 'New folder' }),
                rename: () => {}, // UI-provided
                properties: () => (ctx as any).openProperties?.({ disk, path }) ?? (ctx as any).properties?.({ disk, path }),
                delete: () =>
                    (ctx as any).addToTrash?.({ disk, paths: [path] }) ??
                    (ctx as any).delete?.({ disk, paths: [path] }) ??
                    (ctx as any).delete?.([path]),
                guards: { canPaste, isRoot: !!isRoot },
            };
        };

        const items: MenuItem[] = [
            { label: 'Preview', onSelect: ({ ctx }) => (a.preview ?? defFolder(ctx).preview)() },

            { divider: true },

            {
                label: 'Cut',
                hint: 'Ctrl+X',
                disabled: (_ctx) => !!isRoot && !a.cut,
                onSelect: ({ ctx }) => (a.cut ?? defFolder(ctx).cut)(),
            },
            {
                label: 'Copy',
                hint: 'Ctrl+C',
                onSelect: ({ ctx }) => (a.copy ?? defFolder(ctx).copy)(),
            },
            {
                label: 'Paste',
                hint: 'Ctrl+V',
                disabled: (ctx) => !defFolder(ctx).guards.canPaste && !a.paste,
                onSelect: ({ ctx }) => (a.paste ?? defFolder(ctx).paste)(),
            },

            { divider: true },

            { label: 'Download', onSelect: ({ ctx }) => (a.download ?? defFolder(ctx).download)() },
            ...(a.open || a.openInNewTab
                ? [
                      { label: 'Open', onSelect: ({ ctx }) => (a.open ?? defFolder(ctx).open)() } as MenuItem,
                      ...(a.openInNewTab ? [{ label: 'Open in new tab', onSelect: () => a.openInNewTab!() } as MenuItem] : []),
                  ]
                : []),
            //@ts-ignore
            ...(from == 'sidebar' ? [{ label: 'New folder…', onSelect: ({ ctx }) => (a.newFolder ?? defFolder(ctx).newFolder)() }] : []),
            {
                label: 'Rename',
                hint: 'F2',
                disabled: (_ctx) => !!isRoot && !a.rename,
                onSelect: ({ ctx }) => (a.rename ?? defFolder(ctx).rename)(),
            },

            { divider: true },

            { label: 'Properties', onSelect: ({ ctx }) => (a.properties ?? defFolder(ctx).properties)() },
            {
                label: 'Delete',
                hint: 'Del',
                danger: true,
                disabled: (_ctx) => !!isRoot && !a.delete,
                onSelect: ({ ctx }) => (a.delete ?? defFolder(ctx).delete)(),
            },
        ];

        return items;
    }

    // kind === 'disk'
    {
        const { disk, from } = target as DiskTarget;
        const da = (actions ?? {}) as Partial<DiskActions>;

        const defDisk = (ctx: FileManagerAPI) => ({
            open: () => ctx.cd({ disk, path: '' }),
            newFolder: () => (ctx as any).createFolder?.({ disk, path: '', name: 'New folder' }),
            upload: () => (ctx as any).openUploadPicker?.({ disk, path: '' }) ?? (ctx as any).upload?.({ disk, path: '' }),
            rename: () => {}, // UI-provided
            properties: () => {}, // UI-provided
        });

        const items: MenuItem[] = [
            { label: 'Open', onSelect: ({ ctx }) => (da.open ?? defDisk(ctx).open)() },

            { divider: true },
            // @ts-expect-error
            ...(from == 'sidebar' ? [{ label: 'New folder…', onSelect: ({ ctx }) => (da.newFolder ?? defDisk(ctx).newFolder)() }] : []),
            { label: 'Upload…', onSelect: ({ ctx }) => (da.upload ?? defDisk(ctx).upload)() },

            { divider: true },

            { label: 'Rename', onSelect: ({ ctx }) => (da.rename ?? defDisk(ctx).rename)() },
            { label: 'Properties', onSelect: ({ ctx }) => (da.properties ?? defDisk(ctx).properties)() },
        ];

        return items;
    }
}
