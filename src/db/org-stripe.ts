/**
 * Organization → Stripe Customer Mapping
 *
 * Manages the mapping between organization IDs and Stripe customer IDs.
 * Uses lazy customer creation - customers are created on first usage record.
 *
 * The mapping is stored in the accounts table for simplicity, alongside
 * the existing credit tracking fields.
 */

import type { PoolClient } from 'pg';
import { getPool } from './index.js';
import {
  createStripeCustomer,
  findStripeCustomerByOrgId,
  isStripeConfigured,
} from '../stripe/index.js';

// ============================================================================
// Schema Extension
// ============================================================================

/**
 * Add stripe_customer_id column to accounts table if it doesn't exist
 * Called during schema setup
 */
export async function addStripeCustomerColumn(): Promise<void> {
  const pool = getPool();

  try {
    // Check if column exists
    const checkResult = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'accounts'
        AND column_name = 'stripe_customer_id'
    `);

    if (checkResult.rows.length === 0) {
      // Add the column
      await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN stripe_customer_id VARCHAR(255)
      `);

      // Create index for efficient lookups
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer
        ON accounts(stripe_customer_id)
        WHERE stripe_customer_id IS NOT NULL
      `);

      console.log('Added stripe_customer_id column to accounts table');
    }
  } catch (error) {
    // Log but don't fail - table might not exist yet
    console.warn('Could not add stripe_customer_id column:', error);
  }
}

// ============================================================================
// Customer Mapping
// ============================================================================

interface OrgStripeMapping {
  org_id: string;
  stripe_customer_id: string | null;
}

/**
 * Get the Stripe customer ID for an organization
 * Returns null if not mapped or Stripe is not configured
 */
export async function getStripeCustomerId(
  orgId: string,
  client?: PoolClient
): Promise<string | null> {
  const db = client || getPool();

  const result = await db.query<OrgStripeMapping>(
    `SELECT org_id, stripe_customer_id
     FROM accounts
     WHERE org_id = $1`,
    [orgId]
  );

  return result.rows[0]?.stripe_customer_id || null;
}

/**
 * Store the Stripe customer ID for an organization
 */
export async function setStripeCustomerId(
  orgId: string,
  stripeCustomerId: string,
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();

  await db.query(
    `UPDATE accounts
     SET stripe_customer_id = $2, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, stripeCustomerId]
  );
}

/**
 * Resolve the Stripe customer ID for an organization.
 *
 * Resolution order:
 * 1. Check local database mapping
 * 2. Search Stripe by organization metadata
 * 3. Create new Stripe customer (lazy creation)
 *
 * Returns null if:
 * - Stripe is not configured
 * - Customer creation fails (logged but not blocking)
 */
export async function resolveStripeCustomer(
  orgId: string,
  orgName?: string
): Promise<string | null> {
  // Early exit if Stripe not configured
  if (!isStripeConfigured()) {
    return null;
  }

  // Step 1: Check local mapping
  const existingMapping = await getStripeCustomerId(orgId);
  if (existingMapping) {
    return existingMapping;
  }

  // Step 2: Search Stripe for existing customer
  const existingCustomer = await findStripeCustomerByOrgId(orgId);
  if (existingCustomer) {
    // Store mapping for future lookups
    try {
      await setStripeCustomerId(orgId, existingCustomer);
    } catch (error) {
      console.warn(`[Stripe] Failed to cache customer mapping for ${orgId}:`, error);
    }
    return existingCustomer;
  }

  // Step 3: Create new customer (lazy creation)
  const newCustomerId = await createStripeCustomer({
    organizationId: orgId,
    organizationName: orgName,
  });

  if (newCustomerId) {
    // Store mapping for future lookups
    try {
      await setStripeCustomerId(orgId, newCustomerId);
    } catch (error) {
      console.warn(`[Stripe] Failed to cache new customer mapping for ${orgId}:`, error);
    }
  }

  return newCustomerId;
}

/**
 * Check if an organization has a Stripe customer mapping
 */
export async function hasStripeCustomer(orgId: string): Promise<boolean> {
  const customerId = await getStripeCustomerId(orgId);
  return customerId !== null;
}

/**
 * Remove Stripe customer mapping (for cleanup/testing)
 */
export async function clearStripeCustomerId(
  orgId: string,
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();

  await db.query(
    `UPDATE accounts
     SET stripe_customer_id = NULL, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId]
  );
}
