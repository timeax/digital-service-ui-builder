// src/core/policy.ts
import type { DynamicRule, ValidatorOptions } from "@/schema/validation";

export type PolicyDiagnostic = {
    ruleIndex: number;
    ruleId?: string;
    severity: "error" | "warning";
    message: string;
    path?: string; // e.g. "filter.role", "op"
};

const ALLOWED_SCOPES = new Set<DynamicRule["scope"]>([
    "global",
    "visible_group",
]);
const ALLOWED_SUBJECTS = new Set<DynamicRule["subject"]>(["services"]);
const ALLOWED_OPS = new Set<DynamicRule["op"]>([
    "all_equal",
    "unique",
    "no_mix",
    "all_true",
    "any_true",
    "max_count",
    "min_count",
]);
const ALLOWED_ROLES = new Set<NonNullable<DynamicRule["filter"]>["role"]>([
    "base",
    "utility",
    "both",
]);
const ALLOWED_SEVERITIES = new Set<NonNullable<DynamicRule["severity"]>>([
    "error",
    "warning",
]);

const ALLOWED_WHERE_OPS = new Set<
    NonNullable<NonNullable<DynamicRule["filter"]>["where"]>[number]["op"]
>(["eq", "neq", "in", "nin", "exists", "truthy", "falsy"]);

type WhereClause = NonNullable<
    NonNullable<DynamicRule["filter"]>["where"]
>[number];

function normaliseWhere(
    src: unknown,
    d: PolicyDiagnostic[],
    i: number,
    id: string,
): WhereClause[] | undefined {
    if (src === undefined) return undefined;
    if (!Array.isArray(src)) {
        d.push({
            ruleIndex: i,
            ruleId: id,
            severity: "warning",
            message: "filter.where must be an array; ignored.",
            path: "filter.where",
        });
        return undefined;
    }

    const out: WhereClause[] = [];

    src.forEach((raw, j) => {
        const obj: any = raw && typeof raw === "object" ? raw : null;
        const path: string | undefined =
            typeof obj?.path === "string" && obj.path.trim()
                ? obj.path.trim()
                : undefined;

        if (!path) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: `filter.where[${j}].path must be a non-empty string; entry ignored.`,
                path: `filter.where[${j}].path`,
            });
            return;
        }

        if (!path.startsWith("service.")) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: `filter.where[${j}].path should start with "service." for subject "services".`,
                path: `filter.where[${j}].path`,
            });
        }

        const opRaw: unknown = obj?.op;
        const op: WhereClause["op"] =
            opRaw === undefined
                ? "eq"
                : typeof opRaw === "string" &&
                    ALLOWED_WHERE_OPS.has(opRaw as any)
                  ? (opRaw as any)
                  : "eq";

        if (
            opRaw !== undefined &&
            !(typeof opRaw === "string" && ALLOWED_WHERE_OPS.has(opRaw as any))
        ) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: `Unknown filter.where[${j}].op; defaulted to "eq".`,
                path: `filter.where[${j}].op`,
            });
        }

        const value: unknown = obj?.value;

        // validate value requirements lightly (non-fatal)
        if (op === "exists" || op === "truthy" || op === "falsy") {
            if (value !== undefined) {
                d.push({
                    ruleIndex: i,
                    ruleId: id,
                    severity: "warning",
                    message: `filter.where[${j}] op "${op}" does not use "value".`,
                    path: `filter.where[${j}].value`,
                });
            }
        } else if (op === "in" || op === "nin") {
            if (!Array.isArray(value)) {
                d.push({
                    ruleIndex: i,
                    ruleId: id,
                    severity: "warning",
                    message: `filter.where[${j}] op "${op}" expects an array "value".`,
                    path: `filter.where[${j}].value`,
                });
            }
        }

        out.push({ path, op, value });
    });

    return out.length ? out : undefined;
}

/**
 * Compile & validate arbitrary JSON into DynamicRule[] with defaults:
 * - scope: (default) "visible_group"
 * - subject: (default) "services"
 * - filter.role: (default) "both"
 * - severity: (default) "error"
 * - projection: (default) "service.id"
 *
 * Returns normalized rules + diagnostics (errors/warnings).
 */
