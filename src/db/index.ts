/**
 * Database access layer for Ruvector Postgres
 * Per SPARC requirements: SELECT and INSERT operations only
 * No DELETE or UPDATE on ledger_entries (append-only)
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import type {
  LedgerEntry,
  Reservation,
  Organization,
  EntryType,
  ReservationStatus,
} from '../types/index.js';
import { internalError } from '../errors/index.js';
import { createHash } from 'crypto';

let pool: Pool | null = null;

/**
 * Initialize database connection pool from environment variables
 */
export function initDb(): Pool {
  if (pool) return pool;

  // Support multiple environment variable naming conventions
  const host = process.env['USAGE_DB_HOST'] || process.env['PGHOST'] || process.env['DATABASE_HOST'] || 'localhost';
  const port = parseInt(process.env['USAGE_DB_PORT'] || process.env['PGPORT'] || process.env['DATABASE_PORT'] || '5432', 10);
  const database = process.env['USAGE_DB_NAME'] || process.env['PGDATABASE'] || process.env['DATABASE_NAME'] || 'usage-ledger';
  const user = process.env['USAGE_DB_USER'] || process.env['PGUSER'] || process.env['DATABASE_USER'] || 'postgres';
  const password = process.env['USAGE_DB_PASSWORD'] || process.env['PGPASSWORD'] || process.env['DATABASE_PASSWORD'] || '';
  const ssl = process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined;

  console.log(`Connecting to database at ${host}:${port}/${database}`);

  pool = new Pool({
    host,
    port,
    database,
    user,
    password,
    ssl,
    max: parseInt(process.env['DATABASE_POOL_SIZE'] || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
  });

  return pool;
}

/**
 * Get database pool (for testing injection)
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return pool;
}

/**
 * Set database pool (for testing)
 */
export function setPool(newPool: Pool): void {
  pool = newPool;
}

/**
 * Close database pool
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a transaction with proper error handling
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    // Use SERIALIZABLE isolation for ledger operations per SPARC Section 4.1.1
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Compute SHA-256 checksum for ledger entry
 * Per SPARC Section 1.9 - Integrity
 */
export function computeChecksum(entry: {
  organization_id: string;
  entry_type: string;
  amount: string;
  idempotency_key: string;
  created_by: string;
}): string {
  const data = [
    entry.organization_id,
    entry.entry_type,
    entry.amount,
    entry.idempotency_key,
    entry.created_by,
  ].join('|');

  return createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// Organization Queries (SELECT only - read from shared data plane)
// ============================================================================

/**
 * Get organization by ID
 * Assumes organizations table exists in shared data plane
 */
export async function getOrganization(
  organizationId: string,
  client?: PoolClient
): Promise<Organization | null> {
  const db = client || getPool();
  const result = await db.query<Organization>(
    `SELECT organization_id, name, status, created_at
     FROM organizations
     WHERE organization_id = $1`,
    [organizationId]
  );
  return result.rows[0] || null;
}

// ============================================================================
// Ledger Entry Queries (SELECT and INSERT only - append-only)
// ============================================================================

/**
 * Get entry by idempotency key for a given organization
 * Used for idempotent request handling
 */
export async function getEntryByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
  client?: PoolClient
): Promise<LedgerEntry | null> {
  const db = client || getPool();
  const result = await db.query<LedgerEntry>(
    `SELECT entry_id, organization_id, user_id, entry_type, amount, balance_after,
            idempotency_key, correlation_id, service, run_id, created_at, created_by,
            metadata, checksum
     FROM ledger_entries
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey]
  );
  return result.rows[0] || null;
}

/**
 * Get entry by ID
 */
export async function getEntryById(
  entryId: string,
  client?: PoolClient
): Promise<LedgerEntry | null> {
  const db = client || getPool();
  const result = await db.query<LedgerEntry>(
    `SELECT entry_id, organization_id, user_id, entry_type, amount, balance_after,
            idempotency_key, correlation_id, service, run_id, created_at, created_by,
            metadata, checksum
     FROM ledger_entries
     WHERE entry_id = $1`,
    [entryId]
  );
  return result.rows[0] || null;
}

/**
 * Compute current balance from ledger entries (source of truth)
 * Per SPARC Section 1.3.3 - Balance = SUM(all entry amounts)
 */
export async function computeCurrentBalance(
  organizationId: string,
  client?: PoolClient
): Promise<string> {
  const db = client || getPool();
  const result = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(amount), 0)::DECIMAL(20,6) as balance
     FROM ledger_entries
     WHERE organization_id = $1`,
    [organizationId]
  );
  return result.rows[0]?.balance || '0.000000';
}

/**
 * Get the balance_after from the most recent entry (optimization)
 * Falls back to computeCurrentBalance if no entries exist
 */
export async function getCurrentBalanceOptimized(
  organizationId: string,
  client?: PoolClient
): Promise<string> {
  const db = client || getPool();
  const result = await db.query<{ balance_after: string }>(
    `SELECT balance_after
     FROM ledger_entries
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [organizationId]
  );

  if (result.rows[0]) {
    return result.rows[0].balance_after;
  }

  return '0.000000';
}

/**
 * Insert a new ledger entry
 * This is the ONLY write operation on ledger_entries
 */
export async function insertLedgerEntry(
  entry: {
    organization_id: string;
    user_id?: string | null;
    entry_type: EntryType;
    amount: string;
    balance_after: string;
    idempotency_key: string;
    correlation_id?: string | null;
    service?: string | null;
    run_id?: string | null;
    created_by: string;
    metadata?: Record<string, unknown>;
  },
  client: PoolClient
): Promise<LedgerEntry> {
  const checksum = computeChecksum({
    organization_id: entry.organization_id,
    entry_type: entry.entry_type,
    amount: entry.amount,
    idempotency_key: entry.idempotency_key,
    created_by: entry.created_by,
  });

  const result = await client.query<LedgerEntry>(
    `INSERT INTO ledger_entries (
      organization_id, user_id, entry_type, amount, balance_after,
      idempotency_key, correlation_id, service, run_id, created_by,
      metadata, checksum
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING entry_id, organization_id, user_id, entry_type, amount, balance_after,
              idempotency_key, correlation_id, service, run_id, created_at, created_by,
              metadata, checksum`,
    [
      entry.organization_id,
      entry.user_id || null,
      entry.entry_type,
      entry.amount,
      entry.balance_after,
      entry.idempotency_key,
      entry.correlation_id || null,
      entry.service || null,
      entry.run_id || null,
      entry.created_by,
      JSON.stringify(entry.metadata || {}),
      checksum,
    ]
  );

  const inserted = result.rows[0];
  if (!inserted) {
    throw internalError();
  }
  return inserted;
}

/**
 * List ledger entries for an organization with pagination
 */
export async function listEntries(
  params: {
    organization_id: string;
    user_id?: string;
    service?: string;
    entry_type?: EntryType;
    limit?: number;
    offset?: number;
    from_date?: Date;
    to_date?: Date;
  },
  client?: PoolClient
): Promise<{ entries: LedgerEntry[]; total: number }> {
  const db = client || getPool();
  const conditions: string[] = ['organization_id = $1'];
  const values: unknown[] = [params.organization_id];
  let paramIndex = 2;

  if (params.user_id) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(params.user_id);
  }

  if (params.service) {
    conditions.push(`service = $${paramIndex++}`);
    values.push(params.service);
  }

  if (params.entry_type) {
    conditions.push(`entry_type = $${paramIndex++}`);
    values.push(params.entry_type);
  }

  if (params.from_date) {
    conditions.push(`created_at >= $${paramIndex++}`);
    values.push(params.from_date);
  }

  if (params.to_date) {
    conditions.push(`created_at <= $${paramIndex++}`);
    values.push(params.to_date);
  }

  const whereClause = conditions.join(' AND ');
  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;

  // Get total count
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ledger_entries WHERE ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get entries
  const entriesResult = await db.query<LedgerEntry>(
    `SELECT entry_id, organization_id, user_id, entry_type, amount, balance_after,
            idempotency_key, correlation_id, service, run_id, created_at, created_by,
            metadata, checksum
     FROM ledger_entries
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...values, limit, offset]
  );

  return { entries: entriesResult.rows, total };
}

// ============================================================================
// Reservation Queries (SELECT and INSERT, limited UPDATE for status)
// ============================================================================

/**
 * Get reservation by ID
 */
export async function getReservationById(
  reservationId: string,
  client?: PoolClient
): Promise<Reservation | null> {
  const db = client || getPool();
  const result = await db.query<Reservation>(
    `SELECT reservation_id, organization_id, user_id, amount, expires_at, status,
            created_at, consumed_at, cancelled_at, correlation_id, idempotency_key, created_by
     FROM reservations
     WHERE reservation_id = $1`,
    [reservationId]
  );
  return result.rows[0] || null;
}

/**
 * Get reservation by ID with row lock (FOR UPDATE)
 */
export async function getReservationForUpdate(
  reservationId: string,
  client: PoolClient
): Promise<Reservation | null> {
  const result = await client.query<Reservation>(
    `SELECT reservation_id, organization_id, user_id, amount, expires_at, status,
            created_at, consumed_at, cancelled_at, correlation_id, idempotency_key, created_by
     FROM reservations
     WHERE reservation_id = $1
     FOR UPDATE`,
    [reservationId]
  );
  return result.rows[0] || null;
}

/**
 * Get reservation by idempotency key
 */
export async function getReservationByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
  client?: PoolClient
): Promise<Reservation | null> {
  const db = client || getPool();
  const result = await db.query<Reservation>(
    `SELECT reservation_id, organization_id, user_id, amount, expires_at, status,
            created_at, consumed_at, cancelled_at, correlation_id, idempotency_key, created_by
     FROM reservations
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey]
  );
  return result.rows[0] || null;
}

/**
 * Get sum of active reservations for an organization
 */
export async function getActiveReservationsSum(
  organizationId: string,
  client?: PoolClient
): Promise<string> {
  const db = client || getPool();
  const result = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::DECIMAL(20,6) as total
     FROM reservations
     WHERE organization_id = $1
       AND status = 'active'
       AND expires_at > NOW()`,
    [organizationId]
  );
  return result.rows[0]?.total || '0.000000';
}

