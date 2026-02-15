/**
 * agentics-usage-ledger
 *
 * Authoritative accounting and enforcement service for all organization
 * credit usage across the Agentics ecosystem.
 *
 * This is a LEDGER, not analytics:
 * - Append-only
 * - Strongly consistent
 * - Audit-safe
 *
 * Per SPARC Specification.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { initDb, closeDb } from './db/index.js';
import { setupUsageSchema } from './db/setup.js';
import { initEntitlementsTables } from './db/entitlements.js';
import { initOrgMappingTables, isCloudRunEnvironment, shouldEnforceAuth } from './auth/index.js';
import { handleRequest } from './api/handlers.js';

const PORT = parseInt(process.env['PORT'] || '3000', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

/**
 * Start the HTTP server
 */
async function start(): Promise<void> {
  // Initialize database connection pool
  console.log('Initializing database connection...');
  initDb();

  // Setup usage schema (create tables if needed)
  try {
    await setupUsageSchema();
  } catch (error) {
    console.warn('Warning: Could not setup usage schema:', (error as Error).message);
    console.warn('Usage endpoints may not work until database is configured');
  }

  // Setup entitlements schema (create tables if needed)
  try {
    await initEntitlementsTables();
  } catch (error) {
    console.warn('Warning: Could not setup entitlements schema:', (error as Error).message);
    console.warn('Entitlement endpoints may not work until database is configured');
  }

  // Setup org mapping schema (create tables if needed)
  try {
    await initOrgMappingTables();
  } catch (error) {
    console.warn('Warning: Could not setup org mapping schema:', (error as Error).message);
    console.warn('Principal-to-org mapping may not work until database is configured');
  }

  // Log authentication mode
  if (isCloudRunEnvironment()) {
    console.log('Running in Cloud Run - IAM authentication ENFORCED');
  } else if (shouldEnforceAuth()) {
    console.log('Development mode - authentication ENFORCED (set SKIP_AUTH_IN_DEV=true to bypass)');
  } else {
    console.warn('WARNING: Development mode - authentication BYPASSED');
    console.warn('Set SKIP_AUTH_IN_DEV=false or unset to enforce authentication');
  }

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Set CORS headers for cross-origin requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Actor, X-Idempotency-Key');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Log request
    const start = Date.now();
    const method = req.method || 'GET';
    const url = req.url || '/';

    try {
      await handleRequest(req, res);
    } finally {
      const duration = Date.now() - start;
      console.log(`${method} ${url} ${res.statusCode} ${duration}ms`);
    }
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    server.close(async () => {
      console.log('HTTP server closed');
      await closeDb();
      console.log('Database connections closed');
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start listening
  server.listen(PORT, HOST, () => {
    console.log(`agentics-usage-ledger listening on ${HOST}:${PORT}`);
    console.log('Endpoints:');
    console.log('  GET  /health');
    console.log('  -- Simple Usage API (CLI compatible) --');
    console.log('  GET  /v1/usage/balance');
    console.log('  GET  /v1/usage');
    console.log('  GET  /v1/usage/history');
    console.log('  POST /v1/usage/record');
    console.log('  -- Entitlement API (CLI compatible) --');
    console.log('  GET  /v1/entitlements/commands');
    console.log('  POST /v1/entitlements/can-execute');
    console.log('  POST /v1/entitlements/record');
    console.log('  -- Full Ledger API --');
    console.log('  GET  /v1/organizations/{org_id}/balance');
    console.log('  POST /v1/organizations/{org_id}/can-execute');
    console.log('  GET  /v1/organizations/{org_id}/entries');
    console.log('  GET  /v1/organizations/{org_id}/entries/{entry_id}');
    console.log('  POST /v1/organizations/{org_id}/grants');
    console.log('  POST /v1/organizations/{org_id}/debits');
    console.log('  POST /v1/organizations/{org_id}/reservations');
    console.log('  GET  /v1/organizations/{org_id}/reservations/{reservation_id}');
    console.log('  POST /v1/organizations/{org_id}/reservations/{reservation_id}/consume');
    console.log('  POST /v1/organizations/{org_id}/reservations/{reservation_id}/cancel');
    console.log('  POST /v1/organizations/{org_id}/reversals');
    console.log('  -- Entitlement API (per-org) --');
    console.log('  GET  /v1/organizations/{org_id}/entitlements');
    console.log('  POST /v1/organizations/{org_id}/entitlements');
    console.log('  GET  /v1/organizations/{org_id}/entitlements/commands');
    console.log('  GET  /v1/organizations/{org_id}/entitlements/commands/{command_name}');
    console.log('  -- Lifecycle Event API (event binding) --');
    console.log('  POST /v1/lifecycle/execution-completed');
    console.log('  POST /v1/lifecycle/deployment-completed');
    console.log('  -- Usage Query API (UI Backend - IAM secured) --');
    console.log('  GET  /usage/summary');
    console.log('  GET  /usage/by-command');
    console.log('  GET  /usage/by-user');
    console.log('  GET  /usage/by-day');
    console.log('  GET  /usage/recent');
    console.log('  GET  /usage/top-commands');
    console.log('  GET  /usage/top-users');
  });
}

// Start server
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Export for testing
export { initDb, closeDb } from './db/index.js';
export { initEntitlementsTables, ENTITLED_COMMANDS } from './db/entitlements.js';
export * from './ledger/index.js';
export * from './types/index.js';
export * from './errors/index.js';
export * from './auth/index.js';
export * from './lifecycle/index.js';
