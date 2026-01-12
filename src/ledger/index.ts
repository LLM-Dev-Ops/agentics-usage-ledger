/**
 * Core ledger service implementation
 * Per SPARC Specification Sections 2.1-2.6
 *
 * This is the authoritative accounting and enforcement layer.
 * All operations are append-only, idempotent, and strongly consistent.
 */

import type {
  LedgerEntry,
  Reservation,
  BalanceInfo,
  PreFlightRequest,
  PreFlightResponse,
  GrantRequest,
  DebitRequest,
  ReserveRequest,
  ConsumeRequest,
  UsageHistoryParams,
  PaginatedResponse,
} from '../types/index.js';

import {
  LedgerError,
  organizationNotFound,
  organizationSuspended,
  organizationClosed,
  insufficientCredits,
  reservationNotFound,
  reservationNotActive,
  reservationExpired,
  amountExceedsReservation,
  entryNotFound,
  alreadyReversed,
  invalidAmount,
} from '../errors/index.js';

import {
  withTransaction,
  getOrganization,
  getEntryByIdempotencyKey,
  getEntryById,
  computeCurrentBalance,
  getCurrentBalanceOptimized,
  insertLedgerEntry,
  listEntries,
  getReservationById,
  getReservationForUpdate,
  getReservationByIdempotencyKey,
  getActiveReservationsSum,
  insertReservation,
  updateReservationStatus,
  hasBeenReversed,
  getPool,
} from '../db/index.js';

// ============================================================================
// Balance Queries (Read-only)
// ============================================================================

/**
 * Get balance information for an organization
 * Per SPARC Section 2.5
 */
export async function getBalance(organizationId: string): Promise<BalanceInfo> {
  // Validate organization exists
  const org = await getOrganization(organizationId);
  if (!org) {
    throw organizationNotFound(organizationId);
  }

  // Compute balances from ledger entries (source of truth)
  const currentBalance = await getCurrentBalanceOptimized(organizationId);
  const reservedAmount = await getActiveReservationsSum(organizationId);
  const available = parseFloat(currentBalance) - parseFloat(reservedAmount);

  return {
    organization_id: organizationId,
    current_balance: currentBalance,
    reserved_amount: reservedAmount,
    available_balance: available.toFixed(6),
    as_of: new Date(),
  };
}

// ============================================================================
// Pre-flight Enforcement (Read-only check)
// ============================================================================

/**
 * Pre-flight check to determine if execution is allowed
 * Per SPARC Section 2.1
 *
 * This is the enforcement gate - execution cannot proceed without
 * an affirmative response from this check.
 */
export async function canExecute(req: PreFlightRequest): Promise<PreFlightResponse> {
  // Step 1: Validate organization
  const org = await getOrganization(req.organization_id);
  if (!org) {
    throw organizationNotFound(req.organization_id);
  }
  if (org.status === 'suspended') {
    throw organizationSuspended(req.organization_id);
  }
  if (org.status === 'closed') {
    throw organizationClosed(req.organization_id);
  }

  // Step 2: Check idempotency (if key provided)
  if (req.idempotency_key) {
    const existing = await getEntryByIdempotencyKey(
      req.organization_id,
      req.idempotency_key
    );
    if (existing) {
      // Request already processed - return based on existing entry
      const balance = await getBalance(req.organization_id);
      return {
        allowed: true, // Entry exists means it was allowed before
        organization_id: req.organization_id,
        available_balance: balance.available_balance,
        required_credits: req.required_credits,
      };
    }
  }

  // Step 3: Calculate available balance
  const currentBalance = await getCurrentBalanceOptimized(req.organization_id);
  const reservedAmount = await getActiveReservationsSum(req.organization_id);
  const availableBalance = parseFloat(currentBalance) - parseFloat(reservedAmount);
  const requiredCredits = parseFloat(req.required_credits);

  // Step 4: Evaluate
  if (availableBalance >= requiredCredits) {
    return {
      allowed: true,
      organization_id: req.organization_id,
      available_balance: availableBalance.toFixed(6),
      required_credits: req.required_credits,
    };
  } else {
    return {
      allowed: false,
      organization_id: req.organization_id,
      available_balance: availableBalance.toFixed(6),
      required_credits: req.required_credits,
      shortfall: (requiredCredits - availableBalance).toFixed(6),
    };
  }
}