/**
 * Insert a new reservation
 */
export async function insertReservation(
  reservation: {
    organization_id: string;
    user_id?: string | null;
    amount: string;
    expires_at: Date;
    correlation_id?: string | null;
    idempotency_key: string;
    created_by: string;
  },
  client: PoolClient
): Promise<Reservation> {
  const result = await client.query<Reservation>(
    `INSERT INTO reservations (
      organization_id, user_id, amount, expires_at, status,
      correlation_id, idempotency_key, created_by
    ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
    RETURNING reservation_id, organization_id, user_id, amount, expires_at, status,
              created_at, consumed_at, cancelled_at, correlation_id, idempotency_key, created_by`,
    [
      reservation.organization_id,
      reservation.user_id || null,
      reservation.amount,
      reservation.expires_at,
      reservation.correlation_id || null,
      reservation.idempotency_key,
      reservation.created_by,
    ]
  );

  const inserted = result.rows[0];
  if (!inserted) {
    throw internalError();
  }
  return inserted;
}

/**
 * Update reservation status (only allowed state transitions)
 * This is the only UPDATE operation in the ledger service
 */
export async function updateReservationStatus(
  reservationId: string,
  newStatus: ReservationStatus,
  client: PoolClient
): Promise<void> {
  const timestampField = newStatus === 'consumed' ? 'consumed_at' :
                        newStatus === 'cancelled' ? 'cancelled_at' : null;

  if (timestampField) {
    await client.query(
      `UPDATE reservations
       SET status = $2, ${timestampField} = NOW()
       WHERE reservation_id = $1`,
      [reservationId, newStatus]
    );
  } else {
    await client.query(
      `UPDATE reservations
       SET status = $2
       WHERE reservation_id = $1`,
      [reservationId, newStatus]
    );
  }
}

/**
 * Check if entry has already been reversed
 */
export async function hasBeenReversed(
  entryId: string,
  client?: PoolClient
): Promise<boolean> {
  const db = client || getPool();
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM ledger_entries
      WHERE entry_type = 'reversal'
        AND correlation_id = $1
    ) as exists`,
    [entryId]
  );
  return result.rows[0]?.exists || false;
}
