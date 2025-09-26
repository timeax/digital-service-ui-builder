// src/schema/policies.ts
import type { DynamicRule } from './validation';

/** Exported alias so the schema generator can target an array */
export type AdminPolicies = DynamicRule[];

// Re-export (optional convenience)
export type { DynamicRule };