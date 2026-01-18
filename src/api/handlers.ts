/**
 * HTTP API handlers for agentics-usage-ledger
 * Per SPARC Specification Section 3.3.1 (REST API)
 *
 * SECURITY MODEL (Cloud Run IAM):
 * - Cloud Run handles token validation (signature, expiration, audience)
 * - This service extracts principal from validated token
 * - org_id is resolved server-side from principal (NEVER from client)
 * - All usage writes require authenticated principal
 *
 * NON-NEGOTIABLE:
 * - NO JWT validation (Cloud Run handles this)
 * - NO API keys
 * - NO trusting client-supplied org_id or user_id for writes
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { EntryType } from '../types/index.js';
import {
  LedgerError,
  invalidRequest,
  internalError,
  unauthenticated,
  principalNotMapped,
} from '../errors/index.js';
import {
  authenticateAndAuthorize,
  type AuthenticatedContext,
  shouldEnforceAuth,
} from '../auth/index.js';
import {
  validateUuid,
  validatePositiveAmount,
  validateIdempotencyKey,
  validateActor,
  validateService,
  validatePositiveInt,
  validateNonNegativeInt,
  validateRequiredString,
  validateOptionalString,
  validateMetadata,
  validateEntryType,
  parseJsonBody,
} from '../validation/index.js';
import {
  getBalance,
  canExecute,
  grantCredits,
  recordDebit,
  reserveCredits,
  consumeReservation,
  cancelReservation,
  getReservation,
  getUsageHistory,
  getEntry,
  reverseEntry,
  isCommandAllowed,
  recordCommandExecution,
  getOrgEntitlements,
  getEntitledCommands,
  initializeOrgEntitlements,
} from '../ledger/index.js';
import {
  getBalance as getUsageBalance,
  getUsageSummary,
  getUsageHistory as getUsageHistorySimple,
  recordUsage,
} from '../db/usage.js';
import {
  getUsageSummary as getOrgUsageSummary,
  getUsageByCommand,
  getUsageByUser,
  getUsageByDay,
  getRecentActivity,
  getTopCommands,
  getTopUsers,
} from '../db/usage-queries.js';

// ============================================================================
// Request/Response Utilities
// ============================================================================

/**
 * Parse URL path parameters
 * Returns null if no match, otherwise returns groups object
 */
function parsePathParams(
  url: string,
  pattern: RegExp
): { [key: string]: string } | null {
  const match = url.match(pattern);
  if (!match?.groups) return null;
  // Groups are guaranteed to have values when regex matches
  // Cast is safe because our regex patterns only have required groups
  return match.groups as { [key: string]: string };
}

/**
 * Parse query parameters from URL
 */
function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

/**
 * Read request body as string
 */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
function sendError(res: ServerResponse, error: LedgerError): void {
  sendJson(res, error.httpStatus, error.toResponse());
}

/**
 * Get actor from request headers (DEPRECATED for writes)
 * For read-only operations where auth is optional
 */
function getActor(req: IncomingMessage): string {
  const actor = req.headers['x-actor'];
  if (typeof actor === 'string' && actor.trim()) {
    return actor.trim();
  }
  return 'service:usage-ledger';
}

/**
 * Require authentication and return context
 * Throws if not authenticated or principal cannot be mapped
 */
async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse
): Promise<AuthenticatedContext | null> {
  const authResult = await authenticateAndAuthorize(req);

  if (!authResult.authenticated || !authResult.context) {
    // Determine if this is an auth failure or mapping failure
    if (authResult.error?.includes('not mapped')) {
      throw principalNotMapped(authResult.error);
    }
    throw unauthenticated(authResult.error);
  }

  return authResult.context;
}

/**
 * Get actor string from authenticated context
 * Format: "principal:{email}"
 */
function getActorFromContext(ctx: AuthenticatedContext): string {
  return `principal:${ctx.principal.email}`;
}

// ============================================================================
// Route Patterns
// ============================================================================

