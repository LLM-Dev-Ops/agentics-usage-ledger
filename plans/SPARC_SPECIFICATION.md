# SPARC Specification: agentics-usage-ledger

**Version:** 1.0.0
**Status:** Draft
**Last Updated:** 2026-01-12
**Authors:** Architecture Team

---

## Executive Summary

The `agentics-usage-ledger` is the authoritative accounting and enforcement service for all user and organization credit usage across the Agentics ecosystem. It is a **ledger**, not analytics—append-only, strongly consistent, and audit-safe. This service writes usage entries to the shared Ruvector Postgres data plane, exposes balance and usage APIs, and acts as a pre-flight enforcement gate before execution.

---

## Table of Contents

1. [Specification](#1-specification)
2. [Pseudocode](#2-pseudocode)
3. [Architecture](#3-architecture)
4. [Refinement](#4-refinement)
5. [Completion](#5-completion)

---

## 1. Specification

### 1.1 Problem Statement

The Agentics platform is a multi-tenant system with per-organization, credit-based usage. Currently, there is no single authoritative ledger responsible for:
- Tracking credit grants
- Deducting usage
- Enforcing limits
- Answering whether a request is allowed to proceed

This absence leads to **fragmented and untrustworthy enforcement** across CLI, UI, and execution services.

### 1.2 Purpose

The `agentics-usage-ledger` exists to be the **single source of truth** for credit accounting and enforcement. It is:

| Property | Description |
|----------|-------------|
| **Authoritative** | The only system that can definitively answer credit balance questions |
| **Auditable** | Every transaction is immutable and traceable |
| **Enforceable** | Pre-flight checks block unauthorized usage |
| **Consistent** | Strong consistency guarantees across all clients |

### 1.3 Ledger Semantics

#### 1.3.1 Core Entities

```
Organization
├── organization_id: UUID (primary key)
├── name: String
├── created_at: Timestamp
└── status: Enum(active, suspended, closed)

LedgerEntry
├── entry_id: UUID (primary key)
├── organization_id: UUID (foreign key)
├── entry_type: Enum(grant, debit, adjustment, reversal)
├── amount: Decimal (positive for grants, negative for debits)
├── balance_after: Decimal (computed, denormalized for read performance)
├── idempotency_key: String (unique per organization)
├── correlation_id: UUID (links related entries)
├── created_at: Timestamp
├── created_by: String (actor identifier)
├── metadata: JSONB
└── checksum: String (SHA-256 of entry data)

Reservation
├── reservation_id: UUID (primary key)
├── organization_id: UUID (foreign key)
├── amount: Decimal (reserved credits)
├── expires_at: Timestamp
├── status: Enum(active, consumed, expired, cancelled)
├── created_at: Timestamp
└── correlation_id: UUID
```

#### 1.3.2 Entry Types

| Type | Description | Amount Sign | Use Case |
|------|-------------|-------------|----------|
| `grant` | Credits added to account | Positive | Purchase, promotional credit, refund |
| `debit` | Credits consumed | Negative | Usage, execution costs |
| `adjustment` | Administrative correction | +/- | Error correction, migration |
| `reversal` | Undo previous entry | Opposite of original | Failed execution refund |

#### 1.3.3 Balance Computation Rules

1. **Current Balance** = SUM(all entry amounts for organization)
2. **Available Balance** = Current Balance - SUM(active reservations)
3. **Balance is computed at write time** and stored as `balance_after` for query efficiency
4. **Balance cannot go negative** except via explicit administrative override with audit trail

### 1.4 Credit Grant Flow

#### 1.4.1 Grant Preconditions
- Organization must exist and be in `active` status
- Grant amount must be positive
- Idempotency key must not already exist for this organization
- Actor must have `credit:grant` permission

#### 1.4.2 Grant Postconditions
- New `grant` entry created with `balance_after` computed
- Entry is immutable once written
- Audit trail includes actor, timestamp, and correlation

### 1.5 Credit Debit Flow

#### 1.5.1 Debit Preconditions
- Organization must exist and be in `active` status
- Debit amount must be positive (stored as negative in ledger)
- Available balance must be >= debit amount (unless override flag)
- Valid reservation must exist OR direct debit permitted
- Idempotency key must not already exist

#### 1.5.2 Debit Postconditions
- New `debit` entry created
- If reservation existed, it is marked `consumed`
- `balance_after` reflects new balance

### 1.6 Credit Adjustment Flow

#### 1.6.1 Adjustment Preconditions
- Actor must have `credit:adjust` permission (elevated privilege)
- Reason must be provided in metadata
- Correlation to original entry if correcting an error
- Dual-approval audit record for adjustments > threshold

#### 1.6.2 Adjustment Postconditions
- New `adjustment` entry with audit metadata
- Links to original entry via `correlation_id` if applicable

### 1.7 Enforcement Guarantees

| Guarantee | Description |
|-----------|-------------|
| **Pre-flight blocking** | Execution cannot proceed without affirmative response from ledger |
| **Atomic reservation** | Credits reserved atomically before execution |
| **Timeout-based expiry** | Reservations expire if not consumed within TTL |
| **No overdraft** | Balance cannot go negative without explicit override |
| **Idempotent operations** | Duplicate requests with same idempotency key return original result |

### 1.8 Consistency Model

- **Write Path**: Strongly consistent (serializable transactions in Postgres)
- **Read Path**: Read-your-writes consistency for same client
- **Cross-region**: Single primary region for writes; reads may be from replicas with bounded staleness

### 1.9 Audit Requirements

Every ledger entry must capture:
- WHO: Actor identifier (user ID, service account, API key hash)
- WHAT: Entry type, amount, balance change
- WHEN: Server-side timestamp (not client-provided)
- WHY: Correlation ID linking to business event
- INTEGRITY: Checksum preventing tampering

---

## 2. Pseudocode

### 2.1 Pre-flight Check (Can Execute?)

```
FUNCTION can_execute(organization_id, required_credits, idempotency_key):
    // Step 1: Validate organization
    org = get_organization(organization_id)
    IF org IS NULL:
        RETURN Error("ORGANIZATION_NOT_FOUND")
    IF org.status != "active":
        RETURN Error("ORGANIZATION_SUSPENDED")

    // Step 2: Check idempotency
    existing = get_entry_by_idempotency_key(organization_id, idempotency_key)
    IF existing IS NOT NULL:
        RETURN Success(existing.result)  // Return cached result

    // Step 3: Calculate available balance
    current_balance = get_current_balance(organization_id)
    reserved_amount = get_active_reservations_sum(organization_id)
    available_balance = current_balance - reserved_amount

    // Step 4: Evaluate
    IF available_balance >= required_credits:
        RETURN Success({
            allowed: true,
            available_balance: available_balance,
            required_credits: required_credits
        })
    ELSE:
        RETURN Success({
            allowed: false,
            available_balance: available_balance,
            required_credits: required_credits,
            shortfall: required_credits - available_balance
        })
```

### 2.2 Create Reservation (Reserve Credits)

```
FUNCTION reserve_credits(organization_id, amount, ttl_seconds, correlation_id, idempotency_key, actor):
    BEGIN TRANSACTION WITH SERIALIZABLE ISOLATION:
        // Step 1: Idempotency check
        existing = get_reservation_by_idempotency_key(organization_id, idempotency_key)
        IF existing IS NOT NULL:
            COMMIT
            RETURN Success(existing)

        // Step 2: Validate organization
        org = get_organization_for_update(organization_id)  // Row lock
        IF org IS NULL OR org.status != "active":
            ROLLBACK
            RETURN Error("ORGANIZATION_INVALID")

        // Step 3: Calculate available balance
        current_balance = get_current_balance(organization_id)
        reserved_amount = get_active_reservations_sum(organization_id)
        available_balance = current_balance - reserved_amount

        // Step 4: Check sufficiency
        IF available_balance < amount:
            ROLLBACK
            RETURN Error("INSUFFICIENT_CREDITS", {
                available: available_balance,
                requested: amount
            })

        // Step 5: Create reservation
        reservation = INSERT INTO reservations (
            reservation_id: generate_uuid(),
            organization_id: organization_id,
            amount: amount,
            expires_at: NOW() + ttl_seconds,
            status: "active",
            created_at: NOW(),
            correlation_id: correlation_id,
            idempotency_key: idempotency_key,
            created_by: actor
        )

        COMMIT
        RETURN Success(reservation)
```

### 2.3 Consume Reservation (Debit Credits)

```
FUNCTION consume_reservation(reservation_id, actual_amount, idempotency_key, actor):
    BEGIN TRANSACTION WITH SERIALIZABLE ISOLATION:
        // Step 1: Idempotency check for debit
        existing_debit = get_entry_by_idempotency_key(reservation.organization_id, idempotency_key)
        IF existing_debit IS NOT NULL:
            COMMIT
            RETURN Success(existing_debit)

        // Step 2: Lock and validate reservation
        reservation = get_reservation_for_update(reservation_id)
        IF reservation IS NULL:
            ROLLBACK
            RETURN Error("RESERVATION_NOT_FOUND")
        IF reservation.status != "active":
            ROLLBACK
            RETURN Error("RESERVATION_NOT_ACTIVE")
        IF reservation.expires_at < NOW():
            UPDATE reservation SET status = "expired"
            ROLLBACK
            RETURN Error("RESERVATION_EXPIRED")

        // Step 3: Validate actual amount
        IF actual_amount > reservation.amount:
            ROLLBACK
            RETURN Error("AMOUNT_EXCEEDS_RESERVATION")

        // Step 4: Get current balance for balance_after calculation
        current_balance = get_current_balance(reservation.organization_id)
        new_balance = current_balance - actual_amount

        // Step 5: Create debit entry
        entry = INSERT INTO ledger_entries (
            entry_id: generate_uuid(),
            organization_id: reservation.organization_id,
            entry_type: "debit",
            amount: -actual_amount,  // Negative for debits
            balance_after: new_balance,
            idempotency_key: idempotency_key,
            correlation_id: reservation.correlation_id,
            created_at: NOW(),
            created_by: actor,
            metadata: {
                reservation_id: reservation_id,
                reserved_amount: reservation.amount,
                actual_amount: actual_amount
            },
            checksum: compute_checksum(...)
        )

        // Step 6: Mark reservation consumed
        UPDATE reservation SET status = "consumed", consumed_at = NOW()

        // Step 7: If actual < reserved, no credit-back needed
        //         (reservation was just a hold, not a charge)

        COMMIT
        RETURN Success(entry)
```

### 2.4 Grant Credits

```
FUNCTION grant_credits(organization_id, amount, reason, idempotency_key, actor, correlation_id):
    // Step 1: Validate inputs
    IF amount <= 0:
        RETURN Error("INVALID_AMOUNT")

    BEGIN TRANSACTION WITH SERIALIZABLE ISOLATION:
        // Step 2: Idempotency check
        existing = get_entry_by_idempotency_key(organization_id, idempotency_key)
        IF existing IS NOT NULL:
            COMMIT
            RETURN Success(existing)

        // Step 3: Validate organization
        org = get_organization(organization_id)
        IF org IS NULL:
            ROLLBACK
            RETURN Error("ORGANIZATION_NOT_FOUND")
        IF org.status == "closed":
            ROLLBACK
            RETURN Error("ORGANIZATION_CLOSED")

        // Step 4: Get current balance
        current_balance = get_current_balance(organization_id)
        new_balance = current_balance + amount

        // Step 5: Create grant entry
        entry = INSERT INTO ledger_entries (
            entry_id: generate_uuid(),
            organization_id: organization_id,
            entry_type: "grant",
            amount: amount,  // Positive for grants
            balance_after: new_balance,
            idempotency_key: idempotency_key,
            correlation_id: correlation_id,
            created_at: NOW(),
            created_by: actor,
            metadata: { reason: reason },
            checksum: compute_checksum(...)
        )

        COMMIT
        RETURN Success(entry)
```

### 2.5 Balance Computation

```
FUNCTION get_current_balance(organization_id):
    // Option A: Sum all entries (accurate but slower)
    result = SELECT COALESCE(SUM(amount), 0)
             FROM ledger_entries
             WHERE organization_id = organization_id
    RETURN result

FUNCTION get_current_balance_optimized(organization_id):
    // Option B: Get latest entry's balance_after (fast)
    result = SELECT balance_after
             FROM ledger_entries
             WHERE organization_id = organization_id
             ORDER BY created_at DESC
             LIMIT 1
    RETURN COALESCE(result, 0)

FUNCTION get_available_balance(organization_id):
    current = get_current_balance(organization_id)
    reserved = SELECT COALESCE(SUM(amount), 0)
               FROM reservations
               WHERE organization_id = organization_id
               AND status = "active"
               AND expires_at > NOW()
    RETURN current - reserved
```

### 2.6 Reversal (Refund)

```
FUNCTION reverse_entry(original_entry_id, reason, idempotency_key, actor):
    BEGIN TRANSACTION WITH SERIALIZABLE ISOLATION:
        // Step 1: Idempotency check
        existing = get_entry_by_idempotency_key(original_entry.organization_id, idempotency_key)
        IF existing IS NOT NULL:
            COMMIT
            RETURN Success(existing)

        // Step 2: Get original entry
        original = get_entry(original_entry_id)
        IF original IS NULL:
            ROLLBACK
            RETURN Error("ENTRY_NOT_FOUND")

        // Step 3: Check if already reversed
        existing_reversal = get_reversal_for_entry(original_entry_id)
        IF existing_reversal IS NOT NULL:
            ROLLBACK
            RETURN Error("ALREADY_REVERSED")

        // Step 4: Calculate reversal amount (opposite sign)
        reversal_amount = -original.amount
        current_balance = get_current_balance(original.organization_id)
        new_balance = current_balance + reversal_amount

        // Step 5: Create reversal entry
        entry = INSERT INTO ledger_entries (
            entry_id: generate_uuid(),
            organization_id: original.organization_id,
            entry_type: "reversal",
            amount: reversal_amount,
            balance_after: new_balance,
            idempotency_key: idempotency_key,
            correlation_id: original.entry_id,  // Links to original
            created_at: NOW(),
            created_by: actor,
            metadata: {
                original_entry_id: original_entry_id,
                original_amount: original.amount,
                reason: reason
            },
            checksum: compute_checksum(...)
        )

        COMMIT
        RETURN Success(entry)
```

---

## 3. Architecture

### 3.1 System Context

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Agentics Ecosystem                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │ agentics-cli │    │ agentics-ui  │    │ agentics-platform (API)  │  │
│  └──────┬───────┘    └──────┬───────┘    └────────────┬─────────────┘  │
│         │                   │                         │                 │
│         └───────────────────┼─────────────────────────┘                 │
│                             │                                           │
│                             ▼                                           │
│                 ┌───────────────────────┐                               │
│                 │                       │                               │
│                 │  agentics-usage-      │◄──── THIS SERVICE             │
│                 │  ledger               │                               │
│                 │                       │                               │
│                 └───────────┬───────────┘                               │
│                             │                                           │
│                             ▼                                           │
│                 ┌───────────────────────┐                               │
│                 │  Ruvector Postgres    │                               │
│                 │  (Shared Data Plane)  │                               │
│                 └───────────────────────┘                               │
│                             │                                           │
│                             ▼                                           │
│                 ┌───────────────────────┐                               │
│                 │  Downstream Analytics │                               │
│                 │  (LLM-CostOps, etc)   │                               │
│                 └───────────────────────┘                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        agentics-usage-ledger                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         API Layer                                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │   │
│  │  │   REST API  │  │  gRPC API   │  │  Internal Service API   │  │   │
│  │  │  (external) │  │ (internal)  │  │     (for execution)     │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│  ┌──────────────────────────▼──────────────────────────────────────┐   │
│  │                     Application Layer                            │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │   Grant    │  │   Debit    │  │ Reservation│  │  Balance  │  │   │
│  │  │  Service   │  │  Service   │  │  Service   │  │  Service  │  │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │ Adjustment │  │  Reversal  │  │   Audit    │  │   Query   │  │   │
│  │  │  Service   │  │  Service   │  │  Service   │  │  Service  │  │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│  ┌──────────────────────────▼──────────────────────────────────────┐   │
│  │                      Domain Layer                                │   │
│  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐  │   │
│  │  │  LedgerEntry   │  │  Reservation   │  │   Organization    │  │   │
│  │  │   Aggregate    │  │   Aggregate    │  │    Reference      │  │   │
│  │  └────────────────┘  └────────────────┘  └───────────────────┘  │   │
│  │  ┌────────────────┐  ┌────────────────┐                         │   │
│  │  │  Balance       │  │  Enforcement   │                         │   │
│  │  │  Calculator    │  │    Policy      │                         │   │
│  │  └────────────────┘  └────────────────┘                         │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
│  ┌──────────────────────────▼──────────────────────────────────────┐   │
│  │                   Infrastructure Layer                           │   │
│  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐  │   │
│  │  │   Ledger       │  │  Reservation   │  │   Read Model      │  │   │
│  │  │  Repository    │  │  Repository    │  │   Repository      │  │   │
│  │  └────────────────┘  └────────────────┘  └───────────────────┘  │   │
│  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────────┐  │   │
│  │  │  Transaction   │  │  Idempotency   │  │   Event           │  │   │
│  │  │   Manager      │  │    Store       │  │   Publisher       │  │   │
│  │  └────────────────┘  └────────────────┘  └───────────────────┘  │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                             │                                           │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │
                              ▼
                 ┌───────────────────────┐
                 │  Ruvector Postgres    │
                 │  (Shared Data Plane)  │
                 └───────────────────────┘
```

### 3.3 API Layer

#### 3.3.1 External REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/organizations/{org_id}/balance` | GET | Get current and available balance |
| `/v1/organizations/{org_id}/can-execute` | POST | Pre-flight check for execution |
| `/v1/organizations/{org_id}/entries` | GET | List ledger entries (paginated) |
| `/v1/organizations/{org_id}/entries/{entry_id}` | GET | Get specific entry |
| `/v1/organizations/{org_id}/reservations` | POST | Create credit reservation |
| `/v1/organizations/{org_id}/reservations/{res_id}` | GET | Get reservation status |
| `/v1/organizations/{org_id}/reservations/{res_id}/consume` | POST | Consume reservation |
| `/v1/organizations/{org_id}/reservations/{res_id}/cancel` | POST | Cancel reservation |

#### 3.3.2 Internal gRPC API

```protobuf
service UsageLedger {
    // Pre-flight enforcement
    rpc CanExecute(CanExecuteRequest) returns (CanExecuteResponse);

    // Credit operations
    rpc GrantCredits(GrantRequest) returns (LedgerEntry);
    rpc ReserveCredits(ReserveRequest) returns (Reservation);
    rpc ConsumeReservation(ConsumeRequest) returns (LedgerEntry);
    rpc CancelReservation(CancelRequest) returns (Reservation);

    // Balance queries
    rpc GetBalance(BalanceRequest) returns (BalanceResponse);
    rpc GetAvailableBalance(BalanceRequest) returns (BalanceResponse);

    // Audit queries
    rpc ListEntries(ListEntriesRequest) returns (ListEntriesResponse);
    rpc GetEntry(GetEntryRequest) returns (LedgerEntry);
}
```

### 3.4 Ledger Write Path

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│   Client   │───▶│    API     │───▶│  Service   │───▶│ Repository │
│  Request   │    │  Handler   │    │   Layer    │    │   Layer    │
└────────────┘    └────────────┘    └────────────┘    └─────┬──────┘
                                                            │
                                                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                     Transactional Boundary                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  Idempotency │  │   Balance    │  │     Ledger Entry         │ │
│  │    Check     │──▶│  Validation  │──▶│       Insert             │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                        │          │
│                                                        ▼          │
│                                       ┌──────────────────────────┐│
│                                       │   Compute Checksum +     ││
│                                       │   Update balance_after   ││
│                                       └──────────────────────────┘│
└───────────────────────────────────────────────────────────────────┘
                                                            │
                                                            ▼
                                              ┌────────────────────┐
                                              │  Event Publisher   │
                                              │  (async, optional) │
                                              └────────────────────┘
```

### 3.5 Read Models

#### 3.5.1 Balance Materialization

```
┌─────────────────────────────────────────────────────────────────┐
│                    Balance Read Model                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  organization_balances (materialized/cached)                    │
│  ├── organization_id: UUID                                      │
│  ├── current_balance: Decimal                                   │
│  ├── reserved_amount: Decimal                                   │
│  ├── available_balance: Decimal (computed)                      │
│  ├── last_entry_id: UUID                                        │
│  ├── last_updated_at: Timestamp                                 │
│  └── version: BigInt (optimistic locking)                       │
│                                                                 │
│  Updated synchronously within write transaction                 │
│  OR asynchronously via CDC/triggers                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.5.2 Query Projections

| Projection | Purpose | Update Strategy |
|------------|---------|-----------------|
| `balance_snapshot` | Fast balance lookups | Sync on write |
| `usage_by_period` | Usage aggregates by time | Async aggregation |
| `entry_search` | Full-text search on entries | Async indexing |

### 3.6 Integration Boundaries

#### 3.6.1 Upstream Integrations (Callers)

| System | Integration Type | Purpose |
|--------|------------------|---------|
| `agentics-platform` | gRPC | Pre-flight checks, grants |
| `agentics-cli` | REST | Balance queries, usage display |
| Execution Services | gRPC | Reserve/consume during execution |

#### 3.6.2 Downstream Integrations (Consumers)

| System | Integration Type | Purpose |
|--------|------------------|---------|
| `Ruvector Postgres` | Direct writes | Authoritative data storage |
| `LLM-CostOps` | Event stream/CDC | Analytics consumption |
| Audit Systems | Event stream | Compliance logging |

#### 3.6.3 Explicit Non-Integrations

| System | Why Not Integrated |
|--------|-------------------|
| Execution Services | Ledger does not execute; it gates execution |
| Billing UI | Ledger is not a UI; balance data exposed via API |
| Telemetry | Ledger is not telemetry; it's accounting |
| Forecasting | Ledger is historical truth, not prediction |

### 3.7 Database Schema (Ruvector Postgres)

```sql
-- Core ledger table (append-only)
CREATE TABLE ledger_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('grant', 'debit', 'adjustment', 'reversal')),
    amount DECIMAL(20, 6) NOT NULL,
    balance_after DECIMAL(20, 6) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    correlation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}',
    checksum VARCHAR(64) NOT NULL,

    CONSTRAINT unique_idempotency_per_org UNIQUE (organization_id, idempotency_key)
);

-- Reservations table
CREATE TABLE reservations (
    reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
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

-- Balance snapshot (for fast reads)
CREATE TABLE balance_snapshots (
    organization_id UUID PRIMARY KEY,
    current_balance DECIMAL(20, 6) NOT NULL DEFAULT 0,
    reserved_amount DECIMAL(20, 6) NOT NULL DEFAULT 0,
    last_entry_id UUID,
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version BIGINT NOT NULL DEFAULT 1
);

-- Indexes for query performance
CREATE INDEX idx_ledger_org_created ON ledger_entries (organization_id, created_at DESC);
CREATE INDEX idx_ledger_correlation ON ledger_entries (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_reservations_org_status ON reservations (organization_id, status) WHERE status = 'active';
CREATE INDEX idx_reservations_expiry ON reservations (expires_at) WHERE status = 'active';
```

---

## 4. Refinement

### 4.1 Concurrency Control

#### 4.1.1 Transaction Isolation

| Operation | Isolation Level | Rationale |
|-----------|-----------------|-----------|
| Reserve credits | SERIALIZABLE | Prevent double-spending of available balance |
| Consume reservation | SERIALIZABLE | Ensure reservation is consumed exactly once |
| Grant credits | READ COMMITTED | Grants don't compete for limited resources |
| Balance query | READ COMMITTED | Acceptable staleness for reads |

#### 4.1.2 Locking Strategy

```
Write Operations:
├── SELECT ... FOR UPDATE on organization (short-lived)
├── Compute new balance
├── INSERT ledger entry
├── UPDATE balance snapshot
└── COMMIT

Lock ordering (to prevent deadlocks):
1. Always acquire organization lock first
2. Then reservation lock (if applicable)
3. Then insert entries
```

#### 4.1.3 Optimistic Concurrency for Snapshots

```
UPDATE balance_snapshots
SET current_balance = new_balance,
    last_entry_id = entry_id,
    last_updated_at = NOW(),
    version = version + 1
WHERE organization_id = org_id
AND version = expected_version;

-- If rows_affected = 0, retry with fresh read
```

### 4.2 Idempotency

#### 4.2.1 Idempotency Key Requirements

| Requirement | Implementation |
|-------------|----------------|
| Unique per org | Composite unique constraint (org_id, idempotency_key) |
| Client-provided | Passed in request header/body |
| Persistent | Stored with entry, never deleted |
| Lookup before write | Check before transaction begins |

#### 4.2.2 Idempotency Semantics

```
IF idempotency_key exists for organization:
    RETURN original result (entry or error)
ELSE:
    Process request
    Store result with idempotency_key
    RETURN result
```

#### 4.2.3 Idempotency Key Format Recommendations

```
Format: {client_id}:{operation}:{unique_suffix}
Examples:
  - cli-abc123:reserve:exec-789
  - platform:grant:purchase-order-456
  - execution-svc:consume:job-execution-xyz
```

### 4.3 Failure Handling

#### 4.3.1 Failure Categories

| Failure Type | Detection | Response |
|--------------|-----------|----------|
| Network timeout | Client timeout | Retry with same idempotency key |
| Transaction rollback | Postgres error | Return error, client may retry |
| Constraint violation | Unique key error | Return conflict error |
| Insufficient balance | Business logic | Return 402 with shortfall details |
| Invalid organization | Not found | Return 404 |

#### 4.3.2 Retry Strategy

```
Client Retry Policy:
├── Retryable errors: 503, 504, network errors
├── Non-retryable: 400, 402, 404, 409
├── Max retries: 3
├── Backoff: exponential with jitter
└── MUST use same idempotency key
```

#### 4.3.3 Compensation Patterns

```
Reservation Timeout:
├── Background job runs every 60 seconds
├── SELECT expired reservations (expires_at < NOW() AND status = 'active')
├── UPDATE status = 'expired'
└── Credits automatically become available

Failed Execution Compensation:
├── Execution service calls cancel_reservation
├── OR execution service lets reservation expire
├── Reservation marked cancelled/expired
└── Credits returned to available pool
```

### 4.4 Rollback Semantics

#### 4.4.1 Append-Only Constraint

```
CRITICAL: Ledger entries are NEVER deleted or modified.

Correction mechanism:
├── Create new 'reversal' or 'adjustment' entry
├── Link via correlation_id to original
├── New entry has opposite amount for reversals
└── Audit trail preserved
```

#### 4.4.2 Reversal Rules

| Original Type | Can Reverse? | Reversal Type | Constraints |
|---------------|--------------|---------------|-------------|
| grant | Yes | reversal (negative) | Once per entry |
| debit | Yes | reversal (positive) | Once per entry |
| adjustment | Yes | reversal | Requires elevated permission |
| reversal | No | N/A | Reversals cannot be reversed |

#### 4.4.3 Partial Reversal

```
Not supported at ledger level.

Rationale:
├── Ledger entries are atomic
├── Partial reversal is modeled as:
│   ├── Full reversal of original
│   └── New entry for remaining amount
└── Maintains audit clarity
```

### 4.5 Security and RBAC

#### 4.5.1 Permission Model

| Permission | Description | Typical Roles |
|------------|-------------|---------------|
| `ledger:read` | View balance and entries | User, Admin, Service |
| `ledger:reserve` | Create reservations | Execution Service |
| `ledger:consume` | Consume reservations | Execution Service |
| `credit:grant` | Grant credits | Admin, Billing Service |
| `credit:adjust` | Create adjustments | Super Admin |
| `credit:reverse` | Reverse entries | Admin, Support |
| `audit:read` | Full audit log access | Compliance, Security |

#### 4.5.2 Multi-Tenancy Enforcement

```
Every query MUST include organization_id filter:
├── Application-level: Service layer validates org access
├── Database-level: Row-level security (optional)
└── API-level: JWT claims include org_id

Cross-org access: FORBIDDEN (except super admin with audit)
```

#### 4.5.3 Actor Identification

```
Actor types:
├── user:{user_id} - Human user
├── service:{service_name} - Service account
├── api_key:{key_hash} - API key (hashed for storage)
├── system:scheduler - Background jobs
└── admin:{admin_id} - Administrative actions

Stored in created_by field of every entry.
```

#### 4.5.4 Sensitive Data Handling

| Data | Classification | Protection |
|------|----------------|------------|
| Balance amounts | PII | Encrypted at rest, TLS in transit |
| Actor identifiers | PII | Hashed for API keys, encrypted at rest |
| Idempotency keys | Internal | No special protection needed |
| Metadata | Variable | Application-specific encryption if needed |

### 4.6 Rate Limiting

```
Limits by endpoint:
├── /can-execute: 1000 req/sec per org (critical path)
├── /balance: 500 req/sec per org
├── /reservations: 100 req/sec per org
├── /entries (list): 50 req/sec per org
└── Grant/adjust endpoints: 10 req/sec per org

Implementation:
├── Token bucket algorithm
├── Keyed by organization_id
└── 429 response with Retry-After header
```

### 4.7 Observability

#### 4.7.1 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `ledger_entries_total` | Counter | entry_type, org_id |
| `ledger_balance_current` | Gauge | org_id |
| `ledger_reservations_active` | Gauge | org_id |
| `ledger_request_duration_seconds` | Histogram | endpoint, status |
| `ledger_errors_total` | Counter | error_type, endpoint |

#### 4.7.2 Logging

```
Structured log fields:
├── organization_id (always)
├── entry_id (when applicable)
├── correlation_id (when applicable)
├── actor (who performed action)
├── operation (what was done)
└── result (success/failure)

Log levels:
├── INFO: Successful operations
├── WARN: Retriable failures, rate limits
├── ERROR: Non-retriable failures
└── DEBUG: Detailed transaction flow
```

#### 4.7.3 Tracing

```
Distributed trace context:
├── Propagate trace_id from upstream callers
├── Create span for each ledger operation
├── Include entry_id, reservation_id as span attributes
└── Link related spans via correlation_id
```

---

## 5. Completion

### 5.1 Minimal Viable API Surface (MVP)

#### 5.1.1 Phase 1: Core Ledger (Week 1-2)

| Endpoint | Priority | Description |
|----------|----------|-------------|
| `POST /v1/orgs/{id}/can-execute` | P0 | Pre-flight check |
| `GET /v1/orgs/{id}/balance` | P0 | Balance query |
| `POST /v1/orgs/{id}/reservations` | P0 | Create reservation |
| `POST /v1/orgs/{id}/reservations/{id}/consume` | P0 | Consume reservation |
| `POST /v1/orgs/{id}/reservations/{id}/cancel` | P1 | Cancel reservation |

#### 5.1.2 Phase 2: Credit Management (Week 3)

| Endpoint | Priority | Description |
|----------|----------|-------------|
| `POST /v1/orgs/{id}/grants` | P0 | Grant credits |
| `GET /v1/orgs/{id}/entries` | P1 | List entries |
| `GET /v1/orgs/{id}/entries/{id}` | P1 | Get entry |

#### 5.1.3 Phase 3: Administration (Week 4)

| Endpoint | Priority | Description |
|----------|----------|-------------|
| `POST /v1/orgs/{id}/adjustments` | P1 | Create adjustment |
| `POST /v1/orgs/{id}/reversals` | P1 | Reverse entry |
| `GET /v1/orgs/{id}/reservations` | P2 | List reservations |

### 5.2 Success Criteria

#### 5.2.1 Functional Requirements

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| Pre-flight accuracy | Balance check correctness | 100% |
| Idempotency | Duplicate requests return same result | 100% |
| Balance consistency | Sum of entries = current balance | 100% |
| Reservation expiry | Expired reservations cleaned up | < 5 min delay |

#### 5.2.2 Performance Requirements

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| can-execute latency | p99 response time | < 50ms |
| balance query latency | p99 response time | < 20ms |
| reserve latency | p99 response time | < 100ms |
| consume latency | p99 response time | < 100ms |
| Throughput | Requests per second | > 1000 rps |

#### 5.2.3 Reliability Requirements

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| Availability | Uptime percentage | 99.9% |
| Data durability | No data loss | 100% |
| Consistency | No split-brain | 100% |
| Recovery time | Time to recover from failure | < 5 min |

#### 5.2.4 Security Requirements

| Criterion | Measurement | Target |
|-----------|-------------|--------|
| Authorization | Unauthorized access attempts blocked | 100% |
| Audit coverage | All mutations logged | 100% |
| Encryption | Data encrypted at rest and in transit | 100% |
| Secrets | No secrets in logs or errors | 100% |

### 5.3 Allowed Behaviors

| Behavior | Allowed | Rationale |
|----------|---------|-----------|
| Grant credits to active organization | Yes | Core function |
| Debit credits via reservation | Yes | Core function |
| Reject execution for insufficient balance | Yes | Enforcement |
| Create adjustment with audit trail | Yes | Error correction |
| Reverse any entry (except reversals) | Yes | Refund/correction |
| Query balance and entries | Yes | Read operations |
| Expire stale reservations automatically | Yes | Resource cleanup |
| Return cached idempotent results | Yes | Idempotency |
| Emit events for downstream consumption | Yes | Integration |

### 5.4 Forbidden Behaviors

| Behavior | Forbidden | Rationale |
|----------|-----------|-----------|
| Delete ledger entries | Yes | Append-only ledger |
| Modify existing ledger entries | Yes | Immutability |
| Allow negative balance (without override) | Yes | Enforcement |
| Execute workloads | Yes | Ledger is not execution |
| Display billing UI | Yes | Not a UI service |
| Aggregate telemetry | Yes | Not telemetry service |
| Generate forecasts/predictions | Yes | Not analytics |
| Store user profiles | Yes | Not user service |
| Process payments | Yes | Not payment gateway |
| Grant credits without authorization | Yes | RBAC enforcement |
| Cross-organization data access | Yes | Multi-tenancy |
| Log sensitive data (balances, keys) | Yes | Security |
| Accept client-provided timestamps | Yes | Server-authoritative |
| Allow reversal of reversals | Yes | Prevents loops |

### 5.5 Testing Requirements

#### 5.5.1 Unit Tests

| Component | Coverage Target |
|-----------|-----------------|
| Balance calculation | 100% |
| Idempotency logic | 100% |
| Entry validation | 100% |
| Permission checks | 100% |

#### 5.5.2 Integration Tests

| Scenario | Required |
|----------|----------|
| Reserve → Consume flow | Yes |
| Reserve → Expire flow | Yes |
| Reserve → Cancel flow | Yes |
| Grant → Query balance | Yes |
| Concurrent reservations (race condition) | Yes |
| Idempotent retries | Yes |
| Cross-org isolation | Yes |

#### 5.5.3 Load Tests

| Scenario | Target |
|----------|--------|
| Sustained throughput | 1000 rps for 1 hour |
| Burst traffic | 5000 rps for 1 minute |
| Database failover | Recovery < 5 min |

### 5.6 Documentation Requirements

| Document | Required |
|----------|----------|
| API specification (OpenAPI) | Yes |
| gRPC proto definitions | Yes |
| Integration guide | Yes |
| Runbook for operations | Yes |
| Architecture decision records | Yes |

### 5.7 Deployment Considerations

#### 5.7.1 Infrastructure

| Component | Requirement |
|-----------|-------------|
| Compute | Stateless containers (Kubernetes) |
| Database | Ruvector Postgres (managed) |
| Secrets | External secret manager |
| Load balancer | TLS termination, health checks |

#### 5.7.2 Rollout Strategy

```
Deployment phases:
1. Deploy to staging with synthetic traffic
2. Canary deployment (5% traffic)
3. Gradual rollout (25%, 50%, 100%)
4. Rollback capability at each phase
```

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Ledger** | Append-only record of all credit transactions |
| **Entry** | Single immutable record in the ledger |
| **Grant** | Addition of credits to an organization |
| **Debit** | Removal of credits from an organization |
| **Adjustment** | Administrative correction entry |
| **Reversal** | Entry that undoes a previous entry |
| **Reservation** | Temporary hold on credits before consumption |
| **Balance** | Current sum of all credits (grants - debits) |
| **Available Balance** | Balance minus active reservations |
| **Idempotency Key** | Client-provided unique identifier for deduplication |
| **Correlation ID** | Identifier linking related entries |
| **Actor** | Entity performing an action (user, service, etc.) |

## Appendix B: Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `ORGANIZATION_NOT_FOUND` | 404 | Organization does not exist |
| `ORGANIZATION_SUSPENDED` | 403 | Organization is suspended |
| `ORGANIZATION_CLOSED` | 403 | Organization is closed |
| `INSUFFICIENT_CREDITS` | 402 | Not enough available credits |
| `RESERVATION_NOT_FOUND` | 404 | Reservation does not exist |
| `RESERVATION_NOT_ACTIVE` | 409 | Reservation already consumed/expired/cancelled |
| `RESERVATION_EXPIRED` | 410 | Reservation has expired |
| `AMOUNT_EXCEEDS_RESERVATION` | 400 | Consume amount > reserved amount |
| `ENTRY_NOT_FOUND` | 404 | Ledger entry does not exist |
| `ALREADY_REVERSED` | 409 | Entry has already been reversed |
| `INVALID_AMOUNT` | 400 | Amount is invalid (negative, zero, etc.) |
| `DUPLICATE_IDEMPOTENCY_KEY` | 409 | Idempotency key already used (different request) |
| `PERMISSION_DENIED` | 403 | Caller lacks required permission |
| `RATE_LIMITED` | 429 | Too many requests |

## Appendix C: Event Schema

```json
{
  "event_type": "ledger.entry.created",
  "event_id": "uuid",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "entry_id": "uuid",
    "organization_id": "uuid",
    "entry_type": "grant|debit|adjustment|reversal",
    "amount": 100.00,
    "balance_after": 500.00,
    "correlation_id": "uuid",
    "created_by": "user:123"
  }
}
```

---

**End of SPARC Specification**
