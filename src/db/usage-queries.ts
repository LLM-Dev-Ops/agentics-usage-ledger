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
 */
export interface UsageSummary {
  organization_id: string;
  period: {
    start: string;
    end: string;
  };
  totals: {
    total_executions: number;
    successful_executions: number;
    failed_executions: number;
    total_credits_used: number;
    unique_commands: number;
    unique_users: number;
  };
  daily_average: {
    executions: number;
    credits: number;
  };
  success_rate: number;
}

/**
 * Usage breakdown by command
 */
export interface UsageByCommand {
  command_name: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  total_credits: number;
  unique_users: number;
  avg_execution_time_ms: number | null;
  last_used_at: string;
}

/**
 * Usage breakdown by user/principal
 */
export interface UsageByUser {
  user_id: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  total_credits: number;
  unique_commands: number;
  last_active_at: string;
}

/**
 * Usage breakdown by day
 */
export interface UsageByDay {
  date: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  total_credits: number;
  unique_commands: number;
  unique_users: number;
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
    successful_executions: string;
    failed_executions: string;
    total_credits_used: string;
    unique_commands: string;
    unique_users: string;
    days_in_period: string;
  }>(
    `SELECT
      COUNT(*)::text as total_executions,
      COUNT(*) FILTER (WHERE success = true)::text as successful_executions,
      COUNT(*) FILTER (WHERE success = false)::text as failed_executions,
      COALESCE(SUM(credits_used), 0)::text as total_credits_used,
      COUNT(DISTINCT command_name)::text as unique_commands,
      COUNT(DISTINCT COALESCE(user_id, 'anonymous'))::text as unique_users,
      GREATEST(1, EXTRACT(DAY FROM ($3::timestamptz - $2::timestamptz)))::text as days_in_period
    FROM command_usage
    WHERE organization_id = $1
      AND created_at >= $2
      AND created_at <= $3`,
    [organizationId, startDate, endDate]
  );

  const row = result.rows[0];
  const totalExecutions = parseInt(row?.total_executions || '0', 10);
  const successfulExecutions = parseInt(row?.successful_executions || '0', 10);
  const daysInPeriod = parseInt(row?.days_in_period || '1', 10);
  const totalCredits = parseInt(row?.total_credits_used || '0', 10);

  return {
    organization_id: organizationId,
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    totals: {
      total_executions: totalExecutions,
      successful_executions: successfulExecutions,
      failed_executions: parseInt(row?.failed_executions || '0', 10),
      total_credits_used: totalCredits,
      unique_commands: parseInt(row?.unique_commands || '0', 10),
      unique_users: parseInt(row?.unique_users || '0', 10),
    },
    daily_average: {
      executions: Math.round((totalExecutions / daysInPeriod) * 100) / 100,
      credits: Math.round((totalCredits / daysInPeriod) * 100) / 100,
    },
    success_rate: totalExecutions > 0
      ? Math.round((successfulExecutions / totalExecutions) * 10000) / 100
      : 100,
  };
}

/**
 * Get usage breakdown by command
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

  // Get total count
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT command_name)::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
       AND created_at <= $3`,
    [params.organization_id, startDate, endDate]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get aggregated data
  const result = await db.query<{
    command_name: string;
    execution_count: string;
    success_count: string;
    failure_count: string;
    total_credits: string;
    unique_users: string;
    avg_execution_time_ms: string | null;
    last_used_at: Date;
  }>(
    `SELECT
      command_name,
      COUNT(*)::text as execution_count,
      COUNT(*) FILTER (WHERE success = true)::text as success_count,
      COUNT(*) FILTER (WHERE success = false)::text as failure_count,
      COALESCE(SUM(credits_used), 0)::text as total_credits,
      COUNT(DISTINCT COALESCE(user_id, 'anonymous'))::text as unique_users,
      AVG(execution_time_ms)::text as avg_execution_time_ms,
      MAX(created_at) as last_used_at
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
    success_count: parseInt(row.success_count, 10),
    failure_count: parseInt(row.failure_count, 10),
    total_credits: parseInt(row.total_credits, 10),
    unique_users: parseInt(row.unique_users, 10),
    avg_execution_time_ms: row.avg_execution_time_ms
      ? Math.round(parseFloat(row.avg_execution_time_ms))
      : null,
    last_used_at: row.last_used_at.toISOString(),
  }));

  return { data, total };
}

/**
 * Get usage breakdown by user/principal
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

  // Get total count
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT COALESCE(user_id, 'anonymous'))::text as count
     FROM command_usage
     WHERE organization_id = $1
       AND created_at >= $2
       AND created_at <= $3`,
    [params.organization_id, startDate, endDate]
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get aggregated data
  const result = await db.query<{
    user_id: string;
    execution_count: string;
    success_count: string;
    failure_count: string;
    total_credits: string;
    unique_commands: string;
    last_active_at: Date;
  }>(
    `SELECT
      COALESCE(user_id, 'anonymous') as user_id,
      COUNT(*)::text as execution_count,
      COUNT(*) FILTER (WHERE success = true)::text as success_count,
      COUNT(*) FILTER (WHERE success = false)::text as failure_count,
      COALESCE(SUM(credits_used), 0)::text as total_credits,
      COUNT(DISTINCT command_name)::text as unique_commands,
      MAX(created_at) as last_active_at
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
    user_id: row.user_id,
    execution_count: parseInt(row.execution_count, 10),
    success_count: parseInt(row.success_count, 10),
    failure_count: parseInt(row.failure_count, 10),
    total_credits: parseInt(row.total_credits, 10),
    unique_commands: parseInt(row.unique_commands, 10),
    last_active_at: row.last_active_at.toISOString(),
  }));

  return { data, total };
}

/**
 * Get usage breakdown by day
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
    success_count: string;
    failure_count: string;
    total_credits: string;
    unique_commands: string;
    unique_users: string;
  }>(
    `SELECT
      DATE(created_at) as date,
      COUNT(*)::text as execution_count,
      COUNT(*) FILTER (WHERE success = true)::text as success_count,
      COUNT(*) FILTER (WHERE success = false)::text as failure_count,
      COALESCE(SUM(credits_used), 0)::text as total_credits,
      COUNT(DISTINCT command_name)::text as unique_commands,
      COUNT(DISTINCT COALESCE(user_id, 'anonymous'))::text as unique_users
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
    success_count: parseInt(row.success_count, 10),
    failure_count: parseInt(row.failure_count, 10),
    total_credits: parseInt(row.total_credits, 10),
    unique_commands: parseInt(row.unique_commands, 10),
    unique_users: parseInt(row.unique_users, 10),
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