const ROUTES = {
  // Balance
  balance: /^\/v1\/organizations\/(?<org_id>[^/]+)\/balance$/,

  // Pre-flight
  canExecute: /^\/v1\/organizations\/(?<org_id>[^/]+)\/can-execute$/,

  // Entries
  entries: /^\/v1\/organizations\/(?<org_id>[^/]+)\/entries$/,
  entry: /^\/v1\/organizations\/(?<org_id>[^/]+)\/entries\/(?<entry_id>[^/]+)$/,

  // Grants
  grants: /^\/v1\/organizations\/(?<org_id>[^/]+)\/grants$/,

  // Debits (direct usage recording)
  debits: /^\/v1\/organizations\/(?<org_id>[^/]+)\/debits$/,

  // Reservations
  reservations: /^\/v1\/organizations\/(?<org_id>[^/]+)\/reservations$/,
  reservation: /^\/v1\/organizations\/(?<org_id>[^/]+)\/reservations\/(?<reservation_id>[^/]+)$/,
  consumeReservation: /^\/v1\/organizations\/(?<org_id>[^/]+)\/reservations\/(?<reservation_id>[^/]+)\/consume$/,
  cancelReservation: /^\/v1\/organizations\/(?<org_id>[^/]+)\/reservations\/(?<reservation_id>[^/]+)\/cancel$/,

  // Reversals
  reversals: /^\/v1\/organizations\/(?<org_id>[^/]+)\/reversals$/,

  // Health
  health: /^\/health$/,

  // Simple Usage API (for CLI compatibility)
  usageBalance: /^\/v1\/usage\/balance$/,
  usage: /^\/v1\/usage$/,
  usageHistory: /^\/v1\/usage\/history$/,
  usageRecord: /^\/v1\/usage\/record$/,

  // Entitlements API (for command authorization)
  entitlements: /^\/v1\/organizations\/(?<org_id>[^/]+)\/entitlements$/,
  entitlementCommands: /^\/v1\/organizations\/(?<org_id>[^/]+)\/entitlements\/commands$/,
  entitlementCommand: /^\/v1\/organizations\/(?<org_id>[^/]+)\/entitlements\/commands\/(?<command_name>[^/]+)$/,

  // CLI-compatible Entitlement API
  canExecuteCommand: /^\/v1\/entitlements\/can-execute$/,
  recordExecution: /^\/v1\/entitlements\/record$/,
  entitledCommandsList: /^\/v1\/entitlements\/commands$/,

  // Usage Query Endpoints (UI Backend - IAM-secured)
  usageQuerySummary: /^\/usage\/summary$/,
  usageQueryByCommand: /^\/usage\/by-command$/,
  usageQueryByUser: /^\/usage\/by-user$/,
  usageQueryByDay: /^\/usage\/by-day$/,
  usageQueryRecent: /^\/usage\/recent$/,
  usageQueryTopCommands: /^\/usage\/top-commands$/,
  usageQueryTopUsers: /^\/usage\/top-users$/,
};

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * GET /v1/organizations/{org_id}/balance
 * Get current and available balance
 */
async function handleGetBalance(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const balance = await getBalance(orgId);
  sendJson(res, 200, { data: balance });
}

/**
 * POST /v1/organizations/{org_id}/can-execute
 * Pre-flight check for execution
 */
async function handleCanExecute(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  const result = await canExecute({
    organization_id: orgId,
    required_credits: validatePositiveAmount(data['required_credits'], 'required_credits'),
    user_id: validateOptionalString(data['user_id'], 'user_id'),
    service: validateOptionalString(data['service'], 'service'),
    run_id: validateOptionalString(data['run_id'], 'run_id'),
    idempotency_key: data['idempotency_key']
      ? validateIdempotencyKey(data['idempotency_key'])
      : undefined,
  });

  sendJson(res, 200, { data: result });
}

/**
 * GET /v1/organizations/{org_id}/entries
 * List ledger entries with pagination
 */
async function handleListEntries(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const query = parseQueryParams(req.url || '');

  const limit = query.get('limit')
    ? validatePositiveInt(query.get('limit'), 'limit', { max: 100 })
    : 50;
  const offset = query.get('offset')
    ? validateNonNegativeInt(query.get('offset'), 'offset')
    : 0;

  const result = await getUsageHistory({
    organization_id: orgId,
    user_id: query.get('user_id') || undefined,
    service: query.get('service') || undefined,
    entry_type: query.get('entry_type')
      ? validateEntryType(query.get('entry_type'))
      : undefined,
    limit,
    offset,
    from_date: query.get('from_date')
      ? new Date(query.get('from_date')!)
      : undefined,
    to_date: query.get('to_date')
      ? new Date(query.get('to_date')!)
      : undefined,
  });

  sendJson(res, 200, result);
}

/**
 * GET /v1/organizations/{org_id}/entries/{entry_id}
 * Get specific ledger entry
 */
