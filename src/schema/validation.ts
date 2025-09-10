export enum ValidationCode {
  MissingRequiredField = 'MissingRequiredField',
  InvalidType = 'InvalidType',
  OutOfRange = 'OutOfRange',
  PatternMismatch = 'PatternMismatch',
  UnknownField = 'UnknownField',
}

export interface ValidationError {
  code: ValidationCode;
  message: string;
  path: string; // JSON pointer-like path e.g. sections[0].fields[2]
  hint?: string;
  severity?: 'error' | 'warning' | 'info';
}

export interface ValidatorOptions {
  stopAtFirstError?: boolean;
  strict?: boolean;
}
