import { Field } from "@/schema";

/**
 * Heuristic: multi-select if type hints ('multiselect'|'checkbox') or meta.multi === true.
 * Hosts can rely on meta.multi if using custom type strings.
 */
export function isMultiField(f: Field): boolean {
    const t = (f.type || "").toLowerCase();
    const metaMulti = !!f.meta?.multi;
    return t === "multiselect" || t === "checkbox" || metaMulti;
}