async function handleGetEntry(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const entryId = validateUuid(params['entry_id']!, 'entry_id');

  const entry = await getEntry(orgId, entryId);
  sendJson(res, 200, { data: entry });
}

/**
 * POST /v1/organizations/{org_id}/grants
 * Grant credits
 */
async function handleGrant(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const actor = getActor(req);
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  const entry = await grantCredits({
    organization_id: orgId,
    amount: validatePositiveAmount(data['amount'], 'amount'),
    reason: validateRequiredString(data['reason'], 'reason', { maxLength: 500 }),
    idempotency_key: validateIdempotencyKey(data['idempotency_key']),
    actor,
    correlation_id: data['correlation_id']
      ? validateUuid(data['correlation_id'], 'correlation_id')
      : undefined,
  });

  sendJson(res, 201, { data: entry });
}

/**
 * POST /v1/organizations/{org_id}/debits
 * Record direct debit (usage)
 */
async function handleDebit(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const actor = getActor(req);
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  const entry = await recordDebit({
    organization_id: orgId,
    user_id: validateOptionalString(data['user_id'], 'user_id'),
    amount: validatePositiveAmount(data['amount'], 'amount'),
    service: validateService(data['service']),
    run_id: validateRequiredString(data['run_id'], 'run_id', { maxLength: 255 }),
    idempotency_key: validateIdempotencyKey(data['idempotency_key']),
    actor,
    correlation_id: data['correlation_id']
      ? validateUuid(data['correlation_id'], 'correlation_id')
      : undefined,
    metadata: validateMetadata(data['metadata']),
  });

  sendJson(res, 201, { data: entry });
}

/**
 * POST /v1/organizations/{org_id}/reservations
 * Create credit reservation
 */
async function handleCreateReservation(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const actor = getActor(req);
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  const reservation = await reserveCredits({
    organization_id: orgId,
    user_id: validateOptionalString(data['user_id'], 'user_id'),
    amount: validatePositiveAmount(data['amount'], 'amount'),
    ttl_seconds: validatePositiveInt(data['ttl_seconds'], 'ttl_seconds', { max: 86400 }),
    correlation_id: data['correlation_id']
      ? validateUuid(data['correlation_id'], 'correlation_id')
      : undefined,
    idempotency_key: validateIdempotencyKey(data['idempotency_key']),
    actor,
  });

  sendJson(res, 201, { data: reservation });
}

/**
 * GET /v1/organizations/{org_id}/reservations/{reservation_id}
 * Get reservation status
 */
async function handleGetReservation(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const reservationId = validateUuid(params['reservation_id']!, 'reservation_id');

  const reservation = await getReservation(reservationId);

  // Verify organization ownership
  if (reservation.organization_id !== orgId) {
    throw invalidRequest('Reservation not found');
  }

  sendJson(res, 200, { data: reservation });
}

/**
 * POST /v1/organizations/{org_id}/reservations/{reservation_id}/consume
 * Consume reservation
 */
async function handleConsumeReservation(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const reservationId = validateUuid(params['reservation_id']!, 'reservation_id');
  const actor = getActor(req);
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  // Verify reservation belongs to organization
  const reservation = await getReservation(reservationId);
  if (reservation.organization_id !== orgId) {
    throw invalidRequest('Reservation not found');
  }

  const entry = await consumeReservation({
    reservation_id: reservationId,
    actual_amount: validatePositiveAmount(data['actual_amount'], 'actual_amount'),
    idempotency_key: validateIdempotencyKey(data['idempotency_key']),
    actor,
    service: validateOptionalString(data['service'], 'service'),
    run_id: validateOptionalString(data['run_id'], 'run_id'),
    metadata: validateMetadata(data['metadata']),
  });

  sendJson(res, 200, { data: entry });
}

/**
 * POST /v1/organizations/{org_id}/reservations/{reservation_id}/cancel
 * Cancel reservation
 */
async function handleCancelReservation(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const reservationId = validateUuid(params['reservation_id']!, 'reservation_id');
  const actor = getActor(req);

  // Verify reservation belongs to organization
  const existing = await getReservation(reservationId);
  if (existing.organization_id !== orgId) {
    throw invalidRequest('Reservation not found');
  }

  const reservation = await cancelReservation(reservationId, actor);
  sendJson(res, 200, { data: reservation });
}

/**
 * POST /v1/organizations/{org_id}/reversals
 * Reverse a ledger entry
 */
