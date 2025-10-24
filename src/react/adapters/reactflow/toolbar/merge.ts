import type {ResolvedTools, ToolDescriptor, ToolsConfig} from './types';

export function resolveTools(config: ToolsConfig): ResolvedTools {
    const base = dedupeById(config.base ?? []);
    const extended = dedupeById(config.extend ?? []);
    const hidden = new Set(config.hidden ?? []);

    const byId = new Map<string, ToolDescriptor>();
    for (const t of base) byId.set(t.id, t);
    for (const t of extended) byId.set(t.id, t);

    let arr = Array.from(byId.values()).filter(t => !hidden.has(t.id));
    arr = sortWithAnchors(arr);
    arr.sort((a, b) => {
        const ga = a.group ?? 'view';
        const gb = b.group ?? 'view';
        if (ga !== gb) return ga < gb ? -1 : 1;
        const oa = a.order ?? 0;
        const ob = b.order ?? 0;
        return oa - ob;
    });

    return arr;
}

function dedupeById(list: ToolDescriptor[]): ToolDescriptor[] {
    const seen = new Set<string>();
    const out: ToolDescriptor[] = [];
    for (const t of list) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
    }
    return out;
}

function sortWithAnchors(list: ToolDescriptor[]): ToolDescriptor[] {
    const byId = new Map(list.map(t => [t.id, t]));
    const out: ToolDescriptor[] = [];
    const placed = new Set<string>();

    const place = (t: ToolDescriptor) => {
        if (placed.has(t.id)) return;
        if (t.insertBefore && byId.has(t.insertBefore)) {
            const anchor = byId.get(t.insertBefore)!;
            place(anchor);
            const idx = out.findIndex(x => x.id === anchor.id);
            out.splice(idx, 0, t);
            placed.add(t.id);
            return;
        }
        if (t.insertAfter && byId.has(t.insertAfter)) {
            place(byId.get(t.insertAfter)!);
            const idx = out.findIndex(x => x.id === t.insertAfter);
            out.splice(idx + 1, 0, t);
            placed.add(t.id);
            return;
        }
        out.push(t);
        placed.add(t.id);
    };

    for (const t of list) place(t);
    return out;
}