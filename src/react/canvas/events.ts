// Lightweight, typed event bus
export type EventMap = Record<string, unknown>;

export class EventBus<E extends EventMap> {
    private listeners = new Map<keyof E, Set<(p: any) => void>>();

    on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler as any);
        this.listeners.set(event, set);
        return () => {
            set.delete(handler as any);
        };
    }

    once<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
        const off = this.on(event, (p) => {
            off();
            handler(p);
        });
        return off;
    }

    emit<K extends keyof E>(event: K, payload: E[K]): void {
        const set = this.listeners.get(event);
        if (!set || set.size === 0) return;
        for (const h of Array.from(set)) try {
            (h as any)(payload);
        } catch { /* swallow */
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}