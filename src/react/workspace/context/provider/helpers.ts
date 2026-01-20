// src/react/workspace/context/provider/helpers.ts
import type { BackendError, LiveOptions } from "../backend";
import type { DgpServiceCapability, DgpServiceMap } from "@/schema/provider";
import type { RunResult } from "./types";

// Stable default — avoids a new object per render
export const LIVE_OFF: LiveOptions = Object.freeze({ mode: "off" as const });

function isBackendErrorLike(e: unknown): e is BackendError {
    if (!e || typeof e !== "object") return false;
    const obj: Record<string, unknown> = e as Record<string, unknown>;
    return typeof obj.code === "string" && typeof obj.message === "string";
}

export function toBackendError(e: unknown): BackendError {
    if (isBackendErrorLike(e)) return e;

    // Preserve real Error information (without assuming BackendError supports extra fields)
    if (e instanceof Error) {
        const name: string = e.name || "Error";
        const msg: string = e.message || String(e);
        return {
            code: "runtime_error",
            message: `${name}: ${msg}`,
        };
    }

    if (typeof e === "string") {
        return { code: "unknown_error", message: e };
    }

    try {
        return { code: "unknown_error", message: JSON.stringify(e) };
    } catch {
        return { code: "unknown_error", message: String(e ?? "Unknown error") };
    }
}

/**
 * Sequential task runner (ordering preserved).
 * - tolerant=true: collects errors and continues
 * - tolerant=false: throws on first failure
 */
export async function runTasks(
    tasks: Array<() => Promise<unknown>>,
    tolerant: boolean,
): Promise<RunResult> {
    const errors: BackendError[] = [];
    for (const t of tasks) {
        try {
            await t();
        } catch (e) {
            if (!tolerant) throw e;
            errors.push(toBackendError(e));
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Parallel task runner (ordering not guaranteed).
 * Kept separate so callers can choose intentionally.
 */
export async function runTasksParallel(
    tasks: Array<() => Promise<unknown>>,
    tolerant: boolean,
): Promise<RunResult> {
    if (tasks.length === 0) return { ok: true };

    const results: Array<{ ok: true } | { ok: false; error: BackendError }> =
        await Promise.all(
            tasks.map(async (t) => {
                try {
                    await t();
                    return { ok: true } as const;
                } catch (e) {
                    if (!tolerant) throw e;
                    return { ok: false, error: toBackendError(e) } as const;
                }
            }),
        );

    const errors: BackendError[] = results
        .filter((r) => !r.ok)
        .map((r) => (r as { ok: false; error: BackendError }).error);

    return errors.length ? { ok: false, errors } : { ok: true };
}

export function toServiceMap(
    input?: readonly DgpServiceCapability[] | DgpServiceMap | null,
): DgpServiceMap | null {
    if (!input) return null;

    if (Array.isArray(input)) {
        const out: Record<string, DgpServiceCapability> = Object.create(null);
        for (const s of input) out[s.id] = s;
        return out as unknown as DgpServiceMap;
    }

    return input as DgpServiceMap;
}
