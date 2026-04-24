# order-sentinel — Architecture

## Overview

order-sentinel is a production-grade QA framework purpose-built for Order and Profile Management Systems in prop trading. It tests correctness at three layers simultaneously: **REST API contracts**, **NATS message flow integrity**, and **PostgreSQL state consistency**.

---

## System Under Test

The framework assumes the following OMS/PMS architecture:

```
                    ┌──────────────────────────────────────────────┐
                    │           Prop Trading OMS/PMS               │
                    │                                              │
  External ──────►  │  REST API  ──►  Order Service                │
  (Algo/Trader)     │                      │                       │
                    │                      ▼                       │
                    │             Risk Check Service ◄──────────   │
                    │                      │             NATS Bus  │
                    │                      ▼                       │
                    │           Execution Engine  ──────────────►  │
                    │                      │                       │
                    │                      ▼                       │
                    │              PostgreSQL (State)              │
                    └──────────────────────────────────────────────┘
```

**order-sentinel wraps the entire system:**

```
  order-sentinel
  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   API Client ──────────────► Mock OMS (Fastify)     │
  │                               or Real OMS Service   │
  │                                                     │
  │   NATS Adapter ◄──────────► NATS (Testcontainers)   │
  │                                                     │
  │   DB Repositories ◄───────► PostgreSQL (optional)   │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

---

## Infrastructure Strategy

order-sentinel uses **two complementary infrastructure approaches**:

### Mock OMS Server (Fastify)
A lightweight but realistic in-process OMS for the REST API layer.

- Starts automatically via `vitest globalSetup` — zero configuration
- Implements real business rules: state machine, risk checks, trader suspension
- In-memory store with `/reset` endpoint for test isolation
- Replaces the need for a real OMS when running the framework standalone
- Located in `mock/` directory

### Testcontainers (PostgreSQL + NATS)
Real Docker containers for the infrastructure layer.

- Used by integration tests that validate NATS message contracts
- Spins up real NATS 2.10 for pub/sub testing
- No mocks for the broker layer — real message delivery is verified

---

## Directory Structure

```
order-sentinel/
│
├── src/                                 # Framework source
│   ├── types.ts                         # Core domain types (Order, Fill, Trader)
│   ├── broker/                          # Message broker abstraction
│   │   ├── adapter.ts                   # BrokerAdapter interface
│   │   ├── index.ts                     # Factory + env-based creation
│   │   └── adapters/
│   │       ├── nats.adapter.ts          # Primary: NATS implementation
│   │       ├── kafka.adapter.ts         # Secondary: Kafka (interface-compatible)
│   │       └── rabbitmq.adapter.ts      # Secondary: RabbitMQ (interface-compatible)
│   ├── db/
│   │   └── client.ts                    # PostgreSQL client + test repositories
│   ├── api/
│   │   └── client.ts                    # Typed HTTP client for OMS REST API
│   ├── contracts/
│   │   └── schemas.ts                   # Zod schemas — runtime contract validation
│   ├── fixtures/
│   │   └── factories.ts                 # Realistic trading data factories
│   └── utils/
│       └── test-env.ts                  # Testcontainers environment setup (NATS)
│
├── mock/                                # Built-in Mock OMS Server
│   ├── server.ts                        # Fastify server with all OMS routes
│   ├── store.ts                         # In-memory state store
│   └── risk.ts                          # Risk check engine + state machine
│
├── tests/
│   ├── api/                             # REST API tests (uses mock OMS)
│   │   ├── order-lifecycle.test.ts
│   │   └── trader-profiles.test.ts
│   ├── trading-logic/                   # Business rule validation (uses mock OMS)
│   │   └── order-state-machine.test.ts
│   ├── integration/                     # NATS pub/sub flow tests (Testcontainers)
│   │   └── nats-message-flow.test.ts
│   └── contracts/                       # Schema validation (no infra)
│       └── schema-validation.test.ts
│
├── migrations/
│   └── runner.ts                        # SQL migrations (for real OMS DB testing)
│
├── infra/
│   └── docker-compose.yml               # Local dev infrastructure
│
└── .github/
    └── workflows/
        └── ci.yml                       # GitHub Actions CI pipeline