async function handleReversal(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = validateUuid(params['org_id']!, 'org_id');
  const actor = getActor(req);
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  const entryId = validateUuid(data['entry_id'], 'entry_id');

  // Verify entry belongs to organization
  const originalEntry = await getEntry(orgId, entryId);

  const entry = await reverseEntry(
    entryId,
    validateRequiredString(data['reason'], 'reason', { maxLength: 500 }),
    validateIdempotencyKey(data['idempotency_key']),
    actor
  );

  sendJson(res, 201, { data: entry });
}

// ============================================================================
// Simple Usage API Handlers (for CLI compatibility)
// ============================================================================

/**
 * GET /v1/usage/balance
 * Get current balance for org/user
 * Query params: org_id (optional, defaults to 'default')
 */
async function handleUsageBalance(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const query = parseQueryParams(req.url || '');
  const orgId = query.get('org_id') || 'default';

  const balance = await getUsageBalance(orgId);
  sendJson(res, 200, balance);
}

/**
 * GET /v1/usage
 * Get usage summary
 * Query params: org_id (optional, defaults to 'default')
 */
async function handleUsageSummary(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const query = parseQueryParams(req.url || '');
  const orgId = query.get('org_id') || 'default';

  const summary = await getUsageSummary(orgId);
  sendJson(res, 200, summary);
}

/**
 * GET /v1/usage/history
 * Get usage history with pagination
 * Query params: org_id (optional), limit (default 50), offset (default 0)
 */
async function handleUsageHistorySimple(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const query = parseQueryParams(req.url || '');
  const orgId = query.get('org_id') || 'default';

  const limit = query.get('limit')
    ? parseInt(query.get('limit')!, 10)
    : 50;
  const offset = query.get('offset')
    ? parseInt(query.get('offset')!, 10)
    : 0;

  // Validate limit and offset
  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw invalidRequest('limit must be between 1 and 100');
  }
  if (isNaN(offset) || offset < 0) {
    throw invalidRequest('offset must be a non-negative integer');
  }

  const history = await getUsageHistorySimple(orgId, limit, offset);
  sendJson(res, 200, history);
}

/**
 * POST /v1/usage/record
 * Record a usage event
 *
 * SECURITY: All usage writes require Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NOT from client)
 * - user_id is set to authenticated principal (NOT from client)
 * - Client-supplied identity fields are IGNORED
 */
async function handleUsageRecord(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // STEP 1: Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) {
    return; // Error already sent
  }

  // STEP 2: Parse request body
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  // Validate required fields (org_id NOT required - comes from auth)
  if (!data['action'] || typeof data['action'] !== 'string') {
    throw invalidRequest('action is required and must be a string');
  }
  if (typeof data['credits_used'] !== 'number' || data['credits_used'] < 0) {
    throw invalidRequest('credits_used is required and must be a non-negative number');
  }

  // STEP 3: Record usage with authenticated org_id and principal
  // Client-supplied org_id and user_id are IGNORED
  const result = await recordUsage({
    org_id: authContext.organization_id, // From server-side mapping
    user_id: authContext.principal.email, // Authenticated GCP identity
    action: data['action'] as string,
    credits_used: data['credits_used'] as number,
    command: typeof data['command'] === 'string' ? data['command'] : undefined,
    correlation_id: typeof data['correlation_id'] === 'string' ? data['correlation_id'] : undefined,
    metadata: {
      // Include audit metadata
      principal: authContext.principal.email,
      principal_subject: authContext.principal.subject,
      mapping_source: authContext.mapping_source,
      // Include any client-provided metadata
      ...(typeof data['metadata'] === 'object' && data['metadata'] !== null
        ? data['metadata'] as Record<string, unknown>
        : {}),
    },
  });

  sendJson(res, 201, {
    ...result,
    principal: authContext.principal.email,
    organization_id: authContext.organization_id,
  });
}

/**
 * GET /health
 * Health check endpoint
 */
async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  sendJson(res, 200, {
    status: 'healthy',
    service: 'agentics-usage-ledger',
    timestamp: new Date().toISOString(),
  });
}

// ============================================================================
// Entitlement API Handlers
// ============================================================================

/**
 * GET /v1/organizations/{org_id}/entitlements
 * Get all entitlements for an organization
 */
async function handleGetEntitlements(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = params['org_id']!;
  const entitlements = await getOrgEntitlements(orgId);
  sendJson(res, 200, { data: entitlements });
}

