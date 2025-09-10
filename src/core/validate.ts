import type { ServiceProps, Field, Section } from '../schema/index';
import { ValidationCode, type ValidationError, type ValidatorOptions } from '../schema/validation';

function validateField(field: Field, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!field.label?.trim()) {
    errors.push({ code: ValidationCode.MissingRequiredField, message: 'Field label is required', path: `${path}.label` });
  }
  if (!field.name?.trim()) {
    errors.push({ code: ValidationCode.MissingRequiredField, message: 'Field name is required', path: `${path}.name` });
  }
  if ((field as any).options && !Array.isArray((field as any).options)) {
    errors.push({ code: ValidationCode.InvalidType, message: 'options must be an array', path: `${path}.options` });
  }
  if (field.type === 'number' || field.type === 'currency') {
    const min = (field as any).min as number | undefined;
    const max = (field as any).max as number | undefined;
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      errors.push({ code: ValidationCode.OutOfRange, message: 'min cannot be greater than max', path: `${path}.min` });
    }
  }
  return errors;
}

function validateSection(section: Section, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!section.title?.trim()) {
    errors.push({ code: ValidationCode.MissingRequiredField, message: 'Section title is required', path: `${path}.title` });
  }
  section.fields.forEach((f, i) => {
    errors.push(...validateField(f, `${path}.fields[${i}]`));
  });
  return errors;
}

export function validateService(service: ServiceProps, opts: ValidatorOptions = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!service.name?.trim()) {
    errors.push({ code: ValidationCode.MissingRequiredField, message: 'Service name is required', path: 'name' });
    if (opts.stopAtFirstError) return errors;
  }
  if (!Array.isArray(service.sections) || service.sections.length === 0) {
    errors.push({ code: ValidationCode.MissingRequiredField, message: 'At least one section is required', path: 'sections' });
    if (opts.stopAtFirstError) return errors;
  } else {
    service.sections.forEach((s, i) => {
      errors.push(...validateSection(s, `sections[${i}]`));
    });
    if (opts.stopAtFirstError && errors.length) return [errors[0]];
  }
  return errors;
}
