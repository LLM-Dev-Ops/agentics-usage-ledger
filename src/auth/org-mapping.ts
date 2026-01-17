/**
 * Principal to Organization Mapping
 *
 * This module maps GCP principals (service accounts, users) to organizations.
 *
 * SECURITY REQUIREMENTS:
 * - Mapping is server-side only
 * - Mapping is authoritative (client cannot override)
 * - Unknown principals are rejected (fail closed)
 *
 * Mapping sources (in priority order):
 * 1. Database table (principal_org_mappings)
 * 2. Domain-based inference (e.g., *@example.com → example-org)
 * 3. Environment variable overrides (for service accounts)
 */

import type { PoolClient } from 'pg';
import type { CloudRunPrincipal } from './cloudrun.js';
import { getPool } from '../db/index.js';

/**
 * Principal to org mapping record
 */
export interface PrincipalOrgMapping {
  mapping_id: string;
  principal_email: string;
  organization_id: string;
  principal_type: 'service_account' | 'user' | 'group' | 'domain';
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  metadata: Record<string, unknown>;
}

/**
 * Result of org resolution
 */
export interface OrgResolutionResult {
  resolved: boolean;
  organization_id?: string;
  mapping_source?: 'database' | 'domain' | 'environment' | 'default';
  error?: string;
}

// In-memory cache for mappings (refreshed periodically)
let mappingCache: Map<string, PrincipalOrgMapping> = new Map();
let domainMappingCache: Map<string, string> = new Map();
let cacheLastRefresh = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Initialize the principal-org mapping tables
 */
export async function initOrgMappingTables(): Promise<void> {
  const pool = getPool();

  // Create principal_org_mappings table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS principal_org_mappings (
      mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_email VARCHAR(255) NOT NULL,
      organization_id VARCHAR(255) NOT NULL,
      principal_type VARCHAR(20) NOT NULL DEFAULT 'service_account'
        CHECK (principal_type IN ('service_account', 'user', 'group', 'domain')),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by VARCHAR(255) NOT NULL DEFAULT 'system',
      metadata JSONB DEFAULT '{}',

      CONSTRAINT unique_principal_email UNIQUE (principal_email)
    )
  `);

  // Create index for lookups
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_principal_mappings_email
    ON principal_org_mappings (principal_email)
    WHERE is_active = true
  `);

  // Create domain_org_mappings table for domain-based inference
  await pool.query(`
    CREATE TABLE IF NOT EXISTS domain_org_mappings (
      mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email_domain VARCHAR(255) NOT NULL,
      organization_id VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by VARCHAR(255) NOT NULL DEFAULT 'system',

      CONSTRAINT unique_email_domain UNIQUE (email_domain)
    )
  `);

  console.log('Principal-org mapping tables initialized');
}

/**
 * Refresh the mapping cache from database
 */
async function refreshCache(): Promise<void> {
  const now = Date.now();
  if (now - cacheLastRefresh < CACHE_TTL_MS) {
    return; // Cache still fresh
  }

  try {
    const pool = getPool();

    // Load principal mappings
    const principalResult = await pool.query<PrincipalOrgMapping>(
      `SELECT mapping_id, principal_email, organization_id, principal_type,
              is_active, created_at, updated_at, created_by, metadata
       FROM principal_org_mappings
       WHERE is_active = true`
    );

    const newMappingCache = new Map<string, PrincipalOrgMapping>();
    for (const row of principalResult.rows) {
      newMappingCache.set(row.principal_email.toLowerCase(), row);
    }
    mappingCache = newMappingCache;

    // Load domain mappings
    const domainResult = await pool.query<{ email_domain: string; organization_id: string }>(
      `SELECT email_domain, organization_id
       FROM domain_org_mappings
       WHERE is_active = true
       ORDER BY priority DESC`
    );

    const newDomainCache = new Map<string, string>();
    for (const row of domainResult.rows) {
      newDomainCache.set(row.email_domain.toLowerCase(), row.organization_id);
    }
    domainMappingCache = newDomainCache;

    cacheLastRefresh = now;
  } catch (error) {
    console.error('Failed to refresh org mapping cache:', error);
    // Keep using stale cache if refresh fails
  }
}

/**
 * Parse environment variable mappings
 * Format: "email1:org1,email2:org2"
 */
function getEnvMappings(): Map<string, string> {
  const envMappings = new Map<string, string>();
  const envValue = process.env['PRINCIPAL_ORG_MAPPINGS'];

  if (envValue) {
    const pairs = envValue.split(',');
    for (const pair of pairs) {
      const [email, orgId] = pair.split(':').map(s => s.trim());
      if (email && orgId) {
        envMappings.set(email.toLowerCase(), orgId);
      }
    }
  }

  return envMappings;
}

/**
 * Extract domain from email address
 */
function extractDomain(email: string): string | null {
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    return null;
  }
  return email.slice(atIndex + 1).toLowerCase();
}

