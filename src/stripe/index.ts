/**
 * Stripe Metered Usage Integration
 *
 * Records usage to Stripe as a sink only - no billing/invoicing enabled.
 *
 * CRITICAL CONSTRAINTS:
 * - Stripe failures MUST NOT block command execution
 * - Stripe failures MUST be logged
 * - Ledger remains authoritative source of truth
 * - No invoices or payments are generated
 * - Idempotency enforced via usage_id
 */

import Stripe from 'stripe';

// ============================================================================
// Configuration
// ============================================================================

const STRIPE_SECRET_KEY = process.env['STRIPE_SECRET_KEY'];
const STRIPE_METER_EVENT_NAME = process.env['STRIPE_METER_EVENT_NAME'] || 'agentics_execution';

/**
 * Check if Stripe is configured
 */
export function isStripeConfigured(): boolean {
  return !!STRIPE_SECRET_KEY;
}

/**
 * Get Stripe client instance (lazy initialization)
 */
let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe | null {
  if (!STRIPE_SECRET_KEY) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = new Stripe(STRIPE_SECRET_KEY, {
      typescript: true,
    });
  }

  return stripeClient;
}

// ============================================================================
// Customer Management
// ============================================================================

export interface CreateCustomerParams {
  organizationId: string;
  organizationName?: string;
  email?: string;
  metadata?: Record<string, string>;
}

/**
 * Create a new Stripe customer for an organization
 * This is called lazily when first usage is recorded
 */
export async function createStripeCustomer(
  params: CreateCustomerParams
): Promise<string | null> {
  const stripe = getStripeClient();
  if (!stripe) {
    console.warn('[Stripe] Not configured - skipping customer creation');
    return null;
  }

  try {
    const customer = await stripe.customers.create({
      name: params.organizationName || `Organization ${params.organizationId}`,
      email: params.email,
      metadata: {
        organization_id: params.organizationId,
        source: 'agentics-usage-ledger',
        ...params.metadata,
      },
    });

    console.log(`[Stripe] Created customer ${customer.id} for org ${params.organizationId}`);
    return customer.id;
  } catch (error) {
    // Log but don't throw - Stripe failures must not block operations
    console.error('[Stripe] Failed to create customer:', error);
    return null;
  }
}

/**
 * Get an existing Stripe customer by organization metadata
 */
export async function findStripeCustomerByOrgId(
  organizationId: string
): Promise<string | null> {
  const stripe = getStripeClient();
  if (!stripe) {
    return null;
  }

  try {
    const customers = await stripe.customers.search({
      query: `metadata['organization_id']:'${organizationId}'`,
      limit: 1,
    });

    return customers.data[0]?.id || null;
  } catch (error) {
    console.error('[Stripe] Failed to search for customer:', error);
    return null;
  }
}

// ============================================================================
// Meter Event Emission
// ============================================================================

export interface MeterEventParams {
  /** Stripe customer ID (required for meter events) */
  stripeCustomerId: string;
  /** Usage ID from command_usage table (used as idempotency key) */
  usageId: string;
  /** Organization ID for logging/debugging */
  organizationId: string;
  /** Number of execution units (credits consumed) */
  executionUnits: number;
  /** Timestamp of the usage event */
  timestamp: Date;
  /** Optional command name for reference */
  commandName?: string;
}

export interface MeterEventResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Emit a meter event to Stripe for usage tracking
 *
 * This is fire-and-forget - failures are logged but do not block execution.
 * Uses usage_id as idempotency key to prevent duplicate reporting.
 */
export async function emitMeterEvent(
  params: MeterEventParams
): Promise<MeterEventResult> {
  const stripe = getStripeClient();

  if (!stripe) {
    // Stripe not configured - this is expected in dev environments
    return { success: false, error: 'Stripe not configured' };
  }

  try {
    // Stripe meter events use billing/meter_events API
    // Using the V2 meter events API
    const event = await stripe.billing.meterEvents.create({
      event_name: STRIPE_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: params.stripeCustomerId,
        value: String(params.executionUnits),
      },
      // Use usage_id as identifier for idempotency
      identifier: params.usageId,
      timestamp: Math.floor(params.timestamp.getTime() / 1000),
    });

    console.log(
      `[Stripe] Meter event emitted: ${event.identifier} for org ${params.organizationId} (${params.executionUnits} units)`
    );

    return {
      success: true,
      eventId: event.identifier,
    };
  } catch (error) {
    // Log the error but don't throw - Stripe failures must not block execution
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[Stripe] Failed to emit meter event for org ${params.organizationId}:`,
      errorMessage
    );

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Emit meter event without blocking - fire and forget
 * Returns immediately while the event is sent in background
 */
export function emitMeterEventAsync(params: MeterEventParams): void {
  // Fire and forget - don't await
  emitMeterEvent(params).catch((error) => {
    console.error('[Stripe] Async meter event failed:', error);
  });
}

// ============================================================================
// Weighted Usage Mapping
// ============================================================================

/**
 * Command weight multipliers for execution units
 * Higher weights for more resource-intensive operations
 */
const COMMAND_WEIGHTS: Record<string, number> = {
  // Simulation commands (resource intensive)
  'simulate:create': 5,
  'simulate:run': 10,

  // Deploy commands (high impact)
  'deploy:preview': 3,
  'deploy:run': 5,
  'deploy:rollback': 3,

  // Export commands (data intensive)
  'export:pdf': 3,
  'export:csv': 2,
  'export:json': 1,

  // Policy commands
  'policy:dry-run': 2,
  'policy:create': 1,
  'policy:edit': 1,
  'policy:enable': 1,
  'policy:disable': 1,

  // Quantify commands
  'quantify:create': 2,
  'quantify:compare': 3,

  // ERP commands
  'erp:surface': 2,
  'erp:map': 3,
  'erp:export': 2,

  // Plan commands
  'plan:create': 1,
  'plan:approve': 1,
};

/**
 * Get weighted execution units for a command
 * Returns the multiplied value or falls back to credits_used directly
 */
export function getWeightedExecutionUnits(
  commandName: string,
  creditsUsed: number
): number {
  const weight = COMMAND_WEIGHTS[commandName] || 1;
  return creditsUsed * weight;
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Check Stripe connectivity (for health endpoints)
 */
export async function checkStripeHealth(): Promise<{
  configured: boolean;
  connected: boolean;
  error?: string;
}> {
  if (!isStripeConfigured()) {
    return { configured: false, connected: false };
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return { configured: true, connected: false, error: 'Client initialization failed' };
  }

  try {
    // Simple API call to verify connectivity
    await stripe.balance.retrieve();
    return { configured: true, connected: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { configured: true, connected: false, error: errorMessage };
  }
}