// ============================================================================
// Credit Grant (Append-only write)
// ============================================================================

/**
 * Grant credits to an organization
 * Per SPARC Section 2.4
 */
export async function grantCredits(req: GrantRequest): Promise<LedgerEntry> {
  // Validate amount
  const amount = parseFloat(req.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw invalidAmount('grant amount must be positive');
  }

  return withTransaction(async (client) => {
    // Idempotency check
    const existing = await getEntryByIdempotencyKey(
      req.organization_id,
      req.idempotency_key,
      client
    );
    if (existing) {
      return existing;
    }

    // Validate organization
    const org = await getOrganization(req.organization_id, client);
    if (!org) {
      throw organizationNotFound(req.organization_id);
    }
    if (org.status === 'closed') {
      throw organizationClosed(req.organization_id);
    }

    // Get current balance and compute new balance
    const currentBalance = parseFloat(
      await computeCurrentBalance(req.organization_id, client)
    );
    const newBalance = currentBalance + amount;

    // Create grant entry
    return insertLedgerEntry(
      {
        organization_id: req.organization_id,
        entry_type: 'grant',
        amount: amount.toFixed(6),
        balance_after: newBalance.toFixed(6),
        idempotency_key: req.idempotency_key,
        correlation_id: req.correlation_id,
        created_by: req.actor,
        metadata: { reason: req.reason },
      },
      client
    );
  });
}

// ============================================================================
// Direct Debit (Append-only write without reservation)
// ============================================================================

/**
 * Record a direct debit (usage) without prior reservation
 * Per SPARC Section 2.3 (simplified for direct debits)
 */
export async function recordDebit(req: DebitRequest): Promise<LedgerEntry> {
  // Validate amount
  const amount = parseFloat(req.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw invalidAmount('debit amount must be positive');
  }

  return withTransaction(async (client) => {
    // Idempotency check
    const existing = await getEntryByIdempotencyKey(
      req.organization_id,
      req.idempotency_key,
      client
    );
    if (existing) {
      return existing;
    }

    // Validate organization
    const org = await getOrganization(req.organization_id, client);
    if (!org) {
      throw organizationNotFound(req.organization_id);
    }
    if (org.status !== 'active') {
      if (org.status === 'suspended') {
        throw organizationSuspended(req.organization_id);
      }
      throw organizationClosed(req.organization_id);
    }

    // Get current balance and check sufficiency
    const currentBalance = parseFloat(
      await computeCurrentBalance(req.organization_id, client)
    );
    const reservedAmount = parseFloat(
      await getActiveReservationsSum(req.organization_id, client)
    );
    const availableBalance = currentBalance - reservedAmount;

    if (availableBalance < amount) {
      throw insufficientCredits(availableBalance.toFixed(6), amount.toFixed(6));
    }

    // Compute new balance
    const newBalance = currentBalance - amount;

    // Create debit entry (amount stored as negative per SPARC)
    return insertLedgerEntry(
      {
        organization_id: req.organization_id,
        user_id: req.user_id,
        entry_type: 'debit',
        amount: (-amount).toFixed(6), // Negative for debits
        balance_after: newBalance.toFixed(6),
        idempotency_key: req.idempotency_key,
        correlation_id: req.correlation_id,
        service: req.service,
        run_id: req.run_id,
        created_by: req.actor,
        metadata: req.metadata || {},
      },
      client
    );
  });
}

// ============================================================================
// Reservation Handling
// ============================================================================

/**
 * Create a credit reservation
 * Per SPARC Section 2.2
 */
