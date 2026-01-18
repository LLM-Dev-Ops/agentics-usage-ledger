<p align="center">
  <img src="https://img.shields.io/badge/Agentics-Usage%20Ledger-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyek0xMiAyMGMtNC40MSAwLTgtMy41OS04LThzMy41OS04IDgtOCA4IDMuNTkgOCA4LTMuNTkgOC04IDh6Ii8+PHBhdGggZD0iTTEyLjUgN0gxMXY2bDUuMjUgMy4xNS43NS0xLjIzLTQuNS0yLjY3eiIvPjwvc3ZnPg==" alt="Agentics Usage Ledger" />
</p>

<p align="center">
  <strong>Authoritative Credit Accounting & Enforcement Service</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.3-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/PostgreSQL-15+-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Cloud%20Run-Deployed-4285F4?style=flat-square&logo=google-cloud&logoColor=white" alt="Cloud Run" />
  <img src="https://img.shields.io/badge/Stripe-Integrated-635bff?style=flat-square&logo=stripe&logoColor=white" alt="Stripe" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tests-112%20Passing-22c55e?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/Coverage-Core%20Paths-22c55e?style=flat-square" alt="Coverage" />
  <img src="https://img.shields.io/badge/License-Proprietary-ef4444?style=flat-square" alt="License" />
</p>

---

## Overview

The **Agentics Usage Ledger** is the single source of truth for credit accounting across the Agentics platform. It provides:

- **Append-only ledger** with immutable transaction history
- **Pre-flight enforcement** to block unauthorized executions
- **Reservation system** for guaranteed credit allocation
- **Command entitlements** with daily/monthly limits
- **Stripe integration** for metered usage reporting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENTICS ECOSYSTEM                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐                 │
│   │   CLI   │    │   UI    │    │  APIs   │    │ Workers │                 │
│   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘                 │
│        │              │              │              │                       │
│        └──────────────┴──────────────┴──────────────┘                       │
│                              │                                              │
│                              ▼                                              │
│        ┌─────────────────────────────────────────────┐                     │
│        │         AGENTICS USAGE LEDGER               │                     │
│        │  ┌─────────────────────────────────────┐    │                     │
│        │  │  Pre-flight │ Reservations │ Debits │    │                     │
│        │  └─────────────────────────────────────┘    │                     │
│        │  ┌─────────────────────────────────────┐    │                     │
│        │  │  Entitlements │ Grants │ Reversals  │    │                     │
│        │  └─────────────────────────────────────┘    │                     │
│        └──────────────────┬──────────────────────────┘                     │
│                           │                                                 │
│              ┌────────────┴────────────┐                                   │
│              ▼                         ▼                                   │
│     ┌─────────────────┐      ┌─────────────────┐                          │
│     │   PostgreSQL    │      │     Stripe      │                          │
│     │ (Source of Truth)│      │  (Usage Sink)   │                          │
│     └─────────────────┘      └─────────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Append-Only Ledger** | Immutable transaction history with SHA-256 checksums |
| **Pre-flight Checks** | Block execution before it starts if credits insufficient |
| **Reservation System** | Reserve credits with TTL, consume actual usage later |
| **Command Entitlements** | Per-org command access with daily/monthly quotas |
| **Cloud Run IAM** | Zero-trust authentication via GCP identity |
| **Stripe Metering** | Non-blocking usage emission to Stripe |
| **Idempotency** | Duplicate requests return cached responses |
| **SERIALIZABLE** | Strictest PostgreSQL isolation for consistency |

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- GCP Project (for Cloud Run deployment)

### Local Development

```bash
# Clone the repository
git clone https://github.com/agentics/agentics-usage-ledger.git
cd agentics-usage-ledger

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your database credentials

# Run in development mode
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Build for production
npm run build
```

### Docker

```bash
# Build image
docker build -t agentics-usage-ledger .

# Run container
docker run -p 8080:8080 \
  -e PGHOST=host.docker.internal \
  -e PGDATABASE=usage-ledger \
  -e PGUSER=postgres \
  -e PGPASSWORD=secret \
  agentics-usage-ledger
```

