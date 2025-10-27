// noinspection JSIgnoredPromiseFromCall

export type RetryStatus = 'scheduled' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

export type RetryOptions = {
    enabled?: boolean;          // default true
    maxAttempts?: number;       // default 5
    baseDelayMs?: number;       // default 800
    maxDelayMs?: number;        // default 20_000
    jitter?: boolean;           // default true
    /** Run the first attempt immediately (no initial delay) */
    immediateFirst?: boolean;
};

export type RetryJob = {
    /** Stable id for de-duplication (e.g., "comments:create_thread:loc_abc") */
    id: string;
    /** Called on each attempt; return true to signal success, false/throw to retry */
    perform: (attempt: number) => Promise<boolean>;
    onStatus?: (status: RetryStatus, meta?: { attempt: number; nextDelayMs?: number; error?: unknown }) => void;
};

export class RetryQueue {
    private readonly opts: Required<RetryOptions>;
    private jobs = new Map<string, { job: RetryJob; attempt: number; timer?: any; cancelled?: boolean }>();
    private paused = false;

    constructor(opts: RetryOptions = {}) {
        this.opts = {
            enabled: opts.enabled ?? true,
            maxAttempts: opts.maxAttempts ?? 5,
            baseDelayMs: opts.baseDelayMs ?? 800,
            maxDelayMs: opts.maxDelayMs ?? 20_000,
            jitter: opts.jitter ?? true,
            immediateFirst: opts.immediateFirst ?? false,
        };
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.flush();
    }

    /** Enqueue or no-op if a job with same id already exists */
    enqueue(job: RetryJob): boolean {
        if (!this.opts.enabled) return false;
        if (this.jobs.has(job.id)) return false;
        this.jobs.set(job.id, {job, attempt: 0});
        job.onStatus?.('scheduled', {attempt: 0});
        this.kick(job.id);
        return true;
    }

    /** Force retry now (resets backoff); returns false if not found */
    triggerNow(id: string): boolean {
        const rec = this.jobs.get(id);
        if (!rec) return false;
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = undefined;
        this.kick(id, true);
        return true;
    }

    cancel(id: string): boolean {
        const rec = this.jobs.get(id);
        if (!rec) return false;
        if (rec.timer) clearTimeout(rec.timer);
        rec.cancelled = true;
        rec.job.onStatus?.('cancelled', {attempt: rec.attempt});
        this.jobs.delete(id);
        return true;
    }

    pendingIds(): string[] {
        return Array.from(this.jobs.keys());
    }

    size(): number {
        return this.jobs.size;
    }

    isQueued(id: string): boolean {
        return this.jobs.has(id);
    }

    drain(): void {
        for (const [id, rec] of this.jobs.entries()) {
            if (rec.timer) clearTimeout(rec.timer);
            rec.cancelled = true;
            rec.job.onStatus?.('cancelled', {attempt: rec.attempt});
            this.jobs.delete(id);
        }
    }

    private flush() {
        for (const id of this.jobs.keys()) this.kick(id);
    }

    private delayFor(attempt: number): number {
        const {baseDelayMs, maxDelayMs, jitter} = this.opts;
        const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
        if (!jitter) return exp;
        const r = Math.random() * 0.4 + 0.8; // 0.8x .. 1.2x
        return Math.min(maxDelayMs, Math.floor(exp * r));
    }

    private async kick(id: string, immediate = false) {
        const rec = this.jobs.get(id);
        if (!rec || rec.cancelled) return;

        if (this.paused && !immediate) return;

        const attempt = rec.attempt + 1;
        const run = async () => {
            if (rec.cancelled) return;
            rec.job.onStatus?.('retrying', {attempt});
            try {
                const ok = await rec.job.perform(attempt);
                if (ok) {
                    rec.job.onStatus?.('succeeded', {attempt});
                    this.jobs.delete(id);
                    return;
                }
            } catch (err) {
                // fallthrough to schedule next
                rec.job.onStatus?.('failed', {attempt, error: err});
            }

            if (attempt >= this.opts.maxAttempts) {
                rec.job.onStatus?.('failed', {attempt});
                this.jobs.delete(id);
                return;
            }

            rec.attempt = attempt;
            const delay = this.delayFor(attempt);
            rec.job.onStatus?.('scheduled', {attempt, nextDelayMs: delay});
            rec.timer = setTimeout(() => this.kick(id), delay);
        };

        if (immediate) await run();
        else {
            // First attempt: respect immediateFirst option; otherwise, schedule immediately
            const delay = this.opts.immediateFirst && attempt === 1 ? 0 : this.delayFor(attempt);

            if (delay) {
                rec.job.onStatus?.('scheduled', {attempt: 0, nextDelayMs: delay});
                rec.timer = setTimeout(run, delay);
            } else {
                void run();
            }
        }
    }
}