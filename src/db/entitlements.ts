/**
 * Database access layer for entitlements
 * Manages command entitlements and usage tracking
 *
 * Includes Stripe metered usage emission:
 * - On every finalized usage record, emits to Stripe
 * - Stripe failures do not block command execution
 * - Uses usage_id as idempotency key
 */

import type { PoolClient } from 'pg';
import type {
  CommandEntitlement,
  CommandUsageRecord,
  CommandUsageStats,
  EntitlementStatus,
} from '../types/index.js';
import { getPool } from './index.js';
import { internalError } from '../errors/index.js';
import { randomUUID } from 'crypto';
import {
  emitMeterEventAsync,
  getWeightedExecutionUnits,
  isStripeConfigured,
} from '../stripe/index.js';
import { resolveStripeCustomer } from './org-stripe.js';

// ============================================================================
// Schema Initialization
// ============================================================================

/**
 * Initialize entitlements tables if they don't exist
 * Called on startup
 */
export async function initEntitlementsTables(): Promise<void> {
  const pool = getPool();

  // Create command_entitlements table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS command_entitlements (
      entitlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id VARCHAR(255) NOT NULL,
      command_name VARCHAR(128) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'enabled'
        CHECK (status IN ('enabled', 'disabled', 'suspended')),
      credits_per_use INTEGER NOT NULL DEFAULT 1,
      daily_limit INTEGER,
      monthly_limit INTEGER,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT unique_org_command UNIQUE (organization_id, command_name)
    )
  `);

  // Create index for efficient lookups
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_entitlements_org_status
    ON command_entitlements (organization_id, status)
    WHERE status = 'enabled'
  `);

  // Create command_usage table for tracking individual executions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS command_usage (
      usage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255),
      command_name VARCHAR(128) NOT NULL,
      credits_used INTEGER NOT NULL DEFAULT 1,
      success BOOLEAN NOT NULL DEFAULT true,
      execution_time_ms INTEGER,
      correlation_id UUID,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Create indexes for command_usage
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_command_usage_org_command_date
    ON command_usage (organization_id, command_name, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_command_usage_correlation
    ON command_usage (correlation_id)
    WHERE correlation_id IS NOT NULL
  `);

  console.log('Entitlements tables initialized');
}

// ============================================================================
// Entitlement Queries
// ============================================================================

/**
 * Get entitlement for a specific org/command combination
 */
export async function getEntitlement(
  organizationId: string,
  commandName: string,
  client?: PoolClient
): Promise<CommandEntitlement | null> {
  const db = client || getPool();
  const result = await db.query<CommandEntitlement>(
    `SELECT entitlement_id, organization_id, command_name, status,
            credits_per_use, daily_limit, monthly_limit, metadata,
            created_at, updated_at
     FROM command_entitlements
     WHERE organization_id = $1 AND command_name = $2`,
    [organizationId, commandName]
  );
  return result.rows[0] || null;
}

/**
 * Get all entitlements for an organization
 */
export async function getEntitlementsByOrg(
  organizationId: string,
  client?: PoolClient
): Promise<CommandEntitlement[]> {
  const db = client || getPool();
  const result = await db.query<CommandEntitlement>(
    `SELECT entitlement_id, organization_id, command_name, status,
            credits_per_use, daily_limit, monthly_limit, metadata,
            created_at, updated_at
     FROM command_entitlements
     WHERE organization_id = $1
     ORDER BY command_name`,
    [organizationId]
  );
  return result.rows;
}

/**
 * Create or update an entitlement
 */
export async function upsertEntitlement(
  data: {
    organization_id: string;
    command_name: string;
    status?: EntitlementStatus;
    credits_per_use?: number;
    daily_limit?: number | null;
    monthly_limit?: number | null;
    metadata?: Record<string, unknown>;
  },
  client?: PoolClient
): Promise<CommandEntitlement> {
  const db = client || getPool();
  const result = await db.query<CommandEntitlement>(
    `INSERT INTO command_entitlements (
      organization_id, command_name, status, credits_per_use,
      daily_limit, monthly_limit, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (organization_id, command_name) DO UPDATE SET
      status = COALESCE(EXCLUDED.status, command_entitlements.status),
      credits_per_use = COALESCE(EXCLUDED.credits_per_use, command_entitlements.credits_per_use),
      daily_limit = EXCLUDED.daily_limit,
      monthly_limit = EXCLUDED.monthly_limit,
      metadata = COALESCE(EXCLUDED.metadata, command_entitlements.metadata),
      updated_at = NOW()
    RETURNING entitlement_id, organization_id, command_name, status,
              credits_per_use, daily_limit, monthly_limit, metadata,
              created_at, updated_at`,
    [
      data.organization_id,
      data.command_name,
      data.status || 'enabled',
      data.credits_per_use || 1,
      data.daily_limit,
      data.monthly_limit,
      JSON.stringify(data.metadata || {}),
    ]
  );

  const inserted = result.rows[0];
  if (!inserted) {
    throw internalError();
  }
  return inserted;
}

/**
 * Update entitlement status
 */
export async function updateEntitlementStatus(
  organizationId: string,
  commandName: string,
  status: EntitlementStatus,
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();
  await db.query(
    `UPDATE command_entitlements
     SET status = $3, updated_at = NOW()
     WHERE organization_id = $1 AND command_name = $2`,
    [organizationId, commandName, status]
  );
}

// ============================================================================
// Usage Tracking
// ============================================================================

/**
 * Record a command usage event
 *
 * After recording to local ledger (source of truth), emits a meter
 * event to Stripe for usage tracking. Stripe failures are logged
 * but do not block the operation.
 */
export async function recordCommandUsage(
  data: {
    organization_id: string;
    user_id?: string | null;
    command_name: string;
    credits_used: number;
    success: boolean;
    execution_time_ms?: number | null;
    correlation_id?: string | null;
    metadata?: Record<string, unknown>;
  },
  client?: PoolClient
): Promise<CommandUsageRecord> {
  const db = client || getPool();
  const result = await db.query<CommandUsageRecord>(
    `INSERT INTO command_usage (
      organization_id, user_id, command_name, credits_used,
      success, execution_time_ms, correlation_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING usage_id, organization_id, user_id, command_name,
              credits_used, success, execution_time_ms, correlation_id,
              metadata, created_at`,
    [
      data.organization_id,
      data.user_id || null,
      data.command_name,
      data.credits_used,
      data.success,
      data.execution_time_ms || null,
      data.correlation_id || null,
      JSON.stringify(data.metadata || {}),
    ]
  );

  const inserted = result.rows[0];
  if (!inserted) {
    throw internalError();
  }

  // Emit Stripe meter event asynchronously (fire and forget)
  // This MUST NOT block command execution or fail the operation
  if (isStripeConfigured()) {
    emitStripeUsageEvent(inserted).catch((error) => {
      console.error('[Stripe] Failed to emit usage event:', error);
    });
  }

  return inserted;
}

/**
 * Emit Stripe meter event for a usage record
 * Called asynchronously after recording usage to local ledger
 *
 * Failures are logged but do not affect the usage record.
 */
async function emitStripeUsageEvent(
  usageRecord: CommandUsageRecord
): Promise<void> {
  // Resolve Stripe customer (lazy creation if needed)
  const stripeCustomerId = await resolveStripeCustomer(
    usageRecord.organization_id
  );

  if (!stripeCustomerId) {
    // No Stripe customer - this is fine, just skip
    console.log(
      `[Stripe] No customer for org ${usageRecord.organization_id}, skipping meter event`
    );
    return;
  }

  // Calculate weighted execution units
  const executionUnits = getWeightedExecutionUnits(
    usageRecord.command_name,
    usageRecord.credits_used
  );

  // Emit meter event (fire and forget)
  emitMeterEventAsync({
    stripeCustomerId,
    usageId: usageRecord.usage_id,
    organizationId: usageRecord.organization_id,
    executionUnits,
    timestamp: usageRecord.created_at,
    commandName: usageRecord.command_name,
  });
}

/**
 * Get daily usage count for an org/command
 */
export async function getDailyUsageCount(
  organizationId: string,
  commandName: string,
  client?: PoolClient
): Promise<number> {
  const db = client || getPool();
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM command_usage
     WHERE organization_id = $1
       AND command_name = $2
       AND created_at >= CURRENT_DATE
       AND created_at < CURRENT_DATE + INTERVAL '1 day'`,
    [organizationId, commandName]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Get monthly usage count for an org/command
 */
export async function getMonthlyUsageCount(
  organizationId: string,
  commandName: string,
  client?: PoolClient
): Promise<number> {
  const db = client || getPool();
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM command_usage
     WHERE organization_id = $1
       AND command_name = $2
       AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
       AND created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`,
    [organizationId, commandName]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * Get usage statistics for an org/command
 */
export async function getUsageStats(
  organizationId: string,
  commandName: string,
  client?: PoolClient
): Promise<CommandUsageStats> {
  const db = client || getPool();

  // Get daily count
  const dailyResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM command_usage
     WHERE organization_id = $1
       AND command_name = $2
       AND created_at >= CURRENT_DATE`,
    [organizationId, commandName]
  );

  // Get monthly count and total credits
  const monthlyResult = await db.query<{ count: string; total_credits: string }>(
    `SELECT COUNT(*) as count, COALESCE(SUM(credits_used), 0) as total_credits
     FROM command_usage
     WHERE organization_id = $1
       AND command_name = $2
       AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`,
    [organizationId, commandName]
  );

  return {
    organization_id: organizationId,
    command_name: commandName,
    daily_count: parseInt(dailyResult.rows[0]?.count || '0', 10),
    monthly_count: parseInt(monthlyResult.rows[0]?.count || '0', 10),
    total_credits_used: parseInt(monthlyResult.rows[0]?.total_credits || '0', 10),
  };
}

/**
 * Get usage history for an org with pagination
 */
export async function getCommandUsageHistory(
  params: {
    organization_id: string;
    command_name?: string;
    user_id?: string;
    limit?: number;
    offset?: number;
    from_date?: Date;
    to_date?: Date;
  },
  client?: PoolClient
): Promise<{ records: CommandUsageRecord[]; total: number }> {
  const db = client || getPool();
  const conditions: string[] = ['organization_id = $1'];
  const values: unknown[] = [params.organization_id];
  let paramIndex = 2;

  if (params.command_name) {
    conditions.push(`command_name = $${paramIndex++}`);
    values.push(params.command_name);
  }

  if (params.user_id) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(params.user_id);
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
    `SELECT COUNT(*) as count FROM command_usage WHERE ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Get records
  const recordsResult = await db.query<CommandUsageRecord>(
    `SELECT usage_id, organization_id, user_id, command_name,
            credits_used, success, execution_time_ms, correlation_id,
            metadata, created_at
     FROM command_usage
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...values, limit, offset]
  );

  return { records: recordsResult.rows, total };
}

