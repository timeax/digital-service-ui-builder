// src/core/validate/index.ts
import type { ServiceProps, Tag, Field } from "@/schema";
import type { DgpServiceMap } from "@/schema/provider";
import type { ValidationError, ValidatorOptions } from "@/schema/validation";

import {
    createFieldsVisibleUnder,
    validateVisibility,
} from "./steps/visibility";
import { validateStructure } from "./steps/structure";
import { validateIdentity } from "./steps/identity";
import { validateOptionMaps } from "./steps/option-maps";
import { validateServiceVsUserInput } from "./steps/service-vs-input";
import { validateUtilityMarkers } from "./steps/utility";
import { validateRates } from "./steps/rates";
import { validateConstraints } from "./steps/constraints";
import { validateCustomFields } from "./steps/custom";
import { validateGlobalUtilityGuard } from "./steps/global-utility-guard";
import { validateUnboundFields } from "./steps/unbound";
import { validateFallbacks } from "./steps/fallbacks";

import { applyPolicies } from "./policies/apply-policies";
import type { ValidationCtx } from "./shared";

export function validate(
    props: ServiceProps,
    ctx: ValidatorOptions = {},
): ValidationError[] {
    const errors: ValidationError[] = [];
    const serviceMap: DgpServiceMap = ctx.serviceMap ?? {};
    const selectedKeys: Set<string> = new Set<string>(
        ctx.selectedOptionKeys ?? [],
    );

    const tags: Tag[] = Array.isArray(props.filters) ? props.filters : [];
    const fields: Field[] = Array.isArray(props.fields) ? props.fields : [];

    const tagById: Map<string, Tag> = new Map<string, Tag>();
    const fieldById: Map<string, Field> = new Map<string, Field>();

    for (const t of tags) tagById.set(t.id, t);
    for (const f of fields) fieldById.set(f.id, f);

    const v: ValidationCtx = {
        props,
        options: ctx,
        errors,
        serviceMap,
        selectedKeys,
        tags,
        fields,
        tagById,
        fieldById,
        fieldsVisibleUnder: (_tagId: string): Field[] => [],
    };

    // 1) structure
    validateStructure(v);

    // 2) identity + labels
    validateIdentity(v);

    // 3) option maps
    validateOptionMaps(v);

    // 4) visibility helpers + visibility rules
    v.fieldsVisibleUnder = createFieldsVisibleUnder(v);
    validateVisibility(v);

    // --------- Dynamic policies (super-admin) --------------------------
    applyPolicies(
        v.errors,
        v.props,
        v.serviceMap,
        v.options.policies,
        v.fieldsVisibleUnder,
        v.tags,
    );

    // 5) service vs user-input rules
    validateServiceVsUserInput(v);

    // 6) utility marker rules
    validateUtilityMarkers(v);

    // 7) rates & pricing roles
    validateRates(v);

    // 8) constraints vs capabilities + inheritance
    validateConstraints(v);

    // 9) custom field rules
    validateCustomFields(v);

    // 10) optional global utility guard
    validateGlobalUtilityGuard(v);

    // 11) unbound fields
    validateUnboundFields(v);

    // 12) fallbacks strict-mode conversion
    validateFallbacks(v);

    return v.errors;
}
