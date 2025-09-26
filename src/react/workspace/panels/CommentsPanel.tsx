import React from 'react';
import {useUi} from '../ui-bridge';
import {useCanvasAPI} from '../../canvas/context';

// ──────────────────────────────────────────────────────────────────────────────
// Lightweight comment types (compatible with a wide range of backends)
// ──────────────────────────────────────────────────────────────────────────────
export type CommentAuthor = {
    id: string | number;
    name?: string;
    avatar_url?: string;
};

export type CommentNode = {
    id: string;
    body: string;
    author?: CommentAuthor;
    created_at: number | string | Date;
    resolved?: boolean;
};

export type CommentThread = CommentNode & {
    targetIds?: string[];       // ids in the graph this thread is attached to
    replies?: CommentNode[];
};

// Minimal CanvasAPI comments surface the panel tries to use if available.
type CommentsAdapter = {
    all?: () => CommentThread[];
    onChange?: (cb: (threads: CommentThread[]) => void) => () => void;
    create?: (input: { body: string; targetIds?: string[] }) => Promise<void> | void;
    reply?: (threadId: string, input: { body: string }) => Promise<void> | void;
    resolve?: (threadId: string) => Promise<void> | void;
    reopen?: (threadId: string) => Promise<void> | void;
    remove?: (threadId: string) => Promise<void> | void;
};

function useCommentsAdapter(): {
    api: ReturnType<typeof useCanvasAPI> | null;
    comments: CommentsAdapter | null;
    focus: (ids: string[]) => void;
    selectionIds: string[];
} {
    try {
        const api = useCanvasAPI();
        const comments: CommentsAdapter | null =
            (api as any).comments ?? (api as any).commentsStore ?? null;

        // current selection from CanvasAPI (if exposed); else empty
        const selectionIds: string[] = Array.from(
            ((api as any).selection?.all?.() as Set<string> | undefined) ?? []
        );

        const focus = (ids: string[]) => {
            try {
                (api as any).focus?.(ids);
            } catch { /* noop */
            }
        };

        return {api, comments, focus, selectionIds};
    } catch {
        return {
            api: null, comments: null, focus: () => {
            }, selectionIds: []
        };
    }
}

function timeAgo(input: number | string | Date): string {
    const t = typeof input === 'number' ? input : new Date(input).getTime();
    const delta = Date.now() - t;
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    const w = Math.floor(d / 7);
    return `${w}w`;
}

type Filter = 'open' | 'resolved' | 'all';
type Sort = 'new' | 'old';

