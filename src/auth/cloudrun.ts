/**
 * Cloud Run IAM Authentication
 *
 * This module handles identity extraction from Cloud Run authenticated requests.
 *
 * NON-NEGOTIABLE CONSTRAINTS:
 * - NO JWT validation (Cloud Run handles this)
 * - NO API keys
 * - NO trusting client-supplied identity fields
 * - ONLY trust Cloud Run IAM authentication
 *
 * How it works:
 * 1. Cloud Run validates the OIDC token (signature, expiration, audience)
 * 2. Cloud Run rejects unauthenticated requests (if configured)
 * 3. This module decodes (NOT validates) the token to extract principal
 * 4. Principal is mapped to org_id server-side
 *
 * Required Cloud Run configuration:
 * - Authentication: "Require authentication"
 * - IAM: Grant roles/run.invoker to authorized callers
 */

import type { IncomingMessage } from 'http';

/**
 * Authenticated principal from Cloud Run
 */
export interface CloudRunPrincipal {
  /** Email of the authenticated service account or user */
  email: string;
  /** Subject (unique identifier) from the token */
  subject: string;
  /** Audience the token was issued for */
  audience?: string;
  /** Token issuer */
  issuer?: string;
  /** Token expiration (already validated by Cloud Run) */
  expiration?: number;
  /** Raw claims for debugging (never trust for auth decisions) */
  rawClaims?: Record<string, unknown>;
}

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  authenticated: boolean;
  principal?: CloudRunPrincipal;
  error?: string;
}

/**
 * Decode a JWT without validation
 * Cloud Run has already validated signature, expiration, and audience
 * We just need to read the claims
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    // Decode the payload (middle part)
    const payload = parts[1];
    if (!payload) {
      return null;
    }

    // Base64url decode
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');

    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract authenticated principal from Cloud Run request
 *
 * Cloud Run injects the validated OIDC token in the Authorization header.
 * Since Cloud Run has already validated the token, we only decode it.
 *
 * @param req - Incoming HTTP request
 * @returns AuthResult with principal if authenticated
 */
export function extractPrincipal(req: IncomingMessage): AuthResult {
  // Get Authorization header
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return {
      authenticated: false,
      error: 'Missing Authorization header. Cloud Run IAM authentication required.',
    };
  }

  // Must be Bearer token
  if (!authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      error: 'Invalid Authorization header format. Expected Bearer token.',
    };
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  if (!token) {
    return {
      authenticated: false,
      error: 'Empty Bearer token.',
    };
  }

  // Decode the JWT (Cloud Run has already validated it)
  const claims = decodeJwtPayload(token);

  if (!claims) {
    return {
      authenticated: false,
      error: 'Failed to decode token payload.',
    };
  }

  // Extract required claims
  const email = claims['email'] as string | undefined;
  const subject = claims['sub'] as string | undefined;

  if (!email && !subject) {
    return {
      authenticated: false,
      error: 'Token missing required identity claims (email or sub).',
    };
  }

  // Build principal
  const principal: CloudRunPrincipal = {
    email: email || subject || '',
    subject: subject || email || '',
    audience: claims['aud'] as string | undefined,
    issuer: claims['iss'] as string | undefined,
    expiration: claims['exp'] as number | undefined,
    rawClaims: claims,
  };

  return {
    authenticated: true,
    principal,
  };
}

/**
 * Check if running in Cloud Run environment
 */
export function isCloudRunEnvironment(): boolean {
  // Cloud Run sets these environment variables
  return !!(
    process.env['K_SERVICE'] ||
    process.env['K_REVISION'] ||
    process.env['K_CONFIGURATION'] ||
    process.env['CLOUD_RUN_JOB']
  );
}

/**
 * Check if authentication should be enforced
 *
 * In production (Cloud Run), always enforce authentication.
 * In development, can be disabled via environment variable.
 */
export function shouldEnforceAuth(): boolean {
  // Always enforce in Cloud Run
  if (isCloudRunEnvironment()) {
    return true;
  }

  // In development, check environment variable
  // Default to enforcing auth even in development
  const skipAuth = process.env['SKIP_AUTH_IN_DEV'];
  return skipAuth !== 'true';
}

/**
 * Get a development principal for local testing
 * Only available when SKIP_AUTH_IN_DEV=true
 */
export function getDevPrincipal(): CloudRunPrincipal | null {
  if (shouldEnforceAuth()) {
    return null;
  }

  const devEmail = process.env['DEV_PRINCIPAL_EMAIL'] || 'dev@localhost';
  const devOrgId = process.env['DEV_ORG_ID'] || 'dev-org';

  return {
    email: devEmail,
    subject: `dev:${devEmail}`,
    audience: 'development',
    issuer: 'development',
  };
}

/**
 * Authenticate a request
 *
 * In Cloud Run: extracts principal from OIDC token
 * In development (with SKIP_AUTH_IN_DEV=true): uses dev principal
 */
export function authenticateRequest(req: IncomingMessage): AuthResult {
  // Check for dev mode bypass
  if (!shouldEnforceAuth()) {
    const devPrincipal = getDevPrincipal();
    if (devPrincipal) {
      console.warn('[AUTH] Using development principal - NOT FOR PRODUCTION');
      return {
        authenticated: true,
        principal: devPrincipal,
      };
    }
  }

  // Extract principal from Cloud Run auth
  return extractPrincipal(req);
}
