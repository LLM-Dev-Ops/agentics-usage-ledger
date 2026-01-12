# Database Schema Documentation

This directory contains documentation of the database schema that the `agentics-usage-ledger` service expects to exist in the Ruvector Postgres data plane.

**IMPORTANT**: This service does NOT own schema migrations. The schema is owned and managed by the shared Ruvector data plane. These files are for documentation purposes only.

## Expected Tables

### `organizations`

Reference table (read-only from ledger's perspective).

```sql
CREATE TABLE organizations (
    organization_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `ledger_entries`

Append-only ledger of all credit transactions.

```sql
CREATE TABLE ledger_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(organization_id),
    user_id UUID,
    entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('grant', 'debit', 'adjustment', 'reversal')),
    amount DECIMAL(20, 6) NOT NULL,
    balance_after DECIMAL(20, 6) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    correlation_id UUID,
    service VARCHAR(128),
    run_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}',
    checksum VARCHAR(64) NOT NULL,

    CONSTRAINT unique_idempotency_per_org UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX idx_ledger_org_created ON ledger_entries (organization_id, created_at DESC);
CREATE INDEX idx_ledger_correlation ON ledger_entries (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_ledger_service ON ledger_entries (organization_id, service) WHERE service IS NOT NULL;
CREATE INDEX idx_ledger_run ON ledger_entries (run_id) WHERE run_id IS NOT NULL;
```

### `reservations`

Temporary holds on credits before consumption.

```sql
CREATE TABLE reservations (
    reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(organization_id),
    user_id UUID,
    amount DECIMAL(20, 6) NOT NULL CHECK (amount > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'consumed', 'expired', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    correlation_id UUID,
    idempotency_key VARCHAR(255),
    created_by VARCHAR(255) NOT NULL,

    CONSTRAINT unique_reservation_idempotency UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX idx_reservations_org_status ON reservations (organization_id, status) WHERE status = 'active';
CREATE INDEX idx_reservations_expiry ON reservations (expires_at) WHERE status = 'active';
```

## Operations

### Permitted Operations

This service is permitted to perform:

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `organizations` | ✓ | ✗ | ✗ | ✗ |
| `ledger_entries` | ✓ | ✓ | ✗ | ✗ |
| `reservations` | ✓ | ✓ | ✓ (status only) | ✗ |

### Append-Only Constraint

The `ledger_entries` table is strictly append-only:
- INSERT is permitted
- UPDATE is FORBIDDEN
- DELETE is FORBIDDEN

Corrections are made by adding `reversal` or `adjustment` entries, never by modifying existing entries.

### Reservation Status Updates

The only UPDATE permitted on `reservations` is to change status:
- `active` → `consumed` (when reservation is used)
- `active` → `cancelled` (when reservation is cancelled)
- `active` → `expired` (when reservation expires)

## Consistency Requirements

Per SPARC Specification Section 4.1:

- Writes use `SERIALIZABLE` isolation level
- Idempotency keys prevent duplicate writes
- Balance is computed from `SUM(amount)` on `ledger_entries`
- `balance_after` is denormalized for read performance
