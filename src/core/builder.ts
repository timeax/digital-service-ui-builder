import type { DeepPartial, ServiceProps, Section, Field, UUID } from '../schema/index';
import { normaliseService } from './normalise';
import { validateService } from './validate';
import type { ValidationError } from '../schema/validation';

export class Builder {
  private props: ServiceProps;

  constructor(initial: ServiceProps) {
    this.props = initial;
  }

  static create(seed: DeepPartial<ServiceProps> & Pick<ServiceProps, 'id' | 'name' | 'version'>): Builder {
    const base: ServiceProps = {
      id: seed.id,
      name: seed.name,
      version: seed.version,
      sections: seed.sections ?? [],
      tags: seed.tags ?? [],
      pricing: seed.pricing ?? [],
      createdAt: seed.createdAt ?? new Date().toISOString(),
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
    };
    return new Builder(base);
  }

  addSection(section: Section): this {
    this.props.sections.push(section);
    return this;
  }

  addField(sectionId: UUID, field: Field): this {
    const section = this.props.sections.find((s) => s.id === sectionId);
    if (!section) throw new Error(`Section ${sectionId} not found`);
    section.fields.push(field);
    return this;
  }

  set<K extends keyof ServiceProps>(key: K, value: ServiceProps[K]): this {
    (this.props as any)[key] = value;
    return this;
  }

  validate(): ValidationError[] {
    return validateService(this.props);
  }

  build(): ServiceProps {
    const normalized = normaliseService({ ...this.props, updatedAt: new Date().toISOString() });
    const errors = validateService(normalized);
    if (errors.length) {
      const first = errors[0];
      const err = new Error(`Validation failed: ${first.code} at ${first.path} - ${first.message}`);
      (err as any).errors = errors;
      throw err;
    }
    return normalized;
  }
}
