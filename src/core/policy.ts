// src/core/policy.ts
import type { DynamicRule, ValidatorOptions } from '../schema/validation';

export type PolicyDiagnostic = {
    ruleIndex: number;
    ruleId?: string;
    severity: 'error' | 'warning';
    message: string;
    path?: string; // e.g. "filter.role", "op"
};

const ALLOWED_SCOPES = new Set<DynamicRule['scope']>(['global', 'visible_group']);
const ALLOWED_SUBJECTS = new Set<DynamicRule['subject']>(['services']);
const ALLOWED_OPS = new Set<DynamicRule['op']>([
    'all_equal', 'unique', 'no_mix', 'all_true', 'any_true', 'max_count', 'min_count',
]);
const ALLOWED_ROLES = new Set<NonNullable<DynamicRule['filter']>['role']>(['base', 'utility', 'both']);
const ALLOWED_SEVERITIES = new Set<NonNullable<DynamicRule['severity']>>(['error', 'warning']);

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
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
            severity: 'error',
            message: 'Policies root must be an array.',
        });
        return { policies, diagnostics };
    }

    raw.forEach((entry, i) => {
        const d: PolicyDiagnostic[] = [];
        const src = (entry && typeof entry === 'object') ? (entry as any) : {};
        let id: string | undefined = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : undefined;

        // id default
        if (!id) {
            id = `policy_${i + 1}`;
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Missing "id"; generated automatically.', path: 'id' });
        }

        // scope default + validation
        let scope: DynamicRule['scope'] =
            ALLOWED_SCOPES.has(src.scope) ? src.scope : (src.scope === undefined ? 'visible_group' : 'visible_group');
        if (src.scope !== undefined && !ALLOWED_SCOPES.has(src.scope)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "scope"; defaulted to "visible_group".', path: 'scope' });
        }

        // subject default + validation
        let subject: DynamicRule['subject'] =
            ALLOWED_SUBJECTS.has(src.subject) ? src.subject : 'services';
        if (src.subject !== undefined && !ALLOWED_SUBJECTS.has(src.subject)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "subject"; defaulted to "services".', path: 'subject' });
        }

        // op required & valid
        const op: DynamicRule['op'] = src.op;
        if (!ALLOWED_OPS.has(op)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'error', message: `Invalid "op": ${String(op)}.`, path: 'op' });
        }

        // projection default
        let projection: string | undefined = typeof src.projection === 'string' && src.projection.trim()
            ? src.projection.trim()
            : 'service.id';

        // For services subject, encourage service.* projection
        if (subject === 'services' && projection && !projection.startsWith('service.')) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Projection should start with "service." for subject "services".', path: 'projection' });
        }

        // filter defaults & shape
        const filterSrc = (src.filter && typeof src.filter === 'object') ? src.filter as DynamicRule['filter'] : undefined;
        const role: NonNullable<DynamicRule['filter']>['role'] =
            filterSrc?.role && ALLOWED_ROLES.has(filterSrc.role) ? filterSrc.role : 'both';
        if (filterSrc?.role && !ALLOWED_ROLES.has(filterSrc.role)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown filter.role; defaulted to "both".', path: 'filter.role' });
        }

        const filter: DynamicRule['filter'] | undefined = {
            role,
            handler_id: filterSrc?.handler_id !== undefined ? (Array.isArray(filterSrc.handler_id) ? filterSrc.handler_id : [filterSrc.handler_id]) : undefined,
            platform_id: filterSrc?.platform_id !== undefined ? (Array.isArray(filterSrc.platform_id) ? filterSrc.platform_id : [filterSrc.platform_id]) : undefined,
            tag_id: filterSrc?.tag_id !== undefined ? (Array.isArray(filterSrc.tag_id) ? filterSrc.tag_id : [filterSrc.tag_id]) : undefined,
            field_id: filterSrc?.field_id !== undefined ? (Array.isArray(filterSrc.field_id) ? filterSrc.field_id : [filterSrc.field_id]) : undefined,
        };

        // severity default
        const severity: NonNullable<DynamicRule['severity']> =
            ALLOWED_SEVERITIES.has(src.severity) ? src.severity : 'error';
        if (src.severity !== undefined && !ALLOWED_SEVERITIES.has(src.severity)) {
            d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: 'Unknown "severity"; defaulted to "error".', path: 'severity' });
        }

        // value requirements by op
        const value = src.value;
        if (op === 'max_count' || op === 'min_count') {
            if (!(typeof value === 'number' && Number.isFinite(value))) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'error', message: `"${op}" requires numeric "value".`, path: 'value' });
            }
        } else if (op === 'all_true' || op === 'any_true') {
            if (value !== undefined) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: `"${op}" ignores "value"; it checks all/any true.`, path: 'value' });
            }
        } else {
            if (value !== undefined) {
                d.push({ ruleIndex: i, ruleId: id, severity: 'warning', message: `"${op}" does not use "value".`, path: 'value' });
            }
        }

        // assemble rule if no fatal (error-level) diagnostics for op/value
        const hasFatal = d.some(x => x.severity === 'error');
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
                message: typeof src.message === 'string' ? src.message : undefined,
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
        errors: diags.filter(d => d.severity === 'error'),
        warnings: diags.filter(d => d.severity === 'warning'),
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