export function compilePolicies(raw: unknown): {
    policies: DynamicRule[];
    diagnostics: PolicyDiagnostic[];
} {
    const diagnostics: PolicyDiagnostic[] = [];
    const policies: DynamicRule[] = [];

    if (!Array.isArray(raw)) {
        diagnostics.push({
            ruleIndex: -1,
            severity: "error",
            message: "Policies root must be an array.",
        });
        return { policies, diagnostics };
    }

    raw.forEach((entry, i) => {
        const d: PolicyDiagnostic[] = [];
        const src = entry && typeof entry === "object" ? (entry as any) : {};
        let id: string | undefined =
            typeof src.id === "string" && src.id.trim()
                ? src.id.trim()
                : undefined;

        // id default
        if (!id) {
            id = `policy_${i + 1}`;
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: 'Missing "id"; generated automatically.',
                path: "id",
            });
        }

        // scope default + validation
        let scope: DynamicRule["scope"] = ALLOWED_SCOPES.has(src.scope)
            ? src.scope
            : src.scope === undefined
              ? "visible_group"
              : "visible_group";
        if (src.scope !== undefined && !ALLOWED_SCOPES.has(src.scope)) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: 'Unknown "scope"; defaulted to "visible_group".',
                path: "scope",
            });
        }

        // subject default + validation
        let subject: DynamicRule["subject"] = ALLOWED_SUBJECTS.has(src.subject)
            ? src.subject
            : "services";
        if (src.subject !== undefined && !ALLOWED_SUBJECTS.has(src.subject)) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: 'Unknown "subject"; defaulted to "services".',
                path: "subject",
            });
        }

        // op required & valid
        const op: DynamicRule["op"] = src.op;
        if (!ALLOWED_OPS.has(op)) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "error",
                message: `Invalid "op": ${String(op)}.`,
                path: "op",
            });
        }

        // projection default
        let projection: string | undefined =
            typeof src.projection === "string" && src.projection.trim()
                ? src.projection.trim()
                : "service.id";

        // For services subject, encourage service.* projection
        if (
            subject === "services" &&
            projection &&
            !projection.startsWith("service.")
        ) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message:
                    'Projection should start with "service." for subject "services".',
                path: "projection",
            });
        }

        const filterSrc =
            src.filter && typeof src.filter === "object"
                ? (src.filter as DynamicRule["filter"])
                : undefined;

        const role: NonNullable<DynamicRule["filter"]>["role"] =
            filterSrc?.role && ALLOWED_ROLES.has(filterSrc.role)
                ? filterSrc.role
                : "both";

        if (filterSrc?.role && !ALLOWED_ROLES.has(filterSrc.role)) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: 'Unknown filter.role; defaulted to "both".',
                path: "filter.role",
            });
        }

        const filter: DynamicRule["filter"] | undefined = {
            role,
            tag_id:
                filterSrc?.tag_id !== undefined
                    ? Array.isArray(filterSrc.tag_id)
                        ? filterSrc.tag_id
                        : [filterSrc.tag_id]
                    : undefined,
            field_id:
                filterSrc?.field_id !== undefined
                    ? Array.isArray(filterSrc.field_id)
                        ? filterSrc.field_id
                        : [filterSrc.field_id]
                    : undefined,
            where: normaliseWhere((filterSrc as any)?.where, d, i, id),
        };

        // severity default
        const severity: NonNullable<DynamicRule["severity"]> =
            ALLOWED_SEVERITIES.has(src.severity) ? src.severity : "error";
        if (
            src.severity !== undefined &&
            !ALLOWED_SEVERITIES.has(src.severity)
        ) {
            d.push({
                ruleIndex: i,
                ruleId: id,
                severity: "warning",
                message: 'Unknown "severity"; defaulted to "error".',
                path: "severity",
            });
        }

        // value requirements by op
        const value = src.value;
        if (op === "max_count" || op === "min_count") {
            if (!(typeof value === "number" && Number.isFinite(value))) {
                d.push({
                    ruleIndex: i,
                    ruleId: id,
                    severity: "error",
                    message: `"${op}" requires numeric "value".`,
                    path: "value",
                });
            }
        } else if (op === "all_true" || op === "any_true") {
            if (value !== undefined) {
                d.push({
                    ruleIndex: i,
                    ruleId: id,
                    severity: "warning",
                    message: `"${op}" ignores "value"; it checks all/any true.`,
                    path: "value",
                });
            }
        } else {
            if (value !== undefined) {
                d.push({
                    ruleIndex: i,
                    ruleId: id,
                    severity: "warning",
                    message: `"${op}" does not use "value".`,
                    path: "value",
                });
            }
        }

        // assemble rule if no fatal (error-level) diagnostics for op/value
        const hasFatal = d.some((x) => x.severity === "error");
        if (!hasFatal) {
            const rule: DynamicRule = {
                id,
                scope,
                subject,
                filter,
                projection,
                op,
                value: value as any,
                severity,
                message:
                    typeof src.message === "string" ? src.message : undefined,
            };
            policies.push(rule);
        }

        diagnostics.push(...d);
    });

    return { policies, diagnostics };
}

/** Split diagnostics for convenience in UI */
export function splitPolicyDiagnostics(diags: PolicyDiagnostic[]): {
    errors: PolicyDiagnostic[];
    warnings: PolicyDiagnostic[];
} {
    return {
        errors: diags.filter((d) => d.severity === "error"),
        warnings: diags.filter((d) => d.severity === "warning"),
    };
}

/**
 * Convenience helper: compile policies and pass to validator options.
 * You can use this in your editor before calling validate().
 */
export function withCompiledPolicies(
    opts: ValidatorOptions,
    rawPolicies: unknown,
): { opts: ValidatorOptions; diagnostics: PolicyDiagnostic[] } {
    const { policies, diagnostics } = compilePolicies(rawPolicies);
    return { opts: { ...opts, policies }, diagnostics };
}
