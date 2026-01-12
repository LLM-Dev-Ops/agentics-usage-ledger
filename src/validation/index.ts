/**
 * Input validation utilities
 * Strict validation per SPARC requirements
 */

import { invalidRequest, invalidAmount } from '../errors/index.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_REGEX = /^-?\d+(\.\d{1,6})?$/;
const SAFE_STRING_REGEX = /^[\w\-:.@]+$/;

/**
 * Validate UUID format
 */
export function validateUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw invalidRequest(`${fieldName} must be a valid UUID`);
  }
  return value;
}

/**
 * Validate decimal amount (as string for precision)
 * Amount must be positive unless allowNegative is true
 */
export function validateAmount(
  value: unknown,
  fieldName: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {}
): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalidAmount(`${fieldName} must be a number or numeric string`);
  }

  const str = String(value);
  if (!DECIMAL_REGEX.test(str)) {
    throw invalidAmount(`${fieldName} must be a valid decimal number`);
  }

  const num = parseFloat(str);
  if (!Number.isFinite(num)) {
    throw invalidAmount(`${fieldName} must be a finite number`);
  }

  if (!options.allowNegative && num < 0) {
    throw invalidAmount(`${fieldName} must be non-negative`);
  }

  if (!options.allowZero && num === 0) {
    throw invalidAmount(`${fieldName} must be non-zero`);
  }

  // Normalize to 6 decimal places
  return num.toFixed(6);
}

/**
 * Validate positive amount (convenience wrapper)
 */
export function validatePositiveAmount(value: unknown, fieldName: string): string {
  return validateAmount(value, fieldName, { allowNegative: false, allowZero: false });
}

/**
 * Validate required string field
 */
export function validateRequiredString(
  value: unknown,
  fieldName: string,
  options: { maxLength?: number; pattern?: RegExp } = {}
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest(`${fieldName} is required`);
  }

  const trimmed = value.trim();

  if (options.maxLength && trimmed.length > options.maxLength) {
    throw invalidRequest(`${fieldName} exceeds maximum length of ${options.maxLength}`);
  }

  if (options.pattern && !options.pattern.test(trimmed)) {
    throw invalidRequest(`${fieldName} contains invalid characters`);
  }

  return trimmed;
}

/**
 * Validate optional string field
 */
export function validateOptionalString(
  value: unknown,
  fieldName: string,
  options: { maxLength?: number; pattern?: RegExp } = {}
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return validateRequiredString(value, fieldName, options);
}

/**
 * Validate idempotency key
 */
export function validateIdempotencyKey(value: unknown): string {
  return validateRequiredString(value, 'idempotency_key', {
    maxLength: 255,
    pattern: SAFE_STRING_REGEX,
  });
}

/**
 * Validate actor identifier
 */
export function validateActor(value: unknown): string {
  return validateRequiredString(value, 'actor', {
    maxLength: 255,
    pattern: SAFE_STRING_REGEX,
  });
}

/**
 * Validate service identifier
 */
export function validateService(value: unknown): string {
  return validateRequiredString(value, 'service', {
    maxLength: 128,
    pattern: SAFE_STRING_REGEX,
  });
}

/**
 * Validate positive integer
 */
export function validatePositiveInt(
  value: unknown,
  fieldName: string,
  options: { max?: number } = {}
): number {
  const num = typeof value === 'string' ? parseInt(value, 10) : value;

  if (typeof num !== 'number' || !Number.isInteger(num) || num <= 0) {
    throw invalidRequest(`${fieldName} must be a positive integer`);
  }

  if (options.max && num > options.max) {
    throw invalidRequest(`${fieldName} exceeds maximum value of ${options.max}`);
  }

  return num;
}

/**
 * Validate non-negative integer (allows zero)
 */
export function validateNonNegativeInt(
  value: unknown,
  fieldName: string,
  options: { max?: number } = {}
): number {
  const num = typeof value === 'string' ? parseInt(value, 10) : value;

  if (typeof num !== 'number' || !Number.isInteger(num) || num < 0) {
    throw invalidRequest(`${fieldName} must be a non-negative integer`);
  }

  if (options.max && num > options.max) {
    throw invalidRequest(`${fieldName} exceeds maximum value of ${options.max}`);
  }

  return num;
}

/**
 * Validate entry type
 */
export function validateEntryType(value: unknown): 'grant' | 'debit' | 'adjustment' | 'reversal' {
  const valid = ['grant', 'debit', 'adjustment', 'reversal'];
  if (typeof value !== 'string' || !valid.includes(value)) {
    throw invalidRequest(`entry_type must be one of: ${valid.join(', ')}`);
  }
  return value as 'grant' | 'debit' | 'adjustment' | 'reversal';
}

/**
 * Validate metadata object (shallow check)
 */
export function validateMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('metadata must be an object');
  }

  // Ensure JSON-serializable
  try {
    JSON.stringify(value);
  } catch {
    throw invalidRequest('metadata must be JSON-serializable');
  }

  return value as Record<string, unknown>;
}

/**
 * Parse JSON body from request
 */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw invalidRequest('Invalid JSON body');
  }
}
