import type { ServiceProps, Field } from '../schema/index';

export function normaliseField(field: Field): Field {
  // Simple normalisation: trim labels and names, ensure options unique for selects
  const trimmed = { ...field, label: field.label.trim(), name: field.name.trim() } as Field;
  if ((trimmed as any).options) {
    const seen = new Set<string>();
    (trimmed as any).options = (trimmed as any).options.filter((opt: any) => {
      const key = String(opt.value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return trimmed;
}

export function normaliseService(service: ServiceProps): ServiceProps {
  return {
    ...service,
    name: service.name.trim(),
    sections: service.sections.map((s) => ({
      ...s,
      title: s.title.trim(),
      fields: s.fields.map((f) => normaliseField(f)),
    })),
  };
}
