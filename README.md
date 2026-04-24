<div align="center">

```
 ██████╗ ██████╗ ██████╗ ███████╗██████╗
██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
██║   ██║██████╔╝██║  ██║█████╗  ██████╔╝
██║   ██║██╔══██╗██║  ██║██╔══╝  ██╔══██╗
╚██████╔╝██║  ██║██████╔╝███████╗██║  ██║
 ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝

███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗
██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║
███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║
╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║
███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗
╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
```

**Production-grade QA framework for Order & Profile Management Systems in prop trading.**

Tests order lifecycle correctness, execution accuracy, and trading logic validity  
across REST APIs, NATS message flows, and PostgreSQL state — built from the ground up.

[![CI](https://github.com/your-username/order-sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/order-sentinel/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-4.x-6E9F18?logo=vitest)](https://vitest.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify)](https://fastify.dev/)
[![NATS](https://img.shields.io/badge/NATS-2.10-27AAE1)](https://nats.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

---

## What is order-sentinel?

In a prop trading firm, a bug in order execution logic isn't a UX issue — it's a financial loss event. order-sentinel is the testing layer that stands between your OMS/PMS codebase and production risk.

It validates:

- **Order lifecycle correctness** — every state transition from NEW → FILLED follows the rules
- **Execution accuracy** — weighted average fill prices are mathematically correct
- **Risk enforcement** — position limits, daily loss limits, and order size caps actually block bad orders
- **Message contract integrity** — NATS events published match the schemas consumers expect
- **Time-in-force behaviour** — IOC, FOK, and DAY orders expire correctly

Fully standalone — runs out of the box with `npm test`. No external services required.

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| Test runner | **Vitest 4** | Native TypeScript, fast, great async support |
| Mock OMS | **Fastify** | Lightweight, fast, realistic in-process OMS |
| Message broker | **NATS** (primary) | Flagship JS client, low-latency, pub/sub |
| Broker abstraction | Custom `BrokerAdapter` | Swap to Kafka/RabbitMQ via one env var |
| Schema validation | **Zod** | Compile-time + runtime contract safety |
| Infrastructure | **Testcontainers** | Real NATS in Docker for broker tests |
| HTTP client | **Axios** | Typed API client, non-throwing on 4xx/5xx |
| CI/CD | **GitHub Actions** | 6-stage pipeline, coverage gates |

---

## Test Suites

```
tests/
├── contracts/                           Schema validation — no infra needed
│   └── schema-validation.test.ts
│       ├── All API request/response schemas
│       └── All NATS event schemas
│
├── api/                                 REST API tests — uses built-in mock OMS
│   ├── order-lifecycle.test.ts          Order CRUD, cancellation, fill retrieval
│   └── trader-profiles.test.ts          Profile CRUD, risk limits, suspension
│
├── trading-logic/                       Business rule validation — uses mock OMS
│   └── order-state-machine.test.ts
│       ├── State machine transitions (valid + invalid)
│       ├── Fill price accuracy (weighted average math)
│       ├── Risk check enforcement (position/daily loss/order count)
│       └── Time-in-force behavior (IOC, FOK, DAY expiry)
│
└── integration/                          NATS pub/sub contract tests — Testcontainers
    └── nats-message-flow.test.ts
        ├── orders.created event schema + field validation
        ├── orders.filled event with correct payload
        ├── Partial fill event collection (multi-fill orders)
        ├── orders.rejected with all rejection reason types
        └── traders.limit.breached notification
```

---

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker (only for `test:integration` — Testcontainers spins up NATS)

### Install

```bash
git clone https://github.com/your-username/order-sentinel.git
cd order-sentinel
npm install
cp .env.example .env
```

### Run All Tests

```bash
npm test
```

The mock OMS server starts automatically — no setup needed.

### Run by Suite

```bash
npm run test:contracts      # Schema tests — no Docker, runs in <2s
npm run test:api            # API tests — mock OMS, no Docker
npm run test:trading        # Business logic — mock OMS, no Docker
npm run test:integration    # NATS pub/sub — requires Docker for Testcontainers
```

### Run Mock OMS Standalone

```bash
npm run mock                # Start mock OMS on port 3000 for manual testing
```

### With Coverage

```bash
npm run test:coverage
# Coverage report at: coverage/index.html
# Thresholds: 80% lines/functions, 75% branches
```

---

## How It Works

### Mock OMS Server

order-sentinel includes a built-in Fastify mock of an OMS that starts automatically before each test run. It enforces real trading business rules:

- **Risk checks** on every order: position limits, daily loss limits, symbol whitelists, trader suspension
- **State machine enforcement**: FILLED → NEW is rejected, CANCELLED → PENDING is rejected
- **`/reset` endpoint** for clean test isolation between `beforeEach` calls
- **`?force=true`** param on `PATCH /orders/:id` for direct state setup in tests

```
                Mock OMS (Fastify)
                ┌──────────────────┐
  test ──────►  │  POST /orders    │  Risk engine validates
                │  GET  /traders   │  State machine enforced
                │  DELETE /orders  │  In-memory store
                │  POST /reset     │  Zero external deps
                └──────────────────┘
```

### NATS Integration Tests

The integration suite uses Testcontainers to spin up a real NATS server, then validates message schemas and pub/sub mechanics directly — no OMS involvement needed.

```
  Testcontainers
  ┌──────────────────────────────────┐
  │  nats:2.10-alpine (real Docker)  │
  │                                  │
  │  publish ──► subscribe           │
  │  assert schema ✓                 │
  │  assert delivery ✓               │
  └──────────────────────────────────┘
```

---

## Order Lifecycle

Every valid state transition is tested. Every invalid one is tested to be rejected.

```
         NEW  ──risk check──►  PENDING  ──partial fill──►  PARTIALLY_FILLED
          │                       │                                │
          │                  risk fails                        full fill
          │                       │                                │
          ▼                       ▼                                ▼
      CANCELLED              REJECTED                          FILLED

      (cancel from NEW, PENDING, or PARTIALLY_FILLED)
      EXPIRED (time-in-force elapsed)
```

---

## Broker Abstraction

All tests are written against a `BrokerAdapter` interface. NATS is the primary implementation. Kafka and RabbitMQ adapters are interface-compatible — swap via one environment variable.

```bash
BROKER_TYPE=nats      NATS_URL=nats://localhost:4222
BROKER_TYPE=kafka     KAFKA_BROKERS=localhost:9092
BROKER_TYPE=rabbitmq  RABBITMQ_URL=amqp://localhost:5672
```

---

## CI Pipeline
 
```
        push / PR
            │
            ▼
┌─────────────────────────┐
│   1. Lint + Typecheck   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   2. Contract Tests     │  No infrastructure — fastest gate
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   3. API Tests          │  Mock OMS auto-starts, no Docker
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   4. Trading Logic      │  Mock OMS auto-starts, no Docker
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   5. Integration Tests  │  Real NATS via Testcontainers (Docker)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│   6. Coverage Report    │
└─────────────────────────┘
```
 
> Suites run sequentially — the mock OMS store is shared in-process,
> so parallel file execution would cause state bleed between test files.

---

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — system design, mock OMS routes, NATS subject map
- [Adding Tests](./docs/ADDING-TESTS.md) — guide for contributing new test scenarios
- [Changelog](./CHANGELOG.md) — version history and roadmap

---

## Project Structure

```
order-sentinel/
├── src/
│   ├── types.ts                  Core domain types
│   ├── broker/                   Broker abstraction (NATS/Kafka/RabbitMQ)
│   ├── db/client.ts              PostgreSQL client + repositories
│   ├── api/client.ts             Typed HTTP client
│   ├── contracts/schemas.ts      Zod schemas
│   └── fixtures/factories.ts     Trading data factories
├── mock/
│   ├── server.ts                 Mock OMS (Fastify)
│   ├── store.ts                  In-memory state
│   └── risk.ts                   Risk engine + state machine
├── tests/                        All test suites
├── migrations/runner.ts          SQL migrations
├── infra/docker-compose.yml      Local dev infrastructure
├── vitest.setup.ts               Global test setup (starts mock OMS)
└── .github/workflows/ci.yml      GitHub Actions CI
```

---

<div align="center">

Built to validate prop trading systems at the level they deserve.

</div>
