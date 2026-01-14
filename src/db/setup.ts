/**
 * Database setup and migration for usage ledger
 * Creates accounts and usage_history tables
 */

import { getPool } from './index.js';

/**
 * Setup database schema for usage tracking
 * Creates tables if they don't exist
 */
export async function setupUsageSchema(): Promise<void> {
  const pool = getPool();

  console.log('Setting up usage schema...');

  // Create accounts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id VARCHAR(255) NOT NULL UNIQUE,
      total_credits INTEGER NOT NULL DEFAULT 10000,
      credits_used INTEGER NOT NULL DEFAULT 0,
      credits_remaining INTEGER GENERATED ALWAYS AS (total_credits - credits_used) STORED,
      currency VARCHAR(10) NOT NULL DEFAULT 'credits',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Create index on org_id
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_org_id ON accounts(org_id)
  `);

  // Create usage_history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      credits_used INTEGER NOT NULL,
      command VARCHAR(255),
      correlation_id UUID,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Create indexes on usage_history
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_org_id ON usage_history(org_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_history(created_at DESC)
  `);

  // Insert default account if not exists
  await pool.query(`
    INSERT INTO accounts (org_id, total_credits, credits_used)
    VALUES ('default', 10000, 0)
    ON CONFLICT (org_id) DO NOTHING
  `);

  console.log('Usage schema setup complete');
}

/**
 * Check if database is properly configured
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT 1 as ok');
    return result.rows[0]?.ok === 1;
  } catch (error) {
    console.error('Database connection check failed:', error);
    return false;
  }
}