/**
 * POST /v1/organizations/{org_id}/entitlements
 * Initialize default entitlements for an organization
 */
async function handleInitEntitlements(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = params['org_id']!;
  await initializeOrgEntitlements(orgId);
  const entitlements = await getOrgEntitlements(orgId);
  sendJson(res, 201, { data: entitlements, message: 'Entitlements initialized' });
}

/**
 * GET /v1/organizations/{org_id}/entitlements/commands
 * List all commands that require entitlements
 */
async function handleGetEntitledCommands(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const commands = getEntitledCommands();
  sendJson(res, 200, { data: commands });
}

/**
 * GET /v1/organizations/{org_id}/entitlements/commands/{command_name}
 * Check if a specific command is allowed
 */
async function handleCheckCommand(
  req: IncomingMessage,
  res: ServerResponse,
  params: { [key: string]: string }
): Promise<void> {
  const orgId = params['org_id']!;
  const commandName = decodeURIComponent(params['command_name']!);
  const query = parseQueryParams(req.url || '');
  const userId = query.get('user_id') || undefined;

  const result = await isCommandAllowed({
    organization_id: orgId,
    command_name: commandName,
    user_id: userId,
  });

  // Return 200 with allowed status (not 403) so CLI can handle the response
  sendJson(res, 200, { data: result });
}

/**
 * POST /v1/entitlements/can-execute
 * CLI-compatible endpoint: Check if a command is allowed
 *
 * SECURITY: This is the main entitlement gate for the CLI
 * - REQUIRES Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NOT from client)
 * - Client-supplied org_id is IGNORED
 *
 * Flow:
 * 1. Authenticate request (Cloud Run validates token)
 * 2. Extract principal email from token
 * 3. Resolve org_id from principal (server-side mapping)
 * 4. Check entitlement for resolved org_id
 */
async function handleCanExecuteCommand(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // STEP 1: Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) {
    return; // Error already sent
  }

  // STEP 2: Parse request body
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  // Validate required field (only command_name - org_id comes from auth)
  if (!data['command_name'] || typeof data['command_name'] !== 'string') {
    throw invalidRequest('command_name is required and must be a string');
  }

  // STEP 3: Use org_id from authenticated context (NOT from client)
  // Client-supplied org_id is IGNORED for security
  const result = await isCommandAllowed({
    organization_id: authContext.organization_id, // From server-side mapping
    command_name: data['command_name'] as string,
    user_id: authContext.principal.email, // Use authenticated principal
  });

  // If not allowed, return 403 with structured error for CLI
  if (!result.allowed) {
    sendJson(res, 403, {
      error: {
        code: 'ACCESS_DENIED',
        message: result.reason || 'Your organization is not entitled to run this command.',
        details: {
          organization_id: result.organization_id,
          command_name: result.command_name,
          principal: authContext.principal.email,
          daily_usage: result.daily_usage,
          daily_limit: result.daily_limit,
          monthly_usage: result.monthly_usage,
          monthly_limit: result.monthly_limit,
        },
      },
    });
    return;
  }

  // Command is allowed - include principal in response
  sendJson(res, 200, {
    data: {
      ...result,
      principal: authContext.principal.email,
      mapping_source: authContext.mapping_source,
    },
  });
}

/**
 * POST /v1/entitlements/record
 * CLI-compatible endpoint: Record command execution
 *
 * SECURITY: Usage recording is the authoritative audit trail
 * - REQUIRES Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NOT from client)
 * - principal is cryptographically attributable to GCP identity
 * - Client-supplied org_id/user_id are IGNORED
 *
 * MANDATORY fields in every usage record:
 * - org_id (resolved internally from principal)
 * - principal (GCP identity from Cloud Run auth)
 * - command_name
 * - timestamp (set by server)
 * - success / failure
 * - cost_units (credits_used)
 */