---

## API Reference

### Health Check

```http
GET /health
```

Returns `200 OK` when service is healthy.

---

### Balance Operations

#### Get Balance

```http
GET /v1/organizations/{org_id}/balance
```

**Response:**
```json
{
  "organization_id": "org-123",
  "current_balance": "5000.000000",
  "reserved_amount": "100.000000",
  "available_balance": "4900.000000",
  "as_of": "2024-01-15T10:30:00Z"
}
```

#### Pre-flight Check

```http
POST /v1/organizations/{org_id}/can-execute
Content-Type: application/json

{
  "required_credits": "10.00",
  "service": "simulation-engine",
  "run_id": "run-abc-123"
}
```

**Response:**
```json
{
  "allowed": true,
  "organization_id": "org-123",
  "available_balance": "4900.000000",
  "required_credits": "10.00"
}
```

---

### Credit Operations

#### Grant Credits

```http
POST /v1/organizations/{org_id}/grants
Content-Type: application/json

{
  "amount": "1000.00",
  "reason": "Monthly allocation",
  "idempotency_key": "grant-jan-2024",
  "actor": "admin@company.com"
}
```

#### Record Debit

```http
POST /v1/organizations/{org_id}/debits
Content-Type: application/json

{
  "amount": "5.00",
  "service": "simulation-engine",
  "run_id": "run-abc-123",
  "idempotency_key": "debit-run-abc-123",
  "actor": "user@company.com"
}
```

---

### Reservations

#### Create Reservation

```http
POST /v1/organizations/{org_id}/reservations
Content-Type: application/json

{
  "amount": "50.00",
  "ttl_seconds": 300,
  "idempotency_key": "res-job-456",
  "actor": "worker@system"
}
```

**Response:**
```json
{
  "reservation_id": "res-uuid-here",
  "organization_id": "org-123",
  "amount": "50.000000",
  "status": "active",
  "expires_at": "2024-01-15T10:35:00Z"
}
```

#### Consume Reservation

```http
POST /v1/organizations/{org_id}/reservations/{reservation_id}/consume
Content-Type: application/json

{
  "actual_amount": "42.50",
  "idempotency_key": "consume-job-456",
  "actor": "worker@system",
  "service": "simulation-engine"
}
```

#### Cancel Reservation

```http
POST /v1/organizations/{org_id}/reservations/{reservation_id}/cancel
```

---

### Command Entitlements

#### Check Command Access

```http
POST /v1/entitlements/can-execute
Content-Type: application/json

{
  "organization_id": "org-123",
  "command_name": "simulate:run",
  "user_id": "user@company.com"
}
```

**Response:**
```json
{
  "allowed": true,
  "organization_id": "org-123",
  "command_name": "simulate:run",
  "credits_per_use": 10,
  "daily_usage": 5,
  "daily_limit": 100,
  "monthly_usage": 45,
  "monthly_limit": 1000
}
```

#### Record Command Execution

```http
POST /v1/entitlements/record
Content-Type: application/json

{
  "organization_id": "org-123",
  "command_name": "simulate:run",
  "user_id": "user@company.com",
  "success": true,
  "execution_time_ms": 1234
}
```

---

### Usage Queries (UI Backend)

```http
GET /usage/summary
GET /usage/by-command
GET /usage/by-user
GET /usage/by-day
GET /usage/top-commands?limit=10
GET /usage/top-users?limit=10
```

All usage query endpoints require Cloud Run IAM authentication and automatically scope to the authenticated user's organization.

---