```

---

## Broker Abstraction Design

The broker layer is designed around a single `BrokerAdapter` interface. All test logic programs to the interface — never to a specific broker.

```typescript
interface BrokerAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  publish<T>(subject: string, data: T): Promise<void>
  subscribe<T>(subject: string, handler: MessageHandler<T>): Promise<Unsubscribe>
  waitForMessage<T>(subject: string, timeoutMs?: number): Promise<MessageEnvelope<T>>
  collectMessages<T>(subject: string, count: number, timeoutMs?: number): Promise<MessageEnvelope<T>[]>
  drain(): Promise<void>
  isConnected(): boolean
}
```

**Swapping brokers = one config change:**

```bash
# Default: NATS (primary)
BROKER_TYPE=nats NATS_URL=nats://localhost:4222

# Kafka
BROKER_TYPE=kafka KAFKA_BROKERS=localhost:9092

# RabbitMQ
BROKER_TYPE=rabbitmq RABBITMQ_URL=amqp://localhost:5672
```

---

## Mock OMS — Route Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/reset` | Reset all in-memory state (test utility) |
| POST | `/traders` | Create trader profile |
| GET | `/traders` | List all traders |
| GET | `/traders/:id` | Get trader by ID |
| PATCH | `/traders/:id` | Force-update trader state (test utility) |
| PATCH | `/traders/:id/risk-limits` | Update risk limits |
| POST | `/traders/:id/suspend` | Suspend a trader |
| POST | `/orders` | Create order (runs risk checks) |
| GET | `/orders` | List orders (filterable) |
| GET | `/orders/:id` | Get order by ID |
| PATCH | `/orders/:id` | Update order (enforces state machine) |
| PATCH | `/orders/:id?force=true` | Force-update order state (bypasses state machine) |
| DELETE | `/orders/:id` | Cancel order |
| GET | `/orders/:id/fills` | Get fills for order |

---

## Order Lifecycle State Machine

```
                    ┌─────────────────────────────┐
                    │                             │
            ┌──────►            NEW               │
            │       │  (received, not validated)  │
            │       └─────────────┬───────────────┘
            │                     │
            │             risk check passes
            │                     │
            │       ┌─────────────▼───────────────┐
            │       │                             │
            │       │         PENDING             │◄──── risk check fails ──► REJECTED
            │       │  (sent to execution venue)  │
            │       └─────────────┬───────────────┘
            │                     │
            │             partial execution
            │                     │
            │       ┌─────────────▼───────────────┐
            │       │                             │
            │       │      PARTIALLY_FILLED       ├──── cancel ──► CANCELLED
            │       │  (some quantity executed)   │
            │       └─────────────┬───────────────┘
            │                     │
            │              full execution
            │                     │
            │       ┌─────────────▼───────────────┐
            │       │                             │
            │       │          FILLED             │
            │       │        (complete)           │
            │       └─────────────────────────────┘
            │
            │  NEW/PENDING ──► CANCELLED (manual cancel)
            │  NEW/PENDING ──► EXPIRED (time-in-force elapsed)
```

---

## NATS Subject Map

| Subject | Published By | Consumed By |
|---|---|---|
| `orders.created` | Order Service | Risk Service, Audit |
| `orders.updated` | Order Service | Profile Service |
| `orders.cancelled` | Order Service | Profile Service |
| `orders.rejected` | Risk Service | Audit, Notification |
| `orders.filled` | Execution Engine | Profile Service, Audit |
| `orders.partially_filled` | Execution Engine | Order Service |
| `fills.executed` | Execution Engine | Audit |
| `risk.check.requested` | Order Service | Risk Service |
| `risk.check.passed` | Risk Service | Order Service |
| `risk.check.failed` | Risk Service | Order Service |
| `traders.suspended` | Risk/Admin Service | Order Service |
| `traders.limit.breached` | Risk Service | Notification, Admin |
