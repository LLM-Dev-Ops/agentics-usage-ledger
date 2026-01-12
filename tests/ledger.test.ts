/**
 * Ledger Tests
 *
 * Demonstrates per SPARC requirements:
 * 1. Successful pre-flight check
 * 2. Rejected request due to insufficient credits
 * 3. Recorded debit
 * 4. Correct balance calculation
 *
 * Uses a mock database for unit testing without external dependencies.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Mock Database Implementation
// ============================================================================

interface MockOrganization {
  organization_id: string;
  name: string;
  status: 'active' | 'suspended' | 'closed';
  created_at: Date;
}

interface MockLedgerEntry {
  entry_id: string;
  organization_id: string;
  user_id: string | null;
  entry_type: 'grant' | 'debit' | 'adjustment' | 'reversal';
  amount: string;
  balance_after: string;
  idempotency_key: string;
  correlation_id: string | null;
  service: string | null;
  run_id: string | null;
  created_at: Date;
  created_by: string;
  metadata: Record<string, unknown>;
  checksum: string;
}

interface MockReservation {
  reservation_id: string;
  organization_id: string;
  user_id: string | null;
  amount: string;
  expires_at: Date;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
  created_at: Date;
  consumed_at: Date | null;
  cancelled_at: Date | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  created_by: string;
}

class MockDatabase {
  organizations: Map<string, MockOrganization> = new Map();
  entries: MockLedgerEntry[] = [];
  reservations: Map<string, MockReservation> = new Map();

  reset(): void {
    this.organizations.clear();
    this.entries = [];
    this.reservations.clear();
  }

  addOrganization(org: MockOrganization): void {
    this.organizations.set(org.organization_id, org);
  }

  getOrganization(id: string): MockOrganization | null {
    return this.organizations.get(id) || null;
  }

  computeBalance(orgId: string): string {
    const total = this.entries
      .filter((e) => e.organization_id === orgId)
      .reduce((sum, e) => sum + parseFloat(e.amount), 0);
    return total.toFixed(6);
  }

  getActiveReservationsSum(orgId: string): string {
    const now = new Date();
    let total = 0;
    for (const r of this.reservations.values()) {
      if (
        r.organization_id === orgId &&
        r.status === 'active' &&
        new Date(r.expires_at) > now
      ) {
        total += parseFloat(r.amount);
      }
    }
    return total.toFixed(6);
  }

  findEntryByIdempotencyKey(
    orgId: string,
    key: string
  ): MockLedgerEntry | null {
    return (
      this.entries.find(
        (e) => e.organization_id === orgId && e.idempotency_key === key
      ) || null
    );
  }

  insertEntry(entry: Omit<MockLedgerEntry, 'entry_id' | 'created_at'>): MockLedgerEntry {
    const newEntry: MockLedgerEntry = {
      ...entry,
      entry_id: randomUUID(),
      created_at: new Date(),
    };
    this.entries.push(newEntry);
    return newEntry;
  }

  insertReservation(
    res: Omit<MockReservation, 'reservation_id' | 'created_at' | 'consumed_at' | 'cancelled_at'>
  ): MockReservation {
    const newRes: MockReservation = {
      ...res,
      reservation_id: randomUUID(),
      created_at: new Date(),
      consumed_at: null,
      cancelled_at: null,
    };
    this.reservations.set(newRes.reservation_id, newRes);
    return newRes;
  }
}

// ============================================================================
// Ledger Logic Under Test (simplified version matching main implementation)
// ============================================================================

const mockDb = new MockDatabase();

function computeChecksum(data: string): string {
  // Simplified checksum for testing
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0');
}

interface PreFlightResult {
  allowed: boolean;
  organization_id: string;
  available_balance: string;
  required_credits: string;
  shortfall?: string;
}

interface LedgerErrorResult {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: LedgerErrorResult };

function canExecute(
  orgId: string,
  requiredCredits: string
): Result<PreFlightResult> {
  // Step 1: Validate organization
  const org = mockDb.getOrganization(orgId);
  if (!org) {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' },
    };
  }
  if (org.status === 'suspended') {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_SUSPENDED', message: 'Organization suspended' },
    };
  }
  if (org.status === 'closed') {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_CLOSED', message: 'Organization closed' },
    };
  }

  // Step 2: Calculate available balance
  const currentBalance = parseFloat(mockDb.computeBalance(orgId));
  const reservedAmount = parseFloat(mockDb.getActiveReservationsSum(orgId));
  const availableBalance = currentBalance - reservedAmount;
  const required = parseFloat(requiredCredits);

  // Step 3: Evaluate
  if (availableBalance >= required) {
    return {
      ok: true,
      data: {
        allowed: true,
        organization_id: orgId,
        available_balance: availableBalance.toFixed(6),
        required_credits: requiredCredits,
      },
    };
  } else {
    return {
      ok: true,
      data: {
        allowed: false,
        organization_id: orgId,
        available_balance: availableBalance.toFixed(6),
        required_credits: requiredCredits,
        shortfall: (required - availableBalance).toFixed(6),
      },
    };
  }
}

function grantCredits(
  orgId: string,
  amount: string,
  idempotencyKey: string,
  actor: string,
  reason: string
): Result<MockLedgerEntry> {
  // Validate amount
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return {
      ok: false,
      error: { code: 'INVALID_AMOUNT', message: 'Amount must be positive' },
    };
  }

  // Idempotency check
  const existing = mockDb.findEntryByIdempotencyKey(orgId, idempotencyKey);
  if (existing) {
    return { ok: true, data: existing };
  }

  // Validate organization
  const org = mockDb.getOrganization(orgId);
  if (!org) {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' },
    };
  }
  if (org.status === 'closed') {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_CLOSED', message: 'Organization closed' },
    };
  }

  // Compute new balance
  const currentBalance = parseFloat(mockDb.computeBalance(orgId));
  const newBalance = currentBalance + amountNum;

  // Create entry
  const entry = mockDb.insertEntry({
    organization_id: orgId,
    user_id: null,
    entry_type: 'grant',
    amount: amountNum.toFixed(6),
    balance_after: newBalance.toFixed(6),
    idempotency_key: idempotencyKey,
    correlation_id: null,
    service: null,
    run_id: null,
    created_by: actor,
    metadata: { reason },
    checksum: computeChecksum(`${orgId}|grant|${amount}|${idempotencyKey}`),
  });

  return { ok: true, data: entry };
}

function recordDebit(
  orgId: string,
  amount: string,
  service: string,
  runId: string,
  idempotencyKey: string,
  actor: string
): Result<MockLedgerEntry> {
  // Validate amount
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return {
      ok: false,
      error: { code: 'INVALID_AMOUNT', message: 'Amount must be positive' },
    };
  }

  // Idempotency check
  const existing = mockDb.findEntryByIdempotencyKey(orgId, idempotencyKey);
  if (existing) {
    return { ok: true, data: existing };
  }

  // Validate organization
  const org = mockDb.getOrganization(orgId);
  if (!org) {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' },
    };
  }
  if (org.status !== 'active') {
    return {
      ok: false,
      error: {
        code: org.status === 'suspended' ? 'ORGANIZATION_SUSPENDED' : 'ORGANIZATION_CLOSED',
        message: `Organization ${org.status}`,
      },
    };
  }

  // Check balance
  const currentBalance = parseFloat(mockDb.computeBalance(orgId));
  const reservedAmount = parseFloat(mockDb.getActiveReservationsSum(orgId));
  const availableBalance = currentBalance - reservedAmount;

  if (availableBalance < amountNum) {
    return {
      ok: false,
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        details: {
          available_balance: availableBalance.toFixed(6),
          required_credits: amount,
          shortfall: (amountNum - availableBalance).toFixed(6),
        },
      },
    };
  }

  // Compute new balance
  const newBalance = currentBalance - amountNum;

  // Create debit entry (amount is negative)
  const entry = mockDb.insertEntry({
    organization_id: orgId,
    user_id: null,
    entry_type: 'debit',
    amount: (-amountNum).toFixed(6), // Negative for debits
    balance_after: newBalance.toFixed(6),
    idempotency_key: idempotencyKey,
    correlation_id: null,
    service,
    run_id: runId,
    created_by: actor,
    metadata: {},
    checksum: computeChecksum(`${orgId}|debit|${-amountNum}|${idempotencyKey}`),
  });

  return { ok: true, data: entry };
}

function getBalance(orgId: string): Result<{
  current_balance: string;
  reserved_amount: string;
  available_balance: string;
}> {
  const org = mockDb.getOrganization(orgId);
  if (!org) {
    return {
      ok: false,
      error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' },
    };
  }

  const currentBalance = parseFloat(mockDb.computeBalance(orgId));
  const reservedAmount = parseFloat(mockDb.getActiveReservationsSum(orgId));
  const availableBalance = currentBalance - reservedAmount;

  return {
    ok: true,
    data: {
      current_balance: currentBalance.toFixed(6),
      reserved_amount: reservedAmount.toFixed(6),
      available_balance: availableBalance.toFixed(6),
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('agentics-usage-ledger', () => {
  const testOrgId = '550e8400-e29b-41d4-a716-446655440000';
  const actor = 'test:unit-tests';

  beforeEach(() => {
    mockDb.reset();
    // Add test organization
    mockDb.addOrganization({
      organization_id: testOrgId,
      name: 'Test Organization',
      status: 'active',
      created_at: new Date(),
    });
  });

  describe('Pre-flight Checks', () => {
    it('should allow execution when balance is sufficient', () => {
      // Grant initial credits
      const grantResult = grantCredits(
        testOrgId,
        '100.00',
        'grant-1',
        actor,
        'Initial credits'
      );
      assert.ok(grantResult.ok, 'Grant should succeed');

      // Pre-flight check should allow
      const checkResult = canExecute(testOrgId, '50.00');
      assert.ok(checkResult.ok, 'Pre-flight should succeed');
      assert.equal(checkResult.data.allowed, true, 'Execution should be allowed');
      assert.equal(checkResult.data.available_balance, '100.000000');
      assert.equal(checkResult.data.required_credits, '50.00');
      assert.equal(checkResult.data.shortfall, undefined);

      console.log('✓ Test 1: Successful pre-flight check - PASSED');
    });

    it('should reject execution when balance is insufficient', () => {
      // Grant small amount of credits
      const grantResult = grantCredits(
        testOrgId,
        '10.00',
        'grant-2',
        actor,
        'Small credit'
      );
      assert.ok(grantResult.ok, 'Grant should succeed');

      // Pre-flight check should reject
      const checkResult = canExecute(testOrgId, '50.00');
      assert.ok(checkResult.ok, 'Pre-flight should return result');
      assert.equal(checkResult.data.allowed, false, 'Execution should be rejected');
      assert.equal(checkResult.data.available_balance, '10.000000');
      assert.equal(checkResult.data.required_credits, '50.00');
      assert.equal(checkResult.data.shortfall, '40.000000');

      console.log('✓ Test 2: Rejected request due to insufficient credits - PASSED');
    });

    it('should reject for non-existent organization', () => {
      const checkResult = canExecute('non-existent-org', '10.00');
      assert.equal(checkResult.ok, false);
      assert.equal(checkResult.error.code, 'ORGANIZATION_NOT_FOUND');
    });

    it('should reject for suspended organization', () => {
      mockDb.addOrganization({
        organization_id: 'suspended-org',
        name: 'Suspended Org',
        status: 'suspended',
        created_at: new Date(),
      });

      const checkResult = canExecute('suspended-org', '10.00');
      assert.equal(checkResult.ok, false);
      assert.equal(checkResult.error.code, 'ORGANIZATION_SUSPENDED');
    });
  });

  describe('Debit Recording', () => {
    it('should record debit when balance is sufficient', () => {
      // Grant initial credits
      grantCredits(testOrgId, '100.00', 'grant-3', actor, 'Initial');

      // Record debit
      const debitResult = recordDebit(
        testOrgId,
        '25.00',
        'claude-api',
        'run-12345',
        'debit-1',
        actor
      );

      assert.ok(debitResult.ok, 'Debit should succeed');
      assert.equal(debitResult.data.entry_type, 'debit');
      assert.equal(debitResult.data.amount, '-25.000000'); // Negative for debits
      assert.equal(debitResult.data.balance_after, '75.000000');
      assert.equal(debitResult.data.service, 'claude-api');
      assert.equal(debitResult.data.run_id, 'run-12345');

      console.log('✓ Test 3: Recorded debit - PASSED');
    });

    it('should reject debit when balance is insufficient', () => {
      // Grant small amount
      grantCredits(testOrgId, '10.00', 'grant-4', actor, 'Small');

      // Try to debit more than available
      const debitResult = recordDebit(
        testOrgId,
        '50.00',
        'claude-api',
        'run-99999',
        'debit-2',
        actor
      );

      assert.equal(debitResult.ok, false);
      assert.equal(debitResult.error.code, 'INSUFFICIENT_CREDITS');
      assert.equal(debitResult.error.details?.['shortfall'], '40.000000');
    });

    it('should be idempotent - same idempotency key returns same result', () => {
      grantCredits(testOrgId, '100.00', 'grant-5', actor, 'Initial');

      const debitResult1 = recordDebit(
        testOrgId,
        '25.00',
        'claude-api',
        'run-111',
        'idempotent-debit',
        actor
      );

      const debitResult2 = recordDebit(
        testOrgId,
        '25.00',
        'claude-api',
        'run-111',
        'idempotent-debit',
        actor
      );

      assert.ok(debitResult1.ok && debitResult2.ok);
      assert.equal(debitResult1.data.entry_id, debitResult2.data.entry_id);

      // Balance should only be deducted once
      const balance = getBalance(testOrgId);
      assert.ok(balance.ok);
      assert.equal(balance.data.current_balance, '75.000000');
    });
  });

  describe('Balance Calculation', () => {
    it('should correctly compute balance from ledger entries', () => {
      // Multiple grants
      grantCredits(testOrgId, '100.00', 'grant-a', actor, 'Grant A');
      grantCredits(testOrgId, '50.00', 'grant-b', actor, 'Grant B');

      // Multiple debits
      recordDebit(testOrgId, '30.00', 'svc-1', 'run-1', 'debit-a', actor);
      recordDebit(testOrgId, '20.00', 'svc-2', 'run-2', 'debit-b', actor);

      // Check balance
      const balance = getBalance(testOrgId);
      assert.ok(balance.ok, 'Balance query should succeed');

      // Expected: 100 + 50 - 30 - 20 = 100
      assert.equal(balance.data.current_balance, '100.000000');
      assert.equal(balance.data.reserved_amount, '0.000000');
      assert.equal(balance.data.available_balance, '100.000000');

      console.log('✓ Test 4: Correct balance calculation - PASSED');
    });

    it('should account for active reservations in available balance', () => {
      grantCredits(testOrgId, '100.00', 'grant-c', actor, 'Initial');

      // Add a reservation
      mockDb.insertReservation({
        organization_id: testOrgId,
        user_id: null,
        amount: '30.000000',
        expires_at: new Date(Date.now() + 3600000), // 1 hour from now
        status: 'active',
        correlation_id: null,
        idempotency_key: 'res-1',
        created_by: actor,
      });

      const balance = getBalance(testOrgId);
      assert.ok(balance.ok);
      assert.equal(balance.data.current_balance, '100.000000');
      assert.equal(balance.data.reserved_amount, '30.000000');
      assert.equal(balance.data.available_balance, '70.000000');
    });

    it('should not count expired reservations', () => {
      grantCredits(testOrgId, '100.00', 'grant-d', actor, 'Initial');

      // Add an expired reservation
      mockDb.insertReservation({
        organization_id: testOrgId,
        user_id: null,
        amount: '30.000000',
        expires_at: new Date(Date.now() - 1000), // Already expired
        status: 'active',
        correlation_id: null,
        idempotency_key: 'res-2',
        created_by: actor,
      });

      const balance = getBalance(testOrgId);
      assert.ok(balance.ok);
      assert.equal(balance.data.current_balance, '100.000000');
      assert.equal(balance.data.reserved_amount, '0.000000'); // Expired not counted
      assert.equal(balance.data.available_balance, '100.000000');
    });
  });

  describe('Input Validation', () => {
    it('should reject invalid amount', () => {
      const result = grantCredits(testOrgId, '-50.00', 'invalid-1', actor, 'Bad');
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INVALID_AMOUNT');
    });

    it('should reject zero amount', () => {
      const result = grantCredits(testOrgId, '0', 'invalid-2', actor, 'Zero');
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INVALID_AMOUNT');
    });
  });

  describe('Audit Trail', () => {
    it('should record all required audit fields', () => {
      const grantResult = grantCredits(
        testOrgId,
        '100.00',
        'audit-test',
        actor,
        'Audit test grant'
      );

      assert.ok(grantResult.ok);
      const entry = grantResult.data;

      // Verify audit fields per SPARC Section 1.9
      assert.ok(entry.entry_id, 'entry_id should be set');
      assert.equal(entry.organization_id, testOrgId);
      assert.equal(entry.entry_type, 'grant');
      assert.equal(entry.amount, '100.000000');
      assert.equal(entry.created_by, actor);
      assert.ok(entry.created_at, 'created_at should be set');
      assert.ok(entry.checksum, 'checksum should be set');
      assert.equal(entry.idempotency_key, 'audit-test');
    });
  });
});

// Summary output
console.log('\n========================================');
console.log('Ledger Test Suite');
console.log('========================================\n');
console.log('Running tests per SPARC requirements:\n');
console.log('1. Successful pre-flight check');
console.log('2. Rejected request due to insufficient credits');
console.log('3. Recorded debit');
console.log('4. Correct balance calculation\n');