## Database Schema

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            DATABASE SCHEMA                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐                                                   │
│  │  organizations  │ (read-only reference)                             │
│  │─────────────────│                                                   │
│  │ organization_id │◄───────────────────┐                              │
│  │ name            │                    │                              │
│  │ status          │                    │                              │
│  └─────────────────┘                    │                              │
│                                         │                              │
│  ┌─────────────────┐    ┌──────────────┴────────────┐                 │
│  │ ledger_entries  │    │      reservations         │                 │
│  │─────────────────│    │───────────────────────────│                 │
│  │ entry_id (PK)   │    │ reservation_id (PK)       │                 │
│  │ organization_id │    │ organization_id           │                 │
│  │ entry_type      │    │ amount                    │                 │
│  │ amount (+/-)    │    │ status                    │                 │
│  │ balance_after   │    │ expires_at                │                 │
│  │ idempotency_key │    │ idempotency_key           │                 │
│  │ checksum        │    └───────────────────────────┘                 │
│  └─────────────────┘                                                   │
│                                                                         │
│  ┌─────────────────────┐    ┌─────────────────────┐                   │
│  │ command_entitlements│    │    command_usage    │                   │
│  │─────────────────────│    │─────────────────────│                   │
│  │ organization_id     │    │ usage_id (PK)       │                   │
│  │ command_name        │    │ organization_id     │                   │
│  │ status              │    │ command_name        │                   │
│  │ credits_per_use     │    │ credits_used        │                   │
│  │ daily_limit         │    │ success             │                   │
│  │ monthly_limit       │    │ created_at          │                   │
│  └─────────────────────┘    └─────────────────────┘                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Entry Types

| Type | Amount Sign | Use Case |
|------|-------------|----------|
| `grant` | Positive | Credit purchases, promotions, refunds |
| `debit` | Negative | Service usage, execution costs |
| `adjustment` | Either | Admin corrections, migrations |
| `reversal` | Opposite | Undo failed transactions |

---

## Configuration

### Environment Variables

```bash
# Server
PORT=8080                              # HTTP server port
HOST=0.0.0.0                           # Bind address

# Database (choose one format)
PGHOST=localhost                       # PostgreSQL host
PGPORT=5432                            # PostgreSQL port
PGDATABASE=usage-ledger                # Database name
PGUSER=postgres                        # Database user
PGPASSWORD=secret                      # Database password

# Or Cloud Run format
USAGE_DB_HOST=10.x.x.x
USAGE_DB_PORT=5432
USAGE_DB_NAME=usage-ledger
USAGE_DB_USER=postgres
USAGE_DB_PASSWORD=secret

# Stripe (optional - failures don't block)
STRIPE_SECRET_KEY=sk_live_...          # Stripe secret key
STRIPE_METER_EVENT_NAME=agentics_execution  # Meter event name

# Authentication
SKIP_AUTH_IN_DEV=false                 # Bypass auth locally
DEFAULT_ORG_ID=org-default             # Fallback organization
```

---

## Authentication

### Cloud Run IAM (Production)

All requests must include a valid GCP ID token:

```bash
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" \
  https://agentics-usage-ledger-xxx.run.app/v1/usage/balance
```

The service extracts the principal from the token and resolves it to an organization via:

1. **Database lookup** - Explicit principal → org mapping
2. **Domain matching** - `@company.com` → `org-company`
3. **Environment fallback** - `DEFAULT_ORG_ID`

### Development Mode

Set `SKIP_AUTH_IN_DEV=true` to bypass authentication locally.

---

## Stripe Integration

The ledger emits usage events to Stripe for metered billing:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Command Usage  │────▶│  Usage Ledger   │────▶│     Stripe      │
│   (recorded)    │     │ (source of truth)│     │  (usage sink)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Key Behaviors

- **Non-blocking**: Stripe failures are logged but don't block operations
- **Idempotent**: Uses `usage_id` as Stripe idempotency key
- **Weighted units**: Commands have different weights (e.g., `simulate:run` = 10x)
- **Lazy customer creation**: Stripe customers created on first usage

### Command Weights