async function handleRecordExecution(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // STEP 1: Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) {
    return; // Error already sent
  }

  // STEP 2: Parse request body
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  // Validate required fields (org_id NOT required - comes from auth)
  if (!data['command_name'] || typeof data['command_name'] !== 'string') {
    throw invalidRequest('command_name is required and must be a string');
  }
  if (typeof data['success'] !== 'boolean') {
    throw invalidRequest('success is required and must be a boolean');
  }

  // STEP 3: Record usage with authenticated org_id and principal
  // Client-supplied org_id and user_id are IGNORED
  const result = await recordCommandExecution({
    organization_id: authContext.organization_id, // From server-side mapping
    user_id: authContext.principal.email, // Authenticated GCP identity
    command_name: data['command_name'] as string,
    success: data['success'] as boolean,
    credits_used: typeof data['credits_used'] === 'number' ? data['credits_used'] : undefined,
    execution_time_ms: typeof data['execution_time_ms'] === 'number' ? data['execution_time_ms'] : undefined,
    correlation_id: typeof data['correlation_id'] === 'string' ? data['correlation_id'] : undefined,
    metadata: {
      // Include audit metadata
      principal: authContext.principal.email,
      principal_subject: authContext.principal.subject,
      mapping_source: authContext.mapping_source,
      // Include any client-provided metadata
      ...(typeof data['metadata'] === 'object' && data['metadata'] !== null
        ? data['metadata'] as Record<string, unknown>
        : {}),
    },
  });

  sendJson(res, 201, {
    data: {
      ...result,
      principal: authContext.principal.email,
      organization_id: authContext.organization_id,
    },
  });
}

/**
 * GET /v1/entitlements/commands
 * CLI-compatible endpoint: List all entitled commands
 */
async function handleListEntitledCommands(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const commands = getEntitledCommands();
  sendJson(res, 200, {
    data: commands,
    total: commands.length,
  });
}

// ============================================================================
// Usage Query Handlers (UI Backend - IAM-secured)
// ============================================================================

/**
 * Parse date from query parameter
 */
function parseDateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw invalidRequest(`Invalid date format: ${value}`);
  }
  return date;
}

/**
 * GET /usage/summary
 * Get usage summary for authenticated organization
 *
 * SECURITY: Requires Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NEVER from client)
 * - Only returns data for the authenticated organization
 * - Unauthenticated requests are automatically rejected via IAM
 *
 * Query params:
 * - start_date: Start date (ISO format, default: 30 days ago)
 * - end_date: End date (ISO format, default: now)
 *
 * Returns:
 * - total_executions: Total number of command executions
 * - total_cost: Total credits consumed
 * - total_failures: Total failed executions
 * - time_window: { start, end } ISO timestamps
 */
async function handleUsageQuerySummary(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication - org_id resolved server-side
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');
  // Support both start_date/end_date and from_date/to_date for flexibility
  const fromDate = parseDateParam(query.get('start_date') || query.get('from_date'));
  const toDate = parseDateParam(query.get('end_date') || query.get('to_date'));

  const summary = await getOrgUsageSummary(
    authContext.organization_id,
    fromDate,
    toDate
  );

  // Return exact spec format - no extra fields
  sendJson(res, 200, summary);
}

/**
 * GET /usage/by-command
 * Get usage breakdown by command for authenticated organization
 *
 * SECURITY: Requires Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NEVER from client)
 * - Only returns data for the authenticated organization
 * - No cross-org access possible
 * - Unauthenticated requests are automatically rejected via IAM
 *
 * Query params:
 * - start_date: Start date (ISO format, default: 30 days ago)
 * - end_date: End date (ISO format, default: now)
 * - limit: Max records to return (default: 50, max: 100)
 * - offset: Pagination offset (default: 0)
 *
 * Returns array of:
 * - command_name: Name of the command
 * - execution_count: Number of executions
 * - total_cost: Total credits consumed
 * - failure_count: Number of failed executions
 */
async function handleUsageQueryByCommand(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication - org_id resolved server-side
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');

  const result = await getUsageByCommand({
    organization_id: authContext.organization_id,
    from_date: parseDateParam(query.get('start_date') || query.get('from_date')),
    to_date: parseDateParam(query.get('end_date') || query.get('to_date')),
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  });

  // Return array directly for chart compatibility
  sendJson(res, 200, result.data);
}

/**
 * GET /usage/by-user
 * Get usage breakdown by user/principal for authenticated organization
 *
 * SECURITY: Requires Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NEVER from client)
 * - Only returns data for the authenticated organization
 * - Principal IDs are GCP identity emails (auditable)
 * - Unauthenticated requests are automatically rejected via IAM
 *
 * Query params:
 * - start_date: Start date (ISO format, default: 30 days ago)
 * - end_date: End date (ISO format, default: now)
 * - limit: Max records to return (default: 50, max: 100)
 * - offset: Pagination offset (default: 0)
 *
 * Returns array of:
 * - principal: GCP identity email
 * - execution_count: Number of executions
 * - total_cost: Total credits consumed
 */
