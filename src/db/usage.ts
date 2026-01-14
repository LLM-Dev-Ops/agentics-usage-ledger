/**
 * Database queries for usage tracking
 * Works with accounts and usage_history tables
 */

import { getPool } from './index.js';
import type { PoolClient } from 'pg';

// ============================================================================
// Types
// ============================================================================

export interface Account {
  id: string;
  org_id: string;
  total_credits: number;
  credits_used: number;
  credits_remaining: number;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

export interface UsageRecord {
  id: string;
  org_id: string;
  user_id: string | null;
  action: string;
  credits_used: number;
  command: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface BalanceResponse {
  org_id: string;
  current_balance: number;
  credits_remaining: number;
  credits_used: number;
  total_credits: number;
  currency: string;
  last_updated: string;
}

export interface UsageSummaryResponse {
  org_id: string;
  balance: number;
  credits_remaining: number;
  credits_used: number;
  total_credits: number;
  daily_usage: number;
  monthly_usage: number;
  last_activity: string | null;
}

export interface UsageHistoryItem {
  id: string;
  action: string;
  credits_used: number;
  command: string | null;
  correlation_id: string | null;
  timestamp: string;
}

export interface PaginatedHistory {
  history: UsageHistoryItem[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
  };
}

// ============================================================================
// Account Queries
// ============================================================================

/**
 * Get account by org_id, creating default if not exists
 */
export async function getOrCreateAccount(
  orgId: string,
  client?: PoolClient
): Promise<Account> {
  const db = client || getPool();

  // Try to get existing account
  const result = await db.query<Account>(
    `SELECT id, org_id, total_credits, credits_used, credits_remaining, currency, created_at, updated_at
     FROM accounts
     WHERE org_id = $1`,
    [orgId]
  );

  if (result.rows[0]) {
    return result.rows[0];
  }

  // Create new account with defaults
  const insertResult = await db.query<Account>(
    `INSERT INTO accounts (org_id, total_credits, credits_used)
     VALUES ($1, 10000, 0)
     ON CONFLICT (org_id) DO UPDATE SET updated_at = NOW()
     RETURNING id, org_id, total_credits, credits_used, credits_remaining, currency, created_at, updated_at`,
    [orgId]
  );

  return insertResult.rows[0]!;
}

/**
 * Get balance information for an org
 */
export async function getBalance(orgId: string): Promise<BalanceResponse> {
  const account = await getOrCreateAccount(orgId);

  return {
    org_id: account.org_id,
    current_balance: account.credits_remaining,
    credits_remaining: account.credits_remaining,
    credits_used: account.credits_used,
    total_credits: account.total_credits,
    currency: account.currency,
    last_updated: account.updated_at.toISOString(),
  };
}

/**
 * Get usage summary including daily/monthly stats
 */
export async function getUsageSummary(orgId: string): Promise<UsageSummaryResponse> {
  const pool = getPool();
  const account = await getOrCreateAccount(orgId);

  // Get daily usage (last 24 hours)
  const dailyResult = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(credits_used), 0) as total
     FROM usage_history
     WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
    [orgId]
  );
  const dailyUsage = parseInt(dailyResult.rows[0]?.total || '0', 10);

  // Get monthly usage (last 30 days)
  const monthlyResult = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(credits_used), 0) as total
     FROM usage_history
     WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
    [orgId]
  );
  const monthlyUsage = parseInt(monthlyResult.rows[0]?.total || '0', 10);

  // Get last activity
  const lastActivityResult = await pool.query<{ created_at: Date }>(
    `SELECT created_at
     FROM usage_history
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId]
  );
  const lastActivity = lastActivityResult.rows[0]?.created_at?.toISOString() || null;

  return {
    org_id: account.org_id,
    balance: account.credits_remaining,
    credits_remaining: account.credits_remaining,
    credits_used: account.credits_used,
    total_credits: account.total_credits,
    daily_usage: dailyUsage,
    monthly_usage: monthlyUsage,
    last_activity: lastActivity,
  };
}

// ============================================================================
// Usage History Queries
// ============================================================================

/**
 * Get usage history with pagination
 */
export async function getUsageHistory(
  orgId: string,
  limit: number = 50,
  offset: number = 0
): Promise<PaginatedHistory> {
  const pool = getPool();

  // Get total count
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM usage_history WHERE org_id = $1`,
    [orgId]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get history entries
  const historyResult = await pool.query<UsageRecord>(
    `SELECT id, org_id, user_id, action, credits_used, command, correlation_id, metadata, created_at
     FROM usage_history
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orgId, Math.min(limit, 100), offset]
  );

  const history: UsageHistoryItem[] = historyResult.rows.map((row) => ({
    id: row.id,
    action: row.action,
    credits_used: row.credits_used,
    command: row.command,
    correlation_id: row.correlation_id,
    timestamp: row.created_at.toISOString(),
  }));

  return {
    history,
    pagination: {
      offset,
      limit: Math.min(limit, 100),
      total,
    },
  };
}

/**
 * Record a usage event and update account balance
 */
export async function recordUsage(params: {
  org_id: string;
  user_id?: string;
  action: string;
  credits_used: number;
  command?: string;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; id: string }> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Ensure account exists
    await getOrCreateAccount(params.org_id, client);

    // Insert usage record
    const insertResult = await client.query<{ id: string }>(
      `INSERT INTO usage_history (org_id, user_id, action, credits_used, command, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.org_id,
        params.user_id || null,
        params.action,
        params.credits_used,
        params.command || null,
        params.correlation_id || null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );

    // Update account credits_used
    await client.query(
      `UPDATE accounts
       SET credits_used = credits_used + $2, updated_at = NOW()
       WHERE org_id = $1`,
      [params.org_id, params.credits_used]
    );

    await client.query('COMMIT');

    return {
      success: true,
      id: insertResult.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
