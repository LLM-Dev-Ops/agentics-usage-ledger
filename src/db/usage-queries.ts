/**
 * Usage Query Functions for UI Backend
 *
 * READ-ONLY queries for usage data aggregation.
 * All queries are org-scoped to prevent cross-org access.
 *
 * Security invariants:
 * - All queries require org_id from authenticated context (not request body)
 * - No cross-org data leakage
 * - No raw data exposure - only aggregations
 */

import type { PoolClient } from 'pg';
import { getPool } from './index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Usage summary for an organization
 * Matches the required response format for Usage UI graphs
 */
export interface UsageSummary {
  /** Total number of command executions in the time window */
  total_executions: number;
  /** Total cost (credits consumed) in the time window */
  total_cost: number;
  /** Total number of failed executions in the time window */
  total_failures: number;
  /** Time window for the aggregation */
  time_window: {
    start: string;
    end: string;
  };
}

/**
 * Usage breakdown by command
 * Matches the required response format for Usage UI graphs
 */
export interface UsageByCommand {
  /** Command name */
  command_name: string;
  /** Number of executions of this command */
  execution_count: number;
  /** Total cost (credits consumed) for this command */
  total_cost: number;
  /** Number of failed executions of this command */
  failure_count: number;
}

/**
 * Usage breakdown by user/principal
 * Matches the required response format for Usage UI graphs
 */
export interface UsageByUser {
  /** Principal (GCP identity email) */
  principal: string;
  /** Number of executions by this principal */
  execution_count: number;
  /** Total cost (credits consumed) by this principal */
  total_cost: number;
}

/**
 * Usage breakdown by day
 * Matches the required response format for Usage UI graphs (time series)
 */
export interface UsageByDay {
  /** Date in ISO format (YYYY-MM-DD) */
  date: string;
  /** Number of executions on this day */
  execution_count: number;
  /** Total cost (credits consumed) on this day */
  total_cost: number;
  /** Number of failed executions on this day */
  failure_count: number;
}

/**
 * Query parameters for usage queries
 */
export interface UsageQueryParams {
  organization_id: string;
  from_date?: Date;
  to_date?: Date;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get usage summary for an organization
 *
 * Returns aggregated usage data for the specified time window.
 * All aggregation is done in SQL for efficiency.
 *
 * @param organizationId - Organization ID from authenticated context
 * @param fromDate - Start date (default: 30 days ago)
 * @param toDate - End date (default: now)
 */
export async function getUsageSummary(
  organizationId: string,
  fromDate?: Date,
  toDate?: Date,
  client?: PoolClient
): Promise<UsageSummary> {
  const db = client || getPool();
  const startDate = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = toDate || new Date();

  const result = await db.query<{
    total_executions: string;
    total_failures: string;
    total_cost: string;
  }>(
    `SELECT
      COUNT(*)::text as total_executions,
      COUNT(*) FILTER (WHERE success = false)::text as total_failures,
      COALESCE(SUM(credits_used), 0)::text as total_cost
    FROM command_usage
    WHERE organization_id = $1
      AND created_at >= $2
      AND created_at <= $3`,
    [organizationId, startDate, endDate]
  );

  const row = result.rows[0];

  return {
    total_executions: parseInt(row?.total_executions || '0', 10),
    total_cost: parseInt(row?.total_cost || '0', 10),
    total_failures: parseInt(row?.total_failures || '0', 10),
    time_window: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
  };
}

/**
 * Get usage breakdown by command
 *
 * Returns grouped metrics per command for the specified time window.
 * All aggregation is done in SQL for efficiency.
 *
 * @param organizationId - Organization ID from authenticated context
 */
export async function getUsageByCommand(
  params: UsageQueryParams,
  client?: PoolClient
): Promise<{ data: UsageByCommand[]; total: number }> {
  const db = client || getPool();
  const startDate = params.from_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = params.to_date || new Date();
  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;

  // Get total count of unique commands
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT command_name)::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
       AND created_at <= $3`,
    [params.organization_id, startDate, endDate]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get aggregated data per command
  const result = await db.query<{
    command_name: string;
    execution_count: string;
    failure_count: string;
    total_cost: string;
  }>(
    `SELECT
      command_name,
      COUNT(*)::text as execution_count,
      COUNT(*) FILTER (WHERE success = false)::text as failure_count,
      COALESCE(SUM(credits_used), 0)::text as total_cost
    FROM command_usage
    WHERE organization_id = $1
      AND created_at >= $2
      AND created_at <= $3
    GROUP BY command_name
    ORDER BY COUNT(*) DESC
    LIMIT $4 OFFSET $5`,
    [params.organization_id, startDate, endDate, limit, offset]
  );

  const data: UsageByCommand[] = result.rows.map(row => ({
    command_name: row.command_name,
    execution_count: parseInt(row.execution_count, 10),
    total_cost: parseInt(row.total_cost, 10),
    failure_count: parseInt(row.failure_count, 10),
  }));

  return { data, total };
}

/**
 * Get usage breakdown by user/principal
 *
 * Returns aggregated metrics per principal (GCP identity).
 * All aggregation is done in SQL for efficiency.
 *
 * @param organizationId - Organization ID from authenticated context
 */
export async function getUsageByUser(
  params: UsageQueryParams,
  client?: PoolClient
): Promise<{ data: UsageByUser[]; total: number }> {
  const db = client || getPool();
  const startDate = params.from_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = params.to_date || new Date();
  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;

  // Get total count of unique principals
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT COALESCE(user_id, 'anonymous'))::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
       AND created_at <= $3`,
    [params.organization_id, startDate, endDate]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get aggregated data per principal
  const result = await db.query<{
    principal: string;
    execution_count: string;
    total_cost: string;
  }>(
    `SELECT
      COALESCE(user_id, 'anonymous') as principal,
      COUNT(*)::text as execution_count,
      COALESCE(SUM(credits_used), 0)::text as total_cost
    FROM command_usage
    WHERE organization_id = $1
      AND created_at >= $2
      AND created_at <= $3
    GROUP BY COALESCE(user_id, 'anonymous')
    ORDER BY COUNT(*) DESC
    LIMIT $4 OFFSET $5`,
    [params.organization_id, startDate, endDate, limit, offset]
  );

