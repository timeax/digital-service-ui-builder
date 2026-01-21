// src/core/validate/steps/option-maps.ts
import type { ValidationCtx } from "../shared";

type ParsedKey = { fieldId: string; optionId: string };

export function validateOptionMaps(v: ValidationCtx): void {
    const incMap: Record<string, string[]> = v.props.includes_for_buttons ?? {};
    const excMap: Record<string, string[]> = v.props.excludes_for_buttons ?? {};

    const parseKey = (key: string): ParsedKey | null => {
        const parts: string[] = key.split("::");
        const fid: string | undefined = parts[0];
        const oid: string | undefined = parts[1];
        if (!fid || !oid) return null;
        return { fieldId: fid, optionId: oid };
    };

    const hasOption = (fid: string, oid: string): boolean => {
        const f = v.fieldById.get(fid);
        if (!f) return false;
        return !!(f.options ?? []).find((o) => o.id === oid);
    };

    // bad_option_key
    for (const k of Object.keys(incMap)) {
        const p = parseKey(k);
        if (!p || !hasOption(p.fieldId, p.optionId)) {
            v.errors.push({ code: "bad_option_key", details: { key: k } });
        }
    }
    for (const k of Object.keys(excMap)) {
        const p = parseKey(k);
        if (!p || !hasOption(p.fieldId, p.optionId)) {
            v.errors.push({ code: "bad_option_key", details: { key: k } });
        }
    }

    // option_include_exclude_conflict
    for (const k of Object.keys(incMap)) {
        if (k in excMap) {
            const p = parseKey(k);
            v.errors.push({
                code: "option_include_exclude_conflict",
                nodeId: p?.fieldId,
                details: { key: k },
            });
        }
    }
}
