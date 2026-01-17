/**
 * Authentication Module
 *
 * Provides Cloud Run IAM authentication and principal-to-org mapping.
 *
 * Security Model:
 * - Cloud Run handles token validation
 * - This module extracts and maps principals
 * - Server-side org resolution (client cannot override)
 */

export {
  CloudRunPrincipal,
  AuthResult,
  extractPrincipal,
  authenticateRequest,
  isCloudRunEnvironment,
  shouldEnforceAuth,
  getDevPrincipal,
} from './cloudrun.js';

export {
  PrincipalOrgMapping,
  OrgResolutionResult,
  initOrgMappingTables,
  resolveOrganization,
  addPrincipalMapping,
  addDomainMapping,
  removePrincipalMapping,
  listPrincipalMappings,
} from './org-mapping.js';

import type { IncomingMessage } from 'http';
import { authenticateRequest, type CloudRunPrincipal } from './cloudrun.js';
import { resolveOrganization, type OrgResolutionResult } from './org-mapping.js';

/**
 * Authenticated request context
 * Contains the verified principal and resolved organization
 */
export interface AuthenticatedContext {
  /** The authenticated GCP principal */
  principal: CloudRunPrincipal;
  /** The resolved organization ID */
  organization_id: string;
  /** How the org was resolved */
  mapping_source: 'database' | 'domain' | 'environment' | 'default';
}

/**
 * Full authentication result
 */
export interface FullAuthResult {
  authenticated: boolean;
  context?: AuthenticatedContext;
  error?: string;
}

/**
 * Authenticate and authorize a request
 *
 * This is the main entry point for request authentication.
 * It:
 * 1. Extracts the principal from Cloud Run auth
 * 2. Resolves the org_id from the principal
 * 3. Returns the authenticated context
 *
 * @param req - Incoming HTTP request
 * @returns Full authentication result with context
 */
export async function authenticateAndAuthorize(
  req: IncomingMessage
): Promise<FullAuthResult> {
  // Step 1: Authenticate the request
  const authResult = authenticateRequest(req);

  if (!authResult.authenticated || !authResult.principal) {
    return {
      authenticated: false,
      error: authResult.error || 'Authentication failed',
    };
  }

  // Step 2: Resolve organization from principal
  const orgResult = await resolveOrganization(authResult.principal);

  if (!orgResult.resolved || !orgResult.organization_id) {
    return {
      authenticated: false,
      error: orgResult.error || 'Organization resolution failed',
    };
  }

  // Step 3: Return authenticated context
  return {
    authenticated: true,
    context: {
      principal: authResult.principal,
      organization_id: orgResult.organization_id,
      mapping_source: orgResult.mapping_source!,
    },
  };
}