async function handleUsageQueryByUser(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication - org_id resolved server-side
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');

  const result = await getUsageByUser({
    organization_id: authContext.organization_id,
    from_date: parseDateParam(query.get('start_date') || query.get('from_date')),
    to_date: parseDateParam(query.get('end_date') || query.get('to_date')),
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  });

  // Return array directly for chart compatibility
  sendJson(res, 200, result.data);
}

/**
 * GET /usage/by-day
 * Get daily usage breakdown for authenticated organization (time series)
 *
 * SECURITY: Requires Cloud Run IAM authentication
 * - org_id is resolved from authenticated principal (NEVER from client)
 * - Only returns data for the authenticated organization
 * - Unauthenticated requests are automatically rejected via IAM
 *
 * Query params:
 * - start_date: Start date (ISO format, default: 30 days ago)
 * - end_date: End date (ISO format, default: now)
 * - limit: Max days to return (default: 90, max: 365)
 * - offset: Pagination offset (default: 0)
 *
 * Returns array of:
 * - date: Date in YYYY-MM-DD format
 * - execution_count: Number of executions on this day
 * - total_cost: Total credits consumed on this day
 * - failure_count: Number of failed executions on this day
 */
async function handleUsageQueryByDay(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication - org_id resolved server-side
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');

  const result = await getUsageByDay({
    organization_id: authContext.organization_id,
    from_date: parseDateParam(query.get('start_date') || query.get('from_date')),
    to_date: parseDateParam(query.get('end_date') || query.get('to_date')),
    limit: query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined,
    offset: query.get('offset') ? parseInt(query.get('offset')!, 10) : undefined,
  });

  // Return array directly for chart compatibility
  sendJson(res, 200, result.data);
}

/**
 * GET /usage/recent
 * Get recent activity for authenticated organization (for dashboards)
 *
 * SECURITY: Requires Cloud Run IAM authentication
 *
 * Query params:
 * - limit: Max records to return (default: 20, max: 100)
 */
async function handleUsageQueryRecent(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');
  const limit = query.get('limit') ? parseInt(query.get('limit')!, 10) : 20;

  const activity = await getRecentActivity(authContext.organization_id, limit);

  sendJson(res, 200, {
    data: activity,
    organization_id: authContext.organization_id,
    principal: authContext.principal.email,
  });
}

/**
 * GET /usage/top-commands
 * Get top commands for authenticated organization (for dashboards)
 *
 * SECURITY: Requires Cloud Run IAM authentication
 *
 * Query params:
 * - limit: Max commands to return (default: 10, max: 50)
 * - from_date: Start date (ISO format, default: 30 days ago)
 */
async function handleUsageQueryTopCommands(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');
  const limit = query.get('limit') ? parseInt(query.get('limit')!, 10) : 10;
  const fromDate = parseDateParam(query.get('from_date'));

  const commands = await getTopCommands(
    authContext.organization_id,
    limit,
    fromDate
  );

  sendJson(res, 200, {
    data: commands,
    organization_id: authContext.organization_id,
    principal: authContext.principal.email,
  });
}

/**
 * GET /usage/top-users
 * Get top users for authenticated organization (for dashboards)
 *
 * SECURITY: Requires Cloud Run IAM authentication
 *
 * Query params:
 * - limit: Max users to return (default: 10, max: 50)
 * - from_date: Start date (ISO format, default: 30 days ago)
 */
