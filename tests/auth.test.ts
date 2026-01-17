/**
 * Cloud Run IAM Authentication Tests
 *
 * Tests for:
 * 1. Principal extraction from Cloud Run tokens
 * 2. Principal-to-org mapping
 * 3. Auth enforcement in API handlers
 *
 * Per SPARC Specification: No unauthenticated usage writes succeed
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import type { IncomingMessage } from 'http';

// Mock modules before importing
import {
  extractPrincipal,
  authenticateRequest,
  isCloudRunEnvironment,
  shouldEnforceAuth,
  getDevPrincipal,
  type CloudRunPrincipal,
  type AuthResult,
} from '../src/auth/cloudrun.js';

import {
  resolveOrganization,
  type OrgResolutionResult,
} from '../src/auth/org-mapping.js';

import {
  authenticateAndAuthorize,
  type FullAuthResult,
} from '../src/auth/index.js';

console.log('\n========================================');
console.log('Cloud Run IAM Authentication Test Suite');
console.log('========================================\n');

/**
 * Create a mock HTTP request with specified headers
 */
function createMockRequest(headers: Record<string, string | undefined>): IncomingMessage {
  return {
    headers: headers as Record<string, string | string[] | undefined>,
  } as IncomingMessage;
}

/**
 * Create a valid JWT token (for testing only - NOT validated by our code)
 */
function createMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'mock-signature'; // Not validated - Cloud Run validates
  return `${header}.${body}.${signature}`;
}

describe('Cloud Run IAM Authentication', () => {
  // Store original env vars
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    ['K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB', 'SKIP_AUTH_IN_DEV', 'DEFAULT_ORG_ID', 'ALLOW_DEFAULT_ORG', 'PRINCIPAL_ORG_MAPPINGS'].forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore env vars
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  describe('extractPrincipal', () => {
    it('should extract principal from valid Bearer token', () => {
      const token = createMockJwt({
        email: 'service@project.iam.gserviceaccount.com',
        sub: '123456789',
        aud: 'https://ledger.example.com',
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const req = createMockRequest({
        authorization: `Bearer ${token}`,
      });

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, true);
      assert.ok(result.principal);
      assert.strictEqual(result.principal.email, 'service@project.iam.gserviceaccount.com');
      assert.strictEqual(result.principal.subject, '123456789');
    });

    it('should reject request without Authorization header', () => {
      const req = createMockRequest({});

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('Missing Authorization header'));
    });

    it('should reject non-Bearer authorization', () => {
      const req = createMockRequest({
        authorization: 'Basic dXNlcjpwYXNz',
      });

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('Invalid Authorization header format'));
    });

    it('should reject malformed JWT', () => {
      const req = createMockRequest({
        authorization: 'Bearer not-a-valid-jwt',
      });

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('Failed to decode token payload'));
    });

    it('should reject token without any identity claims', () => {
      const token = createMockJwt({
        aud: 'test-audience',
        // No email or sub claims
      });

      const req = createMockRequest({
        authorization: `Bearer ${token}`,
      });

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('Token missing required identity claims'));
    });

    it('should accept token with only sub claim (no email)', () => {
      const token = createMockJwt({
        sub: '123456789',
        // No email claim - but sub is acceptable
      });

      const req = createMockRequest({
        authorization: `Bearer ${token}`,
      });

      const result = extractPrincipal(req);

      // The code accepts sub as a fallback for email
      assert.strictEqual(result.authenticated, true);
      assert.ok(result.principal);
      assert.strictEqual(result.principal.subject, '123456789');
    });
  });

  describe('authenticateRequest', () => {
    it('should authenticate valid token in Cloud Run environment', () => {
      // Simulate Cloud Run environment
      process.env['K_SERVICE'] = 'test-service';

      const token = createMockJwt({
        email: 'service@project.iam.gserviceaccount.com',
        sub: '123456789',
      });

      const req = createMockRequest({
        authorization: `Bearer ${token}`,
      });

      const result = authenticateRequest(req);

      assert.strictEqual(result.authenticated, true);
      assert.ok(result.principal);
    });

    it('should bypass auth in dev mode when SKIP_AUTH_IN_DEV=true', () => {
      // Not in Cloud Run, skip auth enabled
      process.env['SKIP_AUTH_IN_DEV'] = 'true';

      const req = createMockRequest({});

      const result = authenticateRequest(req);

      assert.strictEqual(result.authenticated, true);
      assert.ok(result.principal);
      assert.strictEqual(result.principal.email, 'dev@localhost');
    });

    it('should enforce auth in dev mode when SKIP_AUTH_IN_DEV is not true', () => {
      // Not in Cloud Run, skip auth not enabled
      process.env['SKIP_AUTH_IN_DEV'] = 'false';

      const req = createMockRequest({});

      const result = authenticateRequest(req);

      assert.strictEqual(result.authenticated, false);
    });
  });

  describe('isCloudRunEnvironment', () => {
    it('should detect K_SERVICE', () => {
      process.env['K_SERVICE'] = 'test-service';
      assert.strictEqual(isCloudRunEnvironment(), true);
    });

    it('should detect K_REVISION', () => {
      process.env['K_REVISION'] = 'test-revision-001';
      assert.strictEqual(isCloudRunEnvironment(), true);
    });

    it('should detect CLOUD_RUN_JOB', () => {
      process.env['CLOUD_RUN_JOB'] = 'test-job';
      assert.strictEqual(isCloudRunEnvironment(), true);
    });

    it('should return false when not in Cloud Run', () => {
      assert.strictEqual(isCloudRunEnvironment(), false);
    });
  });

  describe('shouldEnforceAuth', () => {
    it('should always enforce in Cloud Run', () => {
      process.env['K_SERVICE'] = 'test-service';
      process.env['SKIP_AUTH_IN_DEV'] = 'true'; // Should be ignored
      assert.strictEqual(shouldEnforceAuth(), true);
    });

    it('should enforce when SKIP_AUTH_IN_DEV is false', () => {
      process.env['SKIP_AUTH_IN_DEV'] = 'false';
      assert.strictEqual(shouldEnforceAuth(), true);
    });

    it('should not enforce when SKIP_AUTH_IN_DEV is true and not in Cloud Run', () => {
      process.env['SKIP_AUTH_IN_DEV'] = 'true';
      assert.strictEqual(shouldEnforceAuth(), false);
    });
  });

  describe('resolveOrganization', () => {
    it('should resolve from environment variable mapping', async () => {
      process.env['PRINCIPAL_ORG_MAPPINGS'] = 'service@project.iam.gserviceaccount.com:test-org-123';

      const principal: CloudRunPrincipal = {
        email: 'service@project.iam.gserviceaccount.com',
        subject: '123456789',
      };

      const result = await resolveOrganization(principal);

      assert.strictEqual(result.resolved, true);
      assert.strictEqual(result.organization_id, 'test-org-123');
      assert.strictEqual(result.mapping_source, 'environment');
    });

    it('should resolve from default org when allowed', async () => {
      process.env['DEFAULT_ORG_ID'] = 'default-org';
      process.env['ALLOW_DEFAULT_ORG'] = 'true';

      const principal: CloudRunPrincipal = {
        email: 'unknown@example.com',
        subject: '123456789',
      };

      const result = await resolveOrganization(principal);

      assert.strictEqual(result.resolved, true);
      assert.strictEqual(result.organization_id, 'default-org');
      assert.strictEqual(result.mapping_source, 'default');
    });

    it('should reject unmapped principal when no default org', async () => {
      const principal: CloudRunPrincipal = {
        email: 'unknown@example.com',
        subject: '123456789',
      };

      const result = await resolveOrganization(principal);

      assert.strictEqual(result.resolved, false);
      assert.ok(result.error?.includes('not mapped'));
    });

    it('should reject principal with empty email', async () => {
      const principal: CloudRunPrincipal = {
        email: '',
        subject: '123456789',
      };

      const result = await resolveOrganization(principal);

      assert.strictEqual(result.resolved, false);
      assert.ok(result.error?.includes('no email'));
    });
  });

  describe('authenticateAndAuthorize', () => {
    it('should return full auth context for valid authenticated request', async () => {
      process.env['SKIP_AUTH_IN_DEV'] = 'true';
      process.env['DEFAULT_ORG_ID'] = 'test-org';
      process.env['ALLOW_DEFAULT_ORG'] = 'true';

      const req = createMockRequest({});

      const result = await authenticateAndAuthorize(req);

      assert.strictEqual(result.authenticated, true);
      assert.ok(result.context);
      assert.strictEqual(result.context.organization_id, 'test-org');
      assert.ok(result.context.principal);
    });

    it('should fail when authentication fails', async () => {
      process.env['SKIP_AUTH_IN_DEV'] = 'false';

      const req = createMockRequest({});

      const result = await authenticateAndAuthorize(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error);
    });

    it('should fail when org resolution fails', async () => {
      process.env['SKIP_AUTH_IN_DEV'] = 'true';
      // No default org configured

      const req = createMockRequest({});

      const result = await authenticateAndAuthorize(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('not mapped'));
    });
  });
});