  const data: UsageByUser[] = result.rows.map(row => ({
    principal: row.principal,
    execution_count: parseInt(row.execution_count, 10),
    total_cost: parseInt(row.total_cost, 10),
  }));

  return { data, total };
}

/**
 * Get usage breakdown by day
 *
 * Returns time series data for the specified time window.
 * All aggregation is done in SQL for efficiency.
 * Order is descending (most recent first) for UI graphs.
 *
 * @param organizationId - Organization ID from authenticated context
 */
export async function getUsageByDay(
  params: UsageQueryParams,
  client?: PoolClient
): Promise<{ data: UsageByDay[]; total: number }> {
  const db = client || getPool();
  const startDate = params.from_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = params.to_date || new Date();
  const limit = Math.min(params.limit || 90, 365); // Max 1 year of daily data
  const offset = params.offset || 0;

  // Get total count of days with data
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT DATE(created_at))::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
       AND created_at <= $3`,
    [params.organization_id, startDate, endDate]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get aggregated data by day
  const result = await db.query<{
    date: Date;
    execution_count: string;
    failure_count: string;
    total_cost: string;
  }>(
    `SELECT
      DATE(created_at) as date,
      COUNT(*)::text as execution_count,
      COUNT(*) FILTER (WHERE success = false)::text as failure_count,
      COALESCE(SUM(credits_used), 0)::text as total_cost
    FROM command_usage
    WHERE organization_id = $1
      AND created_at >= $2
      AND created_at <= $3
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at) DESC
    LIMIT $4 OFFSET $5`,
    [params.organization_id, startDate, endDate, limit, offset]
  );

  const data: UsageByDay[] = result.rows.map(row => ({
    date: row.date.toISOString().split('T')[0]!,
    execution_count: parseInt(row.execution_count, 10),
    total_cost: parseInt(row.total_cost, 10),
    failure_count: parseInt(row.failure_count, 10),
  }));

  return { data, total };
}

/**
 * Get recent activity feed for an organization
 *
 * Returns the most recent usage records (for activity dashboards)
 */
export async function getRecentActivity(
  organizationId: string,
  limit: number = 20,
  client?: PoolClient
): Promise<{
  usage_id: string;
  user_id: string | null;
  command_name: string;
  success: boolean;
  credits_used: number;
  created_at: string;
}[]> {
  const db = client || getPool();
  const safeLimit = Math.min(limit, 100);

  const result = await db.query<{
    usage_id: string;
    user_id: string | null;
    command_name: string;
    success: boolean;
    credits_used: number;
    created_at: Date;
  }>(
    `SELECT usage_id, user_id, command_name, success, credits_used, created_at
     FROM command_usage
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [organizationId, safeLimit]
  );

  return result.rows.map(row => ({
    usage_id: row.usage_id,
    user_id: row.user_id,
    command_name: row.command_name,
    success: row.success,
    credits_used: row.credits_used,
    created_at: row.created_at.toISOString(),
  }));
}

/**
 * Get top commands for an organization (for dashboards)
 */
export async function getTopCommands(
  organizationId: string,
  limit: number = 10,
  fromDate?: Date,
  client?: PoolClient
): Promise<{
  command_name: string;
  count: number;
  percentage: number;
}[]> {
  const db = client || getPool();
  const startDate = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const safeLimit = Math.min(limit, 50);

  // Get total for percentage calculation
  const totalResult = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text as total
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2`,
    [organizationId, startDate]
  );
  const total = parseInt(totalResult.rows[0]?.total || '0', 10);

  // Get top commands
  const result = await db.query<{
    command_name: string;
    count: string;
  }>(
    `SELECT command_name, COUNT(*)::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
     GROUP BY command_name
     ORDER BY COUNT(*) DESC
     LIMIT $3`,
    [organizationId, startDate, safeLimit]
  );

  return result.rows.map(row => ({
    command_name: row.command_name,
    count: parseInt(row.count, 10),
    percentage: total > 0
      ? Math.round((parseInt(row.count, 10) / total) * 10000) / 100
      : 0,
  }));
}

/**
 * Get top users for an organization (for dashboards)
 */
export async function getTopUsers(
  organizationId: string,
  limit: number = 10,
  fromDate?: Date,
  client?: PoolClient
): Promise<{
  user_id: string;
  count: number;
  credits_used: number;
}[]> {
  const db = client || getPool();
  const startDate = fromDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const safeLimit = Math.min(limit, 50);

  const result = await db.query<{
    user_id: string;
    count: string;
    credits_used: string;
  }>(
    `SELECT
       COALESCE(user_id, 'anonymous') as user_id,
       COUNT(*)::text as count,
       COALESCE(SUM(credits_used), 0)::text as credits_used
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
     GROUP BY COALESCE(user_id, 'anonymous')
     ORDER BY COUNT(*) DESC
     LIMIT $3`,
    [organizationId, startDate, safeLimit]
  );

  return result.rows.map(row => ({
    user_id: row.user_id,
    count: parseInt(row.count, 10),
    credits_used: parseInt(row.credits_used, 10),
  }));
}
