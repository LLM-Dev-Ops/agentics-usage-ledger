/**
 * Lifecycle event handlers for agentics-usage-ledger
 *
 * Subscribes to execution_completed and deployment_completed events.
 * Each event triggers:
 * 1. Token usage recording (command_usage table)
 * 2. Cost attribution (weighted credits based on command + tokens)
 * 3. Billing ledger update (ledger_entries debit)
 * 4. Stripe meter event emission (async, non-blocking)
 */

import { randomUUID } from 'crypto';
import type {
  ExecutionCompletedEvent,
  DeploymentCompletedEvent,
  LifecycleEventResult,
  LedgerEntry,
  CommandUsageRecord,
} from '../types/index.js';
import { recordCommandExecution } from '../ledger/index.js';
import { recordDebit } from '../ledger/index.js';
import { getWeightedExecutionUnits } from '../stripe/index.js';
import { getEntitlement } from '../db/entitlements.js';

// ============================================================================
// Token-to-Credit Conversion
// ============================================================================

/**
 * Default cost per 1000 tokens (in credits) by model tier.
 * These are relative credit costs, not dollar amounts.
 */
const TOKEN_COST_PER_1K: Record<string, { input: number; output: number }> = {
  'claude-opus': { input: 0.015, output: 0.075 },
  'claude-sonnet': { input: 0.003, output: 0.015 },
  'claude-haiku': { input: 0.00025, output: 0.00125 },
  'gpt-4': { input: 0.01, output: 0.03 },
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  default: { input: 0.003, output: 0.015 },
};

/**
 * Resolve model tier from model string for cost lookup.
 * Matches partial model names to cost tiers.
 */
function resolveModelTier(model?: string): string {
  if (!model) return 'default';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'claude-opus';
  if (lower.includes('sonnet')) return 'claude-sonnet';
  if (lower.includes('haiku')) return 'claude-haiku';
  if (lower.includes('gpt-4o')) return 'gpt-4o';
  if (lower.includes('gpt-4')) return 'gpt-4';
  if (lower.includes('gpt-3.5')) return 'gpt-3.5-turbo';
  return 'default';
}

/**
 * Compute credits from token usage.
 * Returns the credit cost based on input/output token counts and model.
 */
export function computeCreditsFromTokens(
  inputTokens: number,
  outputTokens: number,
  model?: string
): number {
  const tier = resolveModelTier(model);
  const costs = TOKEN_COST_PER_1K[tier] || TOKEN_COST_PER_1K['default']!;
  const inputCost = (inputTokens / 1000) * costs.input;
  const outputCost = (outputTokens / 1000) * costs.output;
  // Minimum 1 credit per execution
  return Math.max(1, Math.ceil(inputCost + outputCost));
}

// ============================================================================
// execution_completed Handler
// ============================================================================

/**
 * Handle execution_completed lifecycle event.
 *
 * Processing steps:
 * 1. Compute credits from token usage (if not explicitly provided)
 * 2. Record token usage in command_usage table
 * 3. Create debit entry in ledger_entries (billing ledger)
 * 4. Stripe meter event is emitted automatically by recordCommandUsage
 */
export async function handleExecutionCompleted(
  event: ExecutionCompletedEvent
): Promise<LifecycleEventResult> {
  const {
    organization_id,
    user_id,
    command_name,
    success,
    token_usage,
    execution_time_ms,
    service,
    run_id,
    correlation_id,
    idempotency_key,
    metadata,
  } = event;

  // Step 1: Determine credits to charge
  let creditsUsed = event.credits_used;
  if (creditsUsed === undefined) {
    // Compute from token usage
    creditsUsed = computeCreditsFromTokens(
      token_usage.input_tokens,
      token_usage.output_tokens,
      token_usage.model
    );
  }

  // Apply command weight multiplier for cost attribution
  const weightedCredits = getWeightedExecutionUnits(command_name, creditsUsed);

  // Generate idempotency key if not provided
  const idemKey = idempotency_key || `exec-${randomUUID()}`;

  // Step 2: Record token usage in command_usage table
  // (This also triggers async Stripe meter event emission)
  const usageRecord = await recordCommandExecution({
    organization_id,
    user_id,
    command_name,
    success,
    credits_used: weightedCredits,
    execution_time_ms,
    correlation_id,
    metadata: {
      ...metadata,
      lifecycle_event: 'execution_completed',
      token_usage: {
        input_tokens: token_usage.input_tokens,
        output_tokens: token_usage.output_tokens,
        total_tokens: token_usage.total_tokens,
        model: token_usage.model,
      },
      raw_credits: creditsUsed,
      weighted_credits: weightedCredits,
    },
  });

  // Step 3: Create debit entry in billing ledger
  const ledgerEntry = await recordDebit({
    organization_id,
    user_id,
    amount: weightedCredits.toFixed(6),
    service: service || 'agentics-execution',
    run_id: run_id || usageRecord.usage_id,
    idempotency_key: `ledger-${idemKey}`,
    actor: user_id ? `principal:${user_id}` : 'service:usage-ledger',
    correlation_id: correlation_id || usageRecord.usage_id,
    metadata: {
      lifecycle_event: 'execution_completed',
      usage_id: usageRecord.usage_id,
      command_name,
      token_usage: {
        input_tokens: token_usage.input_tokens,
        output_tokens: token_usage.output_tokens,
        total_tokens: token_usage.total_tokens,
        model: token_usage.model,
      },
      success,
    },
  });

  return {
    usage_record: usageRecord,
    ledger_entry: ledgerEntry,
    stripe_emitted: true, // Stripe emission is fire-and-forget in recordCommandUsage
  };
}

