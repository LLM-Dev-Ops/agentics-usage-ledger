/**
 * HTTP API handlers for agentics-usage-ledger
 * Per SPARC Specification Section 3.3.1 (REST API)
 *
 * Assumes caller has already been authenticated by the platform.
 * Authorization boundaries are enforced by org_id in path.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { EntryType } from '../types/index.js';
import { LedgerError, invalidRequest, internalError } from '../errors/index.js';
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
} from '../ledger/index.js';
import {
  getBalance as getUsageBalance,
  getUsageSummary,
  getUsageHistory as getUsageHistorySimple,
  recordUsage,
} from '../db/usage.js';

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
 * Get actor from request headers
 * Assumes platform has authenticated and set X-Actor header
 */
function getActor(req: IncomingMessage): string {
  const actor = req.headers['x-actor'];
  if (typeof actor === 'string' && actor.trim()) {
    return actor.trim();
  }
  // Default to service actor if not provided (internal calls)
  return 'service:usage-ledger';
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
 * Record a usage event (internal)
 */
async function handleUsageRecord(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = parseJsonBody(await readBody(req));

  if (typeof body !== 'object' || body === null) {
    throw invalidRequest('Request body must be an object');
  }

  const data = body as Record<string, unknown>;

  // Validate required fields
  if (!data['org_id'] || typeof data['org_id'] !== 'string') {
    throw invalidRequest('org_id is required and must be a string');
  }
  if (!data['action'] || typeof data['action'] !== 'string') {
    throw invalidRequest('action is required and must be a string');
  }
  if (typeof data['credits_used'] !== 'number' || data['credits_used'] < 0) {
    throw invalidRequest('credits_used is required and must be a non-negative number');
  }

  const result = await recordUsage({
    org_id: data['org_id'] as string,
    user_id: typeof data['user_id'] === 'string' ? data['user_id'] : undefined,
    action: data['action'] as string,
    credits_used: data['credits_used'] as number,
    command: typeof data['command'] === 'string' ? data['command'] : undefined,
    correlation_id: typeof data['correlation_id'] === 'string' ? data['correlation_id'] : undefined,
    metadata: typeof data['metadata'] === 'object' && data['metadata'] !== null
      ? data['metadata'] as Record<string, unknown>
      : undefined,
  });

  sendJson(res, 201, result);
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