export async function reserveCredits(req: ReserveRequest): Promise<Reservation> {
  // Validate amount
  const amount = parseFloat(req.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw invalidAmount('reservation amount must be positive');
  }

  // Validate TTL
  if (req.ttl_seconds <= 0 || req.ttl_seconds > 86400) {
    throw invalidAmount('ttl_seconds must be between 1 and 86400');
  }

  return withTransaction(async (client) => {
    // Idempotency check
    const existing = await getReservationByIdempotencyKey(
      req.organization_id,
      req.idempotency_key,
      client
    );
    if (existing) {
      return existing;
    }

    // Validate organization
    const org = await getOrganization(req.organization_id, client);
    if (!org) {
      throw organizationNotFound(req.organization_id);
    }
    if (org.status !== 'active') {
      if (org.status === 'suspended') {
        throw organizationSuspended(req.organization_id);
      }
      throw organizationClosed(req.organization_id);
    }

    // Calculate available balance
    const currentBalance = parseFloat(
      await computeCurrentBalance(req.organization_id, client)
    );
    const reservedAmount = parseFloat(
      await getActiveReservationsSum(req.organization_id, client)
    );
    const availableBalance = currentBalance - reservedAmount;

    // Check sufficiency
    if (availableBalance < amount) {
      throw insufficientCredits(availableBalance.toFixed(6), amount.toFixed(6));
    }

    // Create reservation
    const expiresAt = new Date(Date.now() + req.ttl_seconds * 1000);

    return insertReservation(
      {
        organization_id: req.organization_id,
        user_id: req.user_id,
        amount: amount.toFixed(6),
        expires_at: expiresAt,
        correlation_id: req.correlation_id,
        idempotency_key: req.idempotency_key,
        created_by: req.actor,
      },
      client
    );
  });
}

/**
 * Consume a reservation (debit credits)
 * Per SPARC Section 2.3
 */
export async function consumeReservation(req: ConsumeRequest): Promise<LedgerEntry> {
  // Validate amount
  const actualAmount = parseFloat(req.actual_amount);
  if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
    throw invalidAmount('actual_amount must be positive');
  }

  return withTransaction(async (client) => {
    // Lock and validate reservation
    const reservation = await getReservationForUpdate(req.reservation_id, client);
    if (!reservation) {
      throw reservationNotFound(req.reservation_id);
    }

    // Idempotency check for the debit
    const existing = await getEntryByIdempotencyKey(
      reservation.organization_id,
      req.idempotency_key,
      client
    );
    if (existing) {
      return existing;
    }

    if (reservation.status !== 'active') {
      throw reservationNotActive(req.reservation_id, reservation.status);
    }

    if (new Date(reservation.expires_at) < new Date()) {
      // Mark as expired
      await updateReservationStatus(req.reservation_id, 'expired', client);
      throw reservationExpired(req.reservation_id);
    }

    // Validate actual amount doesn't exceed reservation
    const reservedAmount = parseFloat(reservation.amount);
    if (actualAmount > reservedAmount) {
      throw amountExceedsReservation(
        actualAmount.toFixed(6),
        reservedAmount.toFixed(6)
      );
    }

    // Get current balance for balance_after calculation
    const currentBalance = parseFloat(
      await computeCurrentBalance(reservation.organization_id, client)
    );
    const newBalance = currentBalance - actualAmount;

    // Create debit entry
    const entry = await insertLedgerEntry(
      {
        organization_id: reservation.organization_id,
        user_id: reservation.user_id,
        entry_type: 'debit',
        amount: (-actualAmount).toFixed(6), // Negative for debits
        balance_after: newBalance.toFixed(6),
        idempotency_key: req.idempotency_key,
        correlation_id: reservation.correlation_id,
        service: req.service,
        run_id: req.run_id,
        created_by: req.actor,
        metadata: {
          reservation_id: req.reservation_id,
          reserved_amount: reservation.amount,
          actual_amount: actualAmount.toFixed(6),
          ...(req.metadata || {}),
        },
      },
      client
    );

    // Mark reservation as consumed
    await updateReservationStatus(req.reservation_id, 'consumed', client);

    return entry;
  });
}