// ============================================================================
// Default Entitlements (Bootstrap)
// ============================================================================

/**
 * State-changing commands that require entitlement checks
 * These are the commands that consume credits and need explicit entitlements
 */
export const ENTITLED_COMMANDS = [
  // Plan commands
  'plan:create',
  'plan:approve',
  // Simulate commands
  'simulate:create',
  'simulate:run',
  // Deploy commands
  'deploy:preview',
  'deploy:run',
  'deploy:rollback',
  // Export commands
  'export:csv',
  'export:json',
  'export:pdf',
  // Policy commands
  'policy:create',
  'policy:edit',
  'policy:enable',
  'policy:disable',
  'policy:dry-run',
  // Quantify commands
  'quantify:create',
  'quantify:compare',
  // ERP commands
  'erp:surface',
  'erp:map',
  'erp:export',
] as const;

export type EntitledCommand = (typeof ENTITLED_COMMANDS)[number];

/**
 * Bootstrap default entitlements for a new organization
 */
export async function bootstrapOrgEntitlements(
  organizationId: string,
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();

  // Insert all entitled commands with default limits
  const values: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  for (const command of ENTITLED_COMMANDS) {
    values.push(`($${paramIndex++}, $${paramIndex++}, 'enabled', 1, 1000, 10000, '{}'::jsonb)`);
    params.push(organizationId, command);
  }

  if (values.length > 0) {
    await db.query(
      `INSERT INTO command_entitlements (
        organization_id, command_name, status, credits_per_use,
        daily_limit, monthly_limit, metadata
      ) VALUES ${values.join(', ')}
      ON CONFLICT (organization_id, command_name) DO NOTHING`,
      params
    );
  }
}