/**
 * Check if email is a GCP service account
 */
function isServiceAccount(email: string): boolean {
  return email.endsWith('.iam.gserviceaccount.com') ||
         email.includes('@') && email.includes('.iam.gserviceaccount.com');
}

/**
 * Resolve organization ID for a principal
 *
 * Resolution order:
 * 1. Environment variable override
 * 2. Database principal mapping (exact match)
 * 3. Database domain mapping
 * 4. Reject (fail closed)
 */
export async function resolveOrganization(
  principal: CloudRunPrincipal
): Promise<OrgResolutionResult> {
  const email = principal.email.toLowerCase();

  if (!email) {
    return {
      resolved: false,
      error: 'Principal has no email address',
    };
  }

  // 1. Check environment variable overrides (highest priority)
  const envMappings = getEnvMappings();
  const envOrgId = envMappings.get(email);
  if (envOrgId) {
    return {
      resolved: true,
      organization_id: envOrgId,
      mapping_source: 'environment',
    };
  }

  // 2. Refresh and check database cache
  await refreshCache();

  // 2a. Check exact principal mapping
  const principalMapping = mappingCache.get(email);
  if (principalMapping) {
    return {
      resolved: true,
      organization_id: principalMapping.organization_id,
      mapping_source: 'database',
    };
  }

  // 2b. Check domain mapping
  const domain = extractDomain(email);
  if (domain) {
    const domainOrgId = domainMappingCache.get(domain);
    if (domainOrgId) {
      return {
        resolved: true,
        organization_id: domainOrgId,
        mapping_source: 'domain',
      };
    }
  }

  // 3. Check for default org (only in development)
  const defaultOrg = process.env['DEFAULT_ORG_ID'];
  if (defaultOrg && process.env['ALLOW_DEFAULT_ORG'] === 'true') {
    console.warn(`[ORG-MAPPING] Using default org for unmapped principal: ${email}`);
    return {
      resolved: true,
      organization_id: defaultOrg,
      mapping_source: 'default',
    };
  }

  // 4. Fail closed - unknown principals are rejected
  return {
    resolved: false,
    error: `Principal ${email} is not mapped to any organization. Contact administrator to add mapping.`,
  };
}

/**
 * Add a principal to org mapping
 */
export async function addPrincipalMapping(
  principalEmail: string,
  organizationId: string,
  principalType: 'service_account' | 'user' | 'group' | 'domain' = 'service_account',
  createdBy: string = 'system',
  client?: PoolClient
): Promise<PrincipalOrgMapping> {
  const db = client || getPool();
  const result = await db.query<PrincipalOrgMapping>(
    `INSERT INTO principal_org_mappings (
      principal_email, organization_id, principal_type, created_by
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (principal_email) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      principal_type = EXCLUDED.principal_type,
      is_active = true,
      updated_at = NOW()
    RETURNING mapping_id, principal_email, organization_id, principal_type,
              is_active, created_at, updated_at, created_by, metadata`,
    [principalEmail.toLowerCase(), organizationId, principalType, createdBy]
  );

  // Invalidate cache
  cacheLastRefresh = 0;

  return result.rows[0]!;
}

/**
 * Add a domain to org mapping
 */
export async function addDomainMapping(
  emailDomain: string,
  organizationId: string,
  priority: number = 0,
  createdBy: string = 'system',
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();
  await db.query(
    `INSERT INTO domain_org_mappings (
      email_domain, organization_id, priority, created_by
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (email_domain) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      priority = EXCLUDED.priority,
      is_active = true,
      updated_at = NOW()`,
    [emailDomain.toLowerCase(), organizationId, priority, createdBy]
  );

  // Invalidate cache
  cacheLastRefresh = 0;
}

/**
 * Remove a principal mapping
 */
export async function removePrincipalMapping(
  principalEmail: string,
  client?: PoolClient
): Promise<void> {
  const db = client || getPool();
  await db.query(
    `UPDATE principal_org_mappings
     SET is_active = false, updated_at = NOW()
     WHERE principal_email = $1`,
    [principalEmail.toLowerCase()]
  );

  // Invalidate cache
  cacheLastRefresh = 0;
}

/**
 * List all principal mappings for an organization
 */
export async function listPrincipalMappings(
  organizationId?: string,
  client?: PoolClient
): Promise<PrincipalOrgMapping[]> {
  const db = client || getPool();

  let query = `
    SELECT mapping_id, principal_email, organization_id, principal_type,
           is_active, created_at, updated_at, created_by, metadata
    FROM principal_org_mappings
    WHERE is_active = true
  `;
  const params: string[] = [];

  if (organizationId) {
    query += ` AND organization_id = $1`;
    params.push(organizationId);
  }

  query += ` ORDER BY created_at DESC`;

  const result = await db.query<PrincipalOrgMapping>(query, params);
  return result.rows;
}