async function handleUsageQueryTopUsers(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Require authentication
  const authContext = await requireAuth(req, res);
  if (!authContext) return;

  const query = parseQueryParams(req.url || '');
  const limit = query.get('limit') ? parseInt(query.get('limit')!, 10) : 10;
  const fromDate = parseDateParam(query.get('from_date'));

  const users = await getTopUsers(
    authContext.organization_id,
    limit,
    fromDate
  );

  sendJson(res, 200, {
    data: users,
    organization_id: authContext.organization_id,
    principal: authContext.principal.email,
  });
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Main request router
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method?.toUpperCase() || 'GET';
  const url = req.url || '/';
  const path = url.split('?')[0] ?? '/';

  try {
    // Health check
    if (method === 'GET' && ROUTES.health.test(path)) {
      await handleHealth(req, res);
      return;
    }

    // Simple Usage API (for CLI compatibility)
    if (method === 'GET' && ROUTES.usageBalance.test(path)) {
      await handleUsageBalance(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usage.test(path)) {
      await handleUsageSummary(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageHistory.test(path)) {
      await handleUsageHistorySimple(req, res);
      return;
    }

    if (method === 'POST' && ROUTES.usageRecord.test(path)) {
      await handleUsageRecord(req, res);
      return;
    }

    // CLI-compatible Entitlement API
    if (method === 'POST' && ROUTES.canExecuteCommand.test(path)) {
      await handleCanExecuteCommand(req, res);
      return;
    }

    if (method === 'POST' && ROUTES.recordExecution.test(path)) {
      await handleRecordExecution(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.entitledCommandsList.test(path)) {
      await handleListEntitledCommands(req, res);
      return;
    }

    // Usage Query Endpoints (UI Backend - IAM-secured)
    if (method === 'GET' && ROUTES.usageQuerySummary.test(path)) {
      await handleUsageQuerySummary(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryByCommand.test(path)) {
      await handleUsageQueryByCommand(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryByUser.test(path)) {
      await handleUsageQueryByUser(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryByDay.test(path)) {
      await handleUsageQueryByDay(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryRecent.test(path)) {
      await handleUsageQueryRecent(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryTopCommands.test(path)) {
      await handleUsageQueryTopCommands(req, res);
      return;
    }

    if (method === 'GET' && ROUTES.usageQueryTopUsers.test(path)) {
      await handleUsageQueryTopUsers(req, res);
      return;
    }

    // Balance
    if (method === 'GET') {
      const params = parsePathParams(path, ROUTES.balance);
      if (params) {
        await handleGetBalance(req, res, params);
        return;
      }
    }

    // Pre-flight check
    if (method === 'POST') {
      const params = parsePathParams(path, ROUTES.canExecute);
      if (params) {
        await handleCanExecute(req, res, params);
        return;
      }
    }

    // Entries
    if (method === 'GET') {
      let params = parsePathParams(path, ROUTES.entry);
      if (params) {
        await handleGetEntry(req, res, params);
        return;
      }

      params = parsePathParams(path, ROUTES.entries);
      if (params) {
        await handleListEntries(req, res, params);
        return;
      }
    }

    // Grants
    if (method === 'POST') {
      const params = parsePathParams(path, ROUTES.grants);
      if (params) {
        await handleGrant(req, res, params);
        return;
      }
    }

    // Debits
    if (method === 'POST') {
      const params = parsePathParams(path, ROUTES.debits);
      if (params) {
        await handleDebit(req, res, params);
        return;
      }
    }

    // Reservations
    if (method === 'POST') {
      let params = parsePathParams(path, ROUTES.consumeReservation);
      if (params) {
        await handleConsumeReservation(req, res, params);
        return;
      }

      params = parsePathParams(path, ROUTES.cancelReservation);
      if (params) {
        await handleCancelReservation(req, res, params);
        return;
      }

      params = parsePathParams(path, ROUTES.reservations);
      if (params) {
        await handleCreateReservation(req, res, params);
        return;
      }
    }

    if (method === 'GET') {
      const params = parsePathParams(path, ROUTES.reservation);
      if (params) {
        await handleGetReservation(req, res, params);
        return;
      }
    }

    // Reversals
    if (method === 'POST') {
      const params = parsePathParams(path, ROUTES.reversals);
      if (params) {
        await handleReversal(req, res, params);
        return;
      }
    }

    // Entitlements (Organization-scoped)
    if (method === 'GET') {
      // Check specific command first (more specific route)
      let params = parsePathParams(path, ROUTES.entitlementCommand);
      if (params) {
        await handleCheckCommand(req, res, params);
        return;
      }

      // Check commands list
      params = parsePathParams(path, ROUTES.entitlementCommands);
      if (params) {
        await handleGetEntitledCommands(req, res, params);
        return;
      }

      // Check all entitlements for org
      params = parsePathParams(path, ROUTES.entitlements);
      if (params) {
        await handleGetEntitlements(req, res, params);
        return;
      }
    }

    if (method === 'POST') {
      const params = parsePathParams(path, ROUTES.entitlements);
      if (params) {
        await handleInitEntitlements(req, res, params);
        return;
      }
    }

    // Not found
    sendJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        details: {},
      },
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      sendError(res, error);
    } else {
      // Log internal errors but don't leak details
      console.error('Internal error:', error);
      sendError(res, internalError());
    }
  }
}