// ============================================================================
// deployment_completed Handler
// ============================================================================

/**
 * Handle deployment_completed lifecycle event.
 *
 * Processing steps:
 * 1. Compute credits (deployment commands carry higher weight)
 * 2. Record usage in command_usage table
 * 3. Create debit entry in ledger_entries (billing ledger)
 * 4. Stripe meter event is emitted automatically
 */
export async function handleDeploymentCompleted(
  event: DeploymentCompletedEvent
): Promise<LifecycleEventResult> {
  const {
    organization_id,
    user_id,
    command_name,
    success,
    token_usage,
    execution_time_ms,
    environment,
    service,
    run_id,
    correlation_id,
    idempotency_key,
    metadata,
  } = event;

  // Step 1: Determine credits to charge
  let creditsUsed = event.credits_used;
  if (creditsUsed === undefined) {
    if (token_usage) {
      creditsUsed = computeCreditsFromTokens(
        token_usage.input_tokens,
        token_usage.output_tokens,
        token_usage.model
      );
    } else {
      // Deployments without token usage: use entitlement default
      const entitlement = await getEntitlement(organization_id, command_name);
      creditsUsed = entitlement?.credits_per_use || 1;
    }
  }

  // Apply command weight for cost attribution
  const weightedCredits = getWeightedExecutionUnits(command_name, creditsUsed);

  // Generate idempotency key if not provided
  const idemKey = idempotency_key || `deploy-${randomUUID()}`;

  // Step 2: Record usage in command_usage table
  const usageRecord = await recordCommandExecution({
    organization_id,
    user_id,
    command_name,
    success,
    credits_used: weightedCredits,
    execution_time_ms,
    correlation_id,
    metadata: {
      ...metadata,
      lifecycle_event: 'deployment_completed',
      environment,
      ...(token_usage
        ? {
            token_usage: {
              input_tokens: token_usage.input_tokens,
              output_tokens: token_usage.output_tokens,
              total_tokens: token_usage.total_tokens,
              model: token_usage.model,
            },
          }
        : {}),
      raw_credits: creditsUsed,
      weighted_credits: weightedCredits,
    },
  });

  // Step 3: Create debit entry in billing ledger
  const ledgerEntry = await recordDebit({
    organization_id,
    user_id,
    amount: weightedCredits.toFixed(6),
    service: service || 'agentics-deployment',
    run_id: run_id || usageRecord.usage_id,
    idempotency_key: `ledger-${idemKey}`,
    actor: user_id ? `principal:${user_id}` : 'service:usage-ledger',
    correlation_id: correlation_id || usageRecord.usage_id,
    metadata: {
      lifecycle_event: 'deployment_completed',
      usage_id: usageRecord.usage_id,
      command_name,
      environment,
      success,
      ...(token_usage
        ? {
            token_usage: {
              input_tokens: token_usage.input_tokens,
              output_tokens: token_usage.output_tokens,
              total_tokens: token_usage.total_tokens,
              model: token_usage.model,
            },
          }
        : {}),
    },
  });

  return {
    usage_record: usageRecord,
    ledger_entry: ledgerEntry,
    stripe_emitted: true,
  };
}
