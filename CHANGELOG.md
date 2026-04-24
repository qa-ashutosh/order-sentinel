# Changelog

All notable changes to order-sentinel are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2024-04-24

> First public release. The entire framework — core infrastructure, mock OMS, test suites,
> contracts, documentation — was built and shipped as a single cohesive commit.

### Core Framework

- `BrokerAdapter` interface — decoupled message broker abstraction, programs to interface not implementation
- `NatsAdapter` — primary NATS implementation with `waitForMessage` and `collectMessages` helpers
- `KafkaAdapter` — interface-compatible Kafka stub (drop-in ready for kafkajs implementation)
- `RabbitMQAdapter` — interface-compatible RabbitMQ stub (drop-in ready for amqplib implementation)
- `BrokerFactory` — environment-driven broker instantiation via `BROKER_TYPE=nats|kafka|rabbitmq`
- `ApiClient` — fully typed Axios HTTP client covering all OMS/PMS REST endpoints
- PostgreSQL client with `OrderRepository`, `TraderRepository`, `AuditRepository`
- `cleanDatabase` and `withRollback` test isolation utilities for DB-level tests

### Domain Types & Contracts

- Full TypeScript domain model: `Order`, `Fill`, `TraderProfile`, `RiskLimits`
- `OrderStatus` state machine: NEW → PENDING → PARTIALLY_FILLED → FILLED / CANCELLED / REJECTED / EXPIRED
- `TimeInForce` types: DAY, GTC, IOC, FOK
- `RejectionReason` enum: 9 typed rejection codes
- Zod schemas for all API request/response shapes with runtime validation
- Zod schemas for all NATS event types
- `NATS_SUBJECTS` constant map — typed subject registry preventing string typos

### Mock OMS Server (Fastify)

- `mock/server.ts` — Fastify-based mock OMS implementing all REST endpoints the test suite calls
- `mock/store.ts` — In-memory state store with full CRUD for traders, orders, fills, and audit log
- `mock/risk.ts` — Risk engine simulating real prop trading validation: position limits, daily loss limits, symbol whitelists, trader suspension, open order caps
- State machine enforcement on `PATCH /orders/:id` with `?force=true` bypass for test data setup
- `/reset` endpoint for clean state between test runs
- `PATCH /traders/:id` for direct state injection in tests
- `vitest.setup.ts` — global lifecycle hook that starts mock OMS before suite and stops it after
- `vitest.config.ts` — `fileParallelism: false` ensures test files run sequentially, preventing mock store state bleed

### Test Fixtures

- `makeTraderRequest`, `makeTraderProfile` — trader data factories with sensible defaults
- `makeOrderRequest`, `makeMarketOrder`, `makeOrder` — order factories covering all order types
- `makeLimitBreachOrder` — generates orders that intentionally breach position limits
- `makePartialFills` — realistic 30/40/30 partial fill simulation
- `RISK_LIMIT_TIERS` — JUNIOR, STANDARD, SENIOR, RESTRICTED preset risk limit configurations
- `SCENARIOS` — ready-made composite test scenarios (ALGO_TRADER_BTC, JUNIOR_FX_TRADER, SUSPENDED_TRADER)

### Test Suites

- `tests/contracts/schema-validation.test.ts` — 23 Zod contract tests, zero infrastructure required
- `tests/api/order-lifecycle.test.ts` — Order CRUD, cancellation, fill retrieval via mock OMS
- `tests/api/trader-profiles.test.ts` — Profile management, risk limits, suspension via mock OMS
- `tests/trading-logic/order-state-machine.test.ts` — State transitions, fill accuracy, risk checks, TIF behaviour
- `tests/integration/nats-message-flow.test.ts` — Real NATS pub/sub via Testcontainers (requires Docker)

### Infrastructure

- Database migrations with transaction safety (5 migrations, versions 1–5)
- Auto-audit trigger: every order status change logged to `order_audit_log`
- DB constraints enforcing `filled + remaining = quantity` and `LIMIT/STOP require price`
- `infra/docker-compose.yml` for local PostgreSQL + NATS development environment
- GitHub Actions CI: 6-stage pipeline (lint → contracts → trading-logic → api → integration → coverage)

### npm Scripts

- `npm test` — full suite (contracts + api + trading + integration)
- `npm run test:contracts` — schema tests only, no infrastructure
- `npm run test:api` — API tests, mock OMS auto-starts
- `npm run test:trading` — trading logic tests, mock OMS auto-starts
- `npm run test:integration` — NATS tests, requires Docker
- `npm run test:coverage` — full suite with v8 coverage report
- `npm run mock` — start mock OMS standalone on port 3000 for manual testing

### Documentation

- `README.md` — project overview, quick start, architecture summary
- `docs/ARCHITECTURE.md` — system design, mock OMS route reference, state machine diagrams, NATS subject map
- `docs/MOCK-OMS-API.md` — complete REST API reference with curl examples for manual testing
- `docs/TEST-GUIDE.md` — deep-dive into each test suite with extension and contribution guide
- `CHANGELOG.md` — this file

---

## Roadmap

### [1.2.0] — Planned

- [ ] Performance baseline tests — order creation latency under load
- [ ] Duplicate order detection tests (`DUPLICATE_ORDER` rejection reason)
- [ ] Market hours boundary tests (`MARKET_CLOSED` rejection)
- [ ] Full Kafka adapter implementation (kafkajs)
- [ ] Full RabbitMQ adapter implementation (amqplib)
- [ ] Load test suite — concurrent order submission stress tests