/**
 * Cancel a reservation
 */
export async function cancelReservation(
  reservationId: string,
  actor: string
): Promise<Reservation> {
  return withTransaction(async (client) => {
    const reservation = await getReservationForUpdate(reservationId, client);
    if (!reservation) {
      throw reservationNotFound(reservationId);
    }

    if (reservation.status !== 'active') {
      throw reservationNotActive(reservationId, reservation.status);
    }

    await updateReservationStatus(reservationId, 'cancelled', client);

    return {
      ...reservation,
      status: 'cancelled',
      cancelled_at: new Date(),
    };
  });
}

/**
 * Get reservation by ID
 */
export async function getReservation(reservationId: string): Promise<Reservation> {
  const reservation = await getReservationById(reservationId);
  if (!reservation) {
    throw reservationNotFound(reservationId);
  }
  return reservation;
}

// ============================================================================
// Usage History Queries (Read-only)
// ============================================================================

/**
 * List ledger entries with pagination
 */
export async function getUsageHistory(
  params: UsageHistoryParams
): Promise<PaginatedResponse<LedgerEntry>> {
  // Validate organization exists
  const org = await getOrganization(params.organization_id);
  if (!org) {
    throw organizationNotFound(params.organization_id);
  }

  const { entries, total } = await listEntries({
    organization_id: params.organization_id,
    user_id: params.user_id,
    service: params.service,
    entry_type: params.entry_type,
    limit: params.limit,
    offset: params.offset,
    from_date: params.from_date,
    to_date: params.to_date,
  });

  const limit = params.limit || 50;
  const offset = params.offset || 0;

  return {
    data: entries,
    total,
    limit,
    offset,
    has_more: offset + entries.length < total,
  };
}

/**
 * Get a specific ledger entry
 */
export async function getEntry(
  organizationId: string,
  entryId: string
): Promise<LedgerEntry> {
  const entry = await getEntryById(entryId);
  if (!entry) {
    throw entryNotFound(entryId);
  }

  // Verify organization ownership
  if (entry.organization_id !== organizationId) {
    throw entryNotFound(entryId); // Don't leak that entry exists in another org
  }

  return entry;
}

// ============================================================================
// Reversal (Append-only correction)
// ============================================================================

/**
 * Reverse a ledger entry
 * Per SPARC Section 2.6
 */
export async function reverseEntry(
  entryId: string,
  reason: string,
  idempotencyKey: string,
  actor: string
): Promise<LedgerEntry> {
  return withTransaction(async (client) => {
    // Get original entry
    const original = await getEntryById(entryId, client);
    if (!original) {
      throw entryNotFound(entryId);
    }

    // Check idempotency
    const existing = await getEntryByIdempotencyKey(
      original.organization_id,
      idempotencyKey,
      client
    );
    if (existing) {
      return existing;
    }

    // Check if entry type can be reversed (reversals cannot be reversed)
    if (original.entry_type === 'reversal') {
      throw alreadyReversed(entryId);
    }

    // Check if already reversed
    if (await hasBeenReversed(entryId, client)) {
      throw alreadyReversed(entryId);
    }

    // Calculate reversal amount (opposite sign)
    const originalAmount = parseFloat(original.amount);
    const reversalAmount = -originalAmount;

    // Get current balance
    const currentBalance = parseFloat(
      await computeCurrentBalance(original.organization_id, client)
    );
    const newBalance = currentBalance + reversalAmount;

    // Create reversal entry
    return insertLedgerEntry(
      {
        organization_id: original.organization_id,
        user_id: original.user_id,
        entry_type: 'reversal',
        amount: reversalAmount.toFixed(6),
        balance_after: newBalance.toFixed(6),
        idempotency_key: idempotencyKey,
        correlation_id: entryId, // Links to original entry
        service: original.service,
        run_id: original.run_id,
        created_by: actor,
        metadata: {
          original_entry_id: entryId,
          original_amount: original.amount,
          reason,
        },
      },
      client
    );
  });
}