export function CommentsPanel() {
    const {Button, cn} = useUi();
    const {comments, focus, selectionIds} = useCommentsAdapter();

    // threads + live updates
    const [threads, setThreads] = React.useState<CommentThread[]>(() => comments?.all?.() ?? []);
    React.useEffect(() => {
        setThreads(comments?.all?.() ?? []);
        const off = comments?.onChange?.((next) => setThreads(next));
        return () => {
            off?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [comments?.onChange, comments?.all]);

    const [filter, setFilter] = React.useState<Filter>('open');
    const [sort, setSort] = React.useState<Sort>('new');
    const [q, setQ] = React.useState('');
    const [activeId, setActiveId] = React.useState<string | null>(null);

    const [newBody, setNewBody] = React.useState('');
    const [replyBody, setReplyBody] = React.useState('');

    const filtered = React.useMemo(() => {
        let list = threads.slice();
        if (filter !== 'all') {
            const wantResolved = filter === 'resolved';
            list = list.filter(t => !!t.resolved === wantResolved);
        }
        if (q.trim()) {
            const k = q.toLowerCase();
            list = list.filter(t =>
                t.body.toLowerCase().includes(k) ||
                (t.replies ?? []).some(r => r.body.toLowerCase().includes(k))
            );
        }
        list.sort((a, b) => {
            const ta = +new Date(a.created_at);
            const tb = +new Date(b.created_at);
            return sort === 'new' ? tb - ta : ta - tb;
        });
        return list;
    }, [threads, filter, sort, q]);

    const active = filtered.find(t => t.id === activeId) ?? filtered[0] ?? null;

    // actions (no-ops if adapter method missing)
    const create = async () => {
        const body = newBody.trim();
        if (!body) return;
        try {
            await comments?.create?.({body, targetIds: selectionIds.length ? selectionIds : undefined});
            setNewBody('');
        } catch { /* surface via toast in host if needed */
        }
    };

    const reply = async () => {
        if (!active) return;
        const body = replyBody.trim();
        if (!body) return;
        try {
            await comments?.reply?.(active.id, {body});
            setReplyBody('');
        } catch {
        }
    };

    const toggleResolve = async () => {
        if (!active) return;
        try {
            if (active.resolved) await comments?.reopen?.(active.id);
            else await comments?.resolve?.(active.id);
        } catch {
        }
    };

    const remove = async () => {
        if (!active) return;
        try {
            await comments?.remove?.(active.id);
        } catch {
        }
    };

    const canWrite = !!(comments?.create || comments?.reply);

    return (
        <div className="flex h-full">
            {/* List */}
            <aside className="w-[44%] min-w-[280px] max-w-[420px] border-r flex flex-col">
                <div className="px-3 pt-3 pb-2">
                    <div className="flex items-center gap-2">
                        <select
                            value={filter}
                            onChange={(e) => setFilter(e.target.value as Filter)}
                            className="h-8 rounded border bg-background px-2 text-sm"
                        >
                            <option value="open">Open</option>
                            <option value="resolved">Resolved</option>
                            <option value="all">All</option>
                        </select>
                        <select
                            value={sort}
                            onChange={(e) => setSort(e.target.value as Sort)}
                            className="h-8 rounded border bg-background px-2 text-sm"
                        >
                            <option value="new">Newest</option>
                            <option value="old">Oldest</option>
                        </select>
                        <input
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search…"
                            className="h-8 flex-1 rounded border bg-background px-2 text-sm"
                        />
                    </div>
                </div>
                <div className="px-3 pb-2 text-xs text-muted-foreground">
                    {filtered.length} thread{filtered.length === 1 ? '' : 's'}
                </div>
                <div className="flex-1 overflow-auto">
                    <ul>
                        {filtered.map(t => {
                            const isActive = (active?.id ?? activeId) === t.id;
                            const replyCount = t.replies?.length ?? 0;
                            const targets = t.targetIds?.length ?? 0;
                            return (
                                <li
                                    key={t.id}
                                    className={cn(
                                        'px-3 py-2 border-b cursor-pointer hover:bg-muted',
                                        isActive && 'bg-accent/30'
                                    )}
                                    onClick={() => setActiveId(t.id)}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="truncate text-sm font-medium">{t.body.split('\n')[0]}</div>
                                        <div className="text-xs text-muted-foreground">{timeAgo(t.created_at)}</div>
                                    </div>
                                    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                                        <span>{replyCount} repl{replyCount === 1 ? 'y' : 'ies'}</span>
                                        {targets ? <span>{targets} target{targets === 1 ? '' : 's'}</span> : null}
                                        {t.resolved ? <span className="text-emerald-600">resolved</span> :
                                            <span className="text-amber-600">open</span>}
                                    </div>
                                </li>
                            );
                        })}
                        {filtered.length === 0 && (
                            <li className="px-3 py-6 text-sm text-muted-foreground">No threads.</li>
                        )}
                    </ul>
                </div>

                {/* New thread composer */}
                <div className="border-t p-3">
                    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">New
                        comment
                    </div>
                    <textarea
                        value={newBody}
                        onChange={(e) => setNewBody(e.target.value)}
                        placeholder={selectionIds.length ? 'Comment on current selection…' : 'Comment…'}
                        rows={3}
                        className="w-full rounded border bg-background p-2 text-sm"
                    />
                    <div className="mt-2 flex items-center justify-between">
                        <div className="text-xs text-muted-foreground">
                            {selectionIds.length ? `attached to ${selectionIds.length} target${selectionIds.length === 1 ? '' : 's'}` : 'no targets'}
                        </div>
                        <Button size="sm" disabled={!canWrite || !newBody.trim()} onClick={create}>Post</Button>
                    </div>
                </div>
            </aside>

            {/* Thread detail */}
            <main className="flex-1 flex flex-col">
                <div className="px-3 py-2 border-b flex items-center justify-between">
                    <div className="text-sm font-medium">{active ? 'Thread' : 'No thread selected'}</div>
                    {active ? (
                        <div className="flex items-center gap-2">
                            {active.targetIds?.length ? (
                                <Button variant="outline" size="sm" onClick={() => focus(active.targetIds!)}>
                                    Focus targets
                                </Button>
                            ) : null}
                            <Button
                                variant={active.resolved ? 'outline' : 'secondary'}
                                size="sm"
                                onClick={toggleResolve}
                            >
                                {active.resolved ? 'Reopen' : 'Resolve'}
                            </Button>
                            <Button variant="destructive" size="sm" onClick={remove}>Delete</Button>
                        </div>
                    ) : null}
                </div>

                {!active ? (
                    <div className="p-6 text-sm text-muted-foreground">Select a thread from the list.</div>
                ) : (
                    <>
                        <div className="flex-1 overflow-auto p-3 space-y-4">
                            {/* root message */}
                            <CommentBubble node={active}/>

                            {/* replies */}
                            {(active.replies ?? []).map(r => (
                                <CommentBubble key={r.id} node={r} isReply/>
                            ))}
                        </div>

                        {/* reply box */}
                        <div className="border-t p-3">
                            <div
                                className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Reply
                            </div>
                            <textarea
                                value={replyBody}
                                onChange={(e) => setReplyBody(e.target.value)}
                                rows={3}
                                className="w-full rounded border bg-background p-2 text-sm"
                                placeholder="Write a reply…"
                            />
                            <div className="mt-2 flex items-center justify-end">
                                <Button size="sm" disabled={!canWrite || !replyBody.trim()}
                                        onClick={reply}>Reply</Button>
                            </div>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}

function CommentBubble({node, isReply = false}: { node: CommentNode; isReply?: boolean }) {
    const {cn} = useUi();
    const initial = (node.author?.name ?? 'U').slice(0, 1).toUpperCase();
    return (
        <div className={cn('flex gap-3', isReply && 'pl-6')}>
            <div className="h-8 w-8 shrink-0 rounded-full bg-muted grid place-items-center text-xs font-medium">
                {initial}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <div className="text-sm font-medium truncate">{node.author?.name ?? 'Unknown'}</div>
                    <div className="text-xs text-muted-foreground">{timeAgo(node.created_at)}</div>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm">{node.body}</div>
            </div>
        </div>
    );
}