| Command | Weight | Description |
|---------|--------|-------------|
| `simulate:run` | 10x | Full simulation execution |
| `simulate:create` | 5x | Simulation setup |
| `deploy:run` | 5x | Production deployment |
| `deploy:preview` | 3x | Preview deployment |
| `export:pdf` | 3x | PDF generation |
| `quantify:compare` | 3x | Comparison analysis |
| Default | 1x | Standard commands |

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `ORGANIZATION_NOT_FOUND` | 404 | Organization doesn't exist |
| `ORGANIZATION_SUSPENDED` | 403 | Organization is suspended |
| `ORGANIZATION_CLOSED` | 403 | Organization is closed |
| `INSUFFICIENT_CREDITS` | 402 | Not enough available balance |
| `RESERVATION_NOT_FOUND` | 404 | Reservation doesn't exist |
| `RESERVATION_NOT_ACTIVE` | 409 | Reservation already consumed/cancelled |
| `RESERVATION_EXPIRED` | 410 | Reservation TTL exceeded |
| `COMMAND_NOT_ENTITLED` | 403 | Organization not entitled to command |
| `DAILY_LIMIT_EXCEEDED` | 429 | Daily quota exceeded |
| `MONTHLY_LIMIT_EXCEEDED` | 429 | Monthly quota exceeded |
| `UNAUTHENTICATED` | 401 | Missing or invalid authentication |
| `INVALID_REQUEST` | 400 | Request validation failed |

---

## Deployment

### Cloud Run

```bash
# Build and push image
gcloud builds submit --tag gcr.io/PROJECT_ID/agentics-usage-ledger:latest

# Deploy to existing service
gcloud run deploy agentics-usage-ledger \
  --image gcr.io/PROJECT_ID/agentics-usage-ledger:latest \
  --region us-central1 \
  --set-secrets STRIPE_SECRET_KEY=stripe-secret-key:latest \
  --set-env-vars STRIPE_METER_EVENT_NAME=agentics_execution \
  --no-allow-unauthenticated
```

### Service Configuration

| Setting | Value |
|---------|-------|
| Region | `us-central1` |
| CPU | 1 |
| Memory | 512Mi |
| Concurrency | 80 |
| Min Instances | 0 |
| Max Instances | 10 |
| Timeout | 300s |

---

## Testing

```bash
# Run all tests
npm test

# Type checking
npm run typecheck

# Build
npm run build
```

**Test Coverage:**
- 112 tests across 48 suites
- Core ledger operations
- Authentication flows
- Entitlements system
- Usage aggregation
- Stripe integration

---

## Project Structure

```
agentics-usage-ledger/
├── src/
│   ├── index.ts              # Server entry point
│   ├── api/
│   │   └── handlers.ts       # HTTP endpoint handlers
│   ├── auth/
│   │   ├── index.ts          # Auth orchestration
│   │   ├── cloudrun.ts       # GCP IAM extraction
│   │   └── org-mapping.ts    # Principal → org resolution
│   ├── ledger/
│   │   └── index.ts          # Core business logic
│   ├── db/
│   │   ├── index.ts          # Connection pool
│   │   ├── setup.ts          # Schema initialization
│   │   ├── entitlements.ts   # Command entitlements
│   │   ├── usage-queries.ts  # Aggregation queries
│   │   └── org-stripe.ts     # Stripe customer mapping
│   ├── stripe/
│   │   └── index.ts          # Stripe meter integration
│   ├── types/
│   │   └── index.ts          # TypeScript interfaces
│   ├── errors/
│   │   └── index.ts          # Error definitions
│   └── validation/
│       └── index.ts          # Input validation
├── tests/
│   ├── ledger.test.ts
│   ├── auth.test.ts
│   ├── entitlements.test.ts
│   ├── stripe.test.ts
│   └── usage-queries.test.ts
├── schema/
│   └── README.md             # Schema documentation
├── plans/
│   └── SPARC_SPECIFICATION.md
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Architecture Principles

1. **Ledger is Source of Truth** - All balance computed from ledger entries
2. **Append-Only** - No updates or deletes, only new entries
3. **Pre-flight Enforcement** - Check before execute, not after
4. **Idempotency** - Same request always yields same result
5. **Non-Blocking Integrations** - External failures don't block operations
6. **Server-Side Authorization** - Never trust client-provided org_id

---

## License

Proprietary - Agentics Inc.

---

<p align="center">
  <sub>Built with precision for enterprise-grade credit accounting</sub>
</p>