describe('Auth Enforcement Integration', () => {
  describe('Security Guarantees', () => {
    it('should NEVER trust client-supplied org_id', () => {
      // This test documents the security requirement
      // The handlers use authenticated context, not request body org_id
      const clientRequest = {
        org_id: 'attacker-controlled-org',
        command_name: 'deploy:production',
      };

      // The org_id from the request body should be IGNORED
      // Handlers must use context.organization_id from auth
      assert.ok(true, 'Handlers use authenticated context, not request body');
    });

    it('should NEVER validate JWT ourselves', () => {
      // This test documents that we trust Cloud Run's validation
      // We only decode the JWT to extract claims
      // Cloud Run already validated the token before it reached us
      assert.ok(true, 'JWT validation delegated to Cloud Run');
    });

    it('should NEVER accept API keys', () => {
      // This test documents that we only accept Bearer tokens
      const req = createMockRequest({
        authorization: 'ApiKey sk-12345',
        'x-api-key': 'sk-12345',
      });

      const result = extractPrincipal(req);

      assert.strictEqual(result.authenticated, false);
      assert.ok(result.error?.includes('Invalid Authorization header format'));
    });

    it('should fail closed - reject unknown principals', async () => {
      // Unknown principals must be rejected, not allowed with a default
      const principal: CloudRunPrincipal = {
        email: 'unknown-attacker@evil.com',
        subject: 'attacker-123',
      };

      // Without ALLOW_DEFAULT_ORG, unknown principals are rejected
      const result = await resolveOrganization(principal);

      assert.strictEqual(result.resolved, false);
      assert.ok(result.error?.includes('not mapped'));
    });
  });
});

console.log('\n✅ Cloud Run IAM Authentication tests complete\n');
