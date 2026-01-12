/**
 * Error definitions per SPARC Specification Appendix B
 * Explicit, non-leaky error responses
 */

export type LedgerErrorCode =
  | 'ORGANIZATION_NOT_FOUND'
  | 'ORGANIZATION_SUSPENDED'
  | 'ORGANIZATION_CLOSED'
  | 'INSUFFICIENT_CREDITS'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_NOT_ACTIVE'
  | 'RESERVATION_EXPIRED'
  | 'AMOUNT_EXCEEDS_RESERVATION'
  | 'ENTRY_NOT_FOUND'
  | 'ALREADY_REVERSED'
  | 'INVALID_AMOUNT'
  | 'DUPLICATE_IDEMPOTENCY_KEY'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

const HTTP_STATUS_MAP: Record<LedgerErrorCode, number> = {
  ORGANIZATION_NOT_FOUND: 404,
  ORGANIZATION_SUSPENDED: 403,
  ORGANIZATION_CLOSED: 403,
  INSUFFICIENT_CREDITS: 402,
  RESERVATION_NOT_FOUND: 404,
  RESERVATION_NOT_ACTIVE: 409,
  RESERVATION_EXPIRED: 410,
  AMOUNT_EXCEEDS_RESERVATION: 400,
  ENTRY_NOT_FOUND: 404,
  ALREADY_REVERSED: 409,
  INVALID_AMOUNT: 400,
  DUPLICATE_IDEMPOTENCY_KEY: 409,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  INVALID_REQUEST: 400,
  INTERNAL_ERROR: 500,
};

/**
 * Base ledger error class
 * Provides structured error responses without leaking internal details
 */
export class LedgerError extends Error {
  public readonly code: LedgerErrorCode;
  public readonly httpStatus: number;
  public readonly details: Record<string, unknown>;

  constructor(
    code: LedgerErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.httpStatus = HTTP_STATUS_MAP[code];
    this.details = details;
    Object.setPrototypeOf(this, LedgerError.prototype);
  }

  /**
   * Convert to JSON-safe response object
   * Explicitly excludes stack traces and internal details
   */
  toResponse(): LedgerErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export interface LedgerErrorResponse {
  error: {
    code: LedgerErrorCode;
    message: string;
    details: Record<string, unknown>;
  };
}

// Convenience factory functions for common errors

export function organizationNotFound(orgId: string): LedgerError {
  return new LedgerError(
    'ORGANIZATION_NOT_FOUND',
    'Organization does not exist',
    { organization_id: orgId }
  );
}

export function organizationSuspended(orgId: string): LedgerError {
  return new LedgerError(
    'ORGANIZATION_SUSPENDED',
    'Organization is suspended',
    { organization_id: orgId }
  );
}

export function organizationClosed(orgId: string): LedgerError {
  return new LedgerError(
    'ORGANIZATION_CLOSED',
    'Organization is closed',
    { organization_id: orgId }
  );
}

export function insufficientCredits(
  available: string,
  required: string
): LedgerError {
  return new LedgerError(
    'INSUFFICIENT_CREDITS',
    'Insufficient credits available',
    {
      available_balance: available,
      required_credits: required,
      shortfall: (parseFloat(required) - parseFloat(available)).toFixed(6),
    }
  );
}

export function reservationNotFound(reservationId: string): LedgerError {
  return new LedgerError(
    'RESERVATION_NOT_FOUND',
    'Reservation does not exist',
    { reservation_id: reservationId }
  );
}

export function reservationNotActive(
  reservationId: string,
  status: string
): LedgerError {
  return new LedgerError(
    'RESERVATION_NOT_ACTIVE',
    'Reservation is not active',
    { reservation_id: reservationId, current_status: status }
  );
}

export function reservationExpired(reservationId: string): LedgerError {
  return new LedgerError(
    'RESERVATION_EXPIRED',
    'Reservation has expired',
    { reservation_id: reservationId }
  );
}

export function amountExceedsReservation(
  requested: string,
  reserved: string
): LedgerError {
  return new LedgerError(
    'AMOUNT_EXCEEDS_RESERVATION',
    'Requested amount exceeds reservation',
    { requested_amount: requested, reserved_amount: reserved }
  );
}

export function entryNotFound(entryId: string): LedgerError {
  return new LedgerError(
    'ENTRY_NOT_FOUND',
    'Ledger entry does not exist',
    { entry_id: entryId }
  );
}

export function alreadyReversed(entryId: string): LedgerError {
  return new LedgerError(
    'ALREADY_REVERSED',
    'Entry has already been reversed',
    { entry_id: entryId }
  );
}

export function invalidAmount(reason: string): LedgerError {
  return new LedgerError(
    'INVALID_AMOUNT',
    `Invalid amount: ${reason}`,
    {}
  );
}

export function duplicateIdempotencyKey(key: string): LedgerError {
  return new LedgerError(
    'DUPLICATE_IDEMPOTENCY_KEY',
    'Idempotency key already used for a different operation',
    { idempotency_key: key }
  );
}

export function invalidRequest(reason: string): LedgerError {
  return new LedgerError(
    'INVALID_REQUEST',
    reason,
    {}
  );
}

export function internalError(): LedgerError {
  // Intentionally vague to avoid leaking internal details
  return new LedgerError(
    'INTERNAL_ERROR',
    'An internal error occurred',
    {}
  );
}
