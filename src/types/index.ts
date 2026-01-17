/**
 * Core type definitions for agentics-usage-ledger
 * Per SPARC Specification Section 1.3
 */

/** Entry types as defined in SPARC Section 1.3.2 */
export type EntryType = 'grant' | 'debit' | 'adjustment' | 'reversal';

/** Reservation status values */
export type ReservationStatus = 'active' | 'consumed' | 'expired' | 'cancelled';

/** Organization status values */
export type OrganizationStatus = 'active' | 'suspended' | 'closed';

/**
 * Ledger Entry - immutable record in the append-only ledger
 * SPARC Section 1.3.1
 */
export interface LedgerEntry {
  entry_id: string;
  organization_id: string;
  user_id: string | null;
  entry_type: EntryType;
  amount: string; // Decimal as string for precision
  balance_after: string;
  idempotency_key: string;
  correlation_id: string | null;
  service: string | null;
  run_id: string | null;
  created_at: Date;
  created_by: string;
  metadata: Record<string, unknown>;
  checksum: string;
}

/**
 * Reservation - temporary hold on credits
 * SPARC Section 1.3.1
 */
export interface Reservation {
  reservation_id: string;
  organization_id: string;
  user_id: string | null;
  amount: string;
  expires_at: Date;
  status: ReservationStatus;
  created_at: Date;
  consumed_at: Date | null;
  cancelled_at: Date | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  created_by: string;
}

/**
 * Organization reference (read-only from shared data plane)
 */
export interface Organization {
  organization_id: string;
  name: string;
  status: OrganizationStatus;
  created_at: Date;
}

/**
 * Balance response combining current and available balance
 */
export interface BalanceInfo {
  organization_id: string;
  current_balance: string;
  reserved_amount: string;
  available_balance: string;
  as_of: Date;
}

/**
 * Pre-flight check request
 */
export interface PreFlightRequest {
  organization_id: string;
  user_id?: string;
  required_credits: string;
  service?: string;
  run_id?: string;
  idempotency_key?: string;
}

/**
 * Pre-flight check response
 */
export interface PreFlightResponse {
  allowed: boolean;
  organization_id: string;
  available_balance: string;
  required_credits: string;
  shortfall?: string;
}

/**
 * Grant request
 */
export interface GrantRequest {
  organization_id: string;
  amount: string;
  reason: string;
  idempotency_key: string;
  actor: string;
  correlation_id?: string;
}

/**
 * Debit request (direct debit without reservation)
 */
export interface DebitRequest {
  organization_id: string;
  user_id?: string;
  amount: string;
  service: string;
  run_id: string;
  idempotency_key: string;
  actor: string;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reserve request
 */
export interface ReserveRequest {
  organization_id: string;
  user_id?: string;
  amount: string;
  ttl_seconds: number;
  correlation_id?: string;
  idempotency_key: string;
  actor: string;
}

/**
 * Consume reservation request
 */
export interface ConsumeRequest {
  reservation_id: string;
  actual_amount: string;
  idempotency_key: string;
  actor: string;
  service?: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Usage history query parameters
 */
export interface UsageHistoryParams {
  organization_id: string;
  user_id?: string;
  service?: string;
  entry_type?: EntryType;
  limit?: number;
  offset?: number;
  from_date?: Date;
  to_date?: Date;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

// ============================================================================
// Entitlements Types
// ============================================================================

/**
 * Entitlement status for command access
 */
export type EntitlementStatus = 'enabled' | 'disabled' | 'suspended';

/**
 * Command entitlement record - maps org to allowed commands
 */
export interface CommandEntitlement {
  entitlement_id: string;
  organization_id: string;
  command_name: string;
  status: EntitlementStatus;
  credits_per_use: number;
  daily_limit: number | null;
  monthly_limit: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Request to check if a command is allowed
 */
export interface CommandCheckRequest {
  organization_id: string;
  command_name: string;
  user_id?: string;
}

/**
 * Response for command entitlement check
 */
export interface CommandCheckResponse {
  allowed: boolean;
  organization_id: string;
  command_name: string;
  credits_per_use: number;
  reason?: string;
  daily_usage?: number;
  daily_limit?: number | null;
  monthly_usage?: number;
  monthly_limit?: number | null;
}

/**
 * Usage record request for command execution
 */
export interface CommandUsageRequest {
  organization_id: string;
  user_id?: string;
  command_name: string;
  success: boolean;
  credits_used?: number;
  execution_time_ms?: number;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Usage record response
 */
export interface CommandUsageRecord {
  usage_id: string;
  organization_id: string;
  user_id: string | null;
  command_name: string;
  credits_used: number;
  success: boolean;
  execution_time_ms: number | null;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Command usage statistics
 */
export interface CommandUsageStats {
  organization_id: string;
  command_name: string;
  daily_count: number;
  monthly_count: number;
  total_credits_used: number;
}
