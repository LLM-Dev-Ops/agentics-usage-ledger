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
  });
}

// Start server
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Export for testing
export { initDb, closeDb } from './db/index.js';
export * from './ledger/index.js';
export * from './types/index.js';
export * from './errors/index.js';
