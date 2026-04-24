# order-sentinel — Test Guide

This document explains what each test suite covers, what it validates, and how to extend the framework — whether you're reviewing the project, onboarding as a contributor, or building new scenarios on top of it.

---

## Overview

```
tests/
├── contracts/                  No infra — runs in ~2s
│   └── schema-validation.test.ts
├── api/                        Mock OMS auto-starts — runs in ~5s
│   ├── order-lifecycle.test.ts
│   └── trader-profiles.test.ts
├── trading-logic/              Mock OMS auto-starts — runs in ~5s
│   └── order-state-machine.test.ts
└── integration/                Requires Docker — runs in ~30s
    └── nats-message-flow.test.ts
```

Run them individually:

```bash
npm run test:contracts
npm run test:api
npm run test:trading
npm run test:integration   # Docker required
npm test                   # all suites
```

---

## Suite 1 — Contract Tests

**File:** `tests/contracts/schema-validation.test.ts`
**Infrastructure:** None
**What it validates:** Every Zod schema that defines the shape of an API request, API response, or NATS event

### What these tests do

The contract tests are the fastest and most fundamental suite. They validate that the Zod schemas in `src/contracts/schemas.ts` correctly accept valid data and reject invalid data. No server, no Docker, no network.

A contract test looks like this:

```typescript
it("rejects LIMIT order without price", () => {
  const result = CreateOrderSchema.safeParse({
    traderId: "valid-uuid",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",  // LIMIT requires price
    quantity: 1,
    timeInForce: "GTC",
    // price is missing — should fail
  });
  expect(result.success).toBe(false);
});
```

### Why they matter

In a real OMS integration, the service you're testing will publish NATS events and return HTTP responses. If your Zod schemas are wrong, every other test suite silently tests the wrong thing. Contract tests catch schema drift early and without any infrastructure.

### What's covered

- `CreateOrderSchema` — 8 tests covering valid orders, missing price on LIMIT, invalid symbols, zero quantity
- `OrderSchema` — response shape validation, `filled + remaining = quantity` invariant
- `CreateTraderSchema` — valid creation, invalid email, risk limit bounds
- `OrderCreatedEventSchema` — NATS event structure, required fields, wrong subject literals
- `OrderFilledEventSchema` — fill price must be positive
- `OrderRejectedEventSchema` — all 9 rejection reason codes accepted, unknown codes rejected
- `TraderLimitBreachedEventSchema` — all 3 breach types validated
- `ApiErrorResponseSchema` — error envelope shape

### How to extend

To add a contract test for a new schema:

1. Add the Zod schema to `src/contracts/schemas.ts`
2. Add tests in `tests/contracts/schema-validation.test.ts`
3. Test at least: a valid payload, a missing required field, an invalid field value

```typescript
describe("Contract: NewEventSchema", () => {
  it("accepts a valid payload", () => {
    const result = NewEventSchema.safeParse({ /* valid data */ });
    expect(result.success).toBe(true);
  });

  it("rejects missing required field", () => {
    const result = NewEventSchema.safeParse({ /* missing field */ });
    expect(result.success).toBe(false);
  });
});
```

---

## Suite 2 — API Tests

**Files:** `tests/api/order-lifecycle.test.ts`, `tests/api/trader-profiles.test.ts`
**Infrastructure:** Mock OMS (starts automatically)
**What it validates:** Every REST endpoint — correct status codes, response shapes, and error cases

### What these tests do

API tests send real HTTP requests to the mock OMS and assert on the responses. They validate the full request/response cycle including HTTP status codes, response body shape, and error handling.

The mock OMS starts automatically before the suite runs (via `vitest.setup.ts`) and resets state before each test (via `beforeEach`). No manual setup needed.

### Order Lifecycle tests cover

- Creating LIMIT and MARKET orders — verifies `status: "NEW"`, correct field mapping
- Validation errors — missing traderId, LIMIT without price, zero quantity, negative price
- Retrieving orders by ID and filtering by traderId/status
- Cancelling orders — verifies terminal state transition
- Double-cancel protection — second cancel returns 409
- Cancelling FILLED orders — returns 409 Conflict
- Order fills endpoint — returns empty array for unfilled orders

### Trader Profile tests cover

- Creating traders — verifies `status: "PENDING_APPROVAL"`, correct schema
- Unique email enforcement — duplicate returns 409
- Validation errors — invalid email format, negative capital
- Retrieving traders by ID
- Risk limit updates — partial updates, zero-value rejection
- Symbol restriction — `allowedSymbols` blocks orders on other symbols after update
- Suspension — ACTIVE → SUSPENDED transition
- Suspended trader order rejection — 422 TRADER_SUSPENDED
- Double-suspension protection — 409

### How state setup works

Tests that need a trader in `ACTIVE` status (which is required for order placement) use a shared helper:

```typescript
async function activeTrader(overrides = {}) {
  const res = await api.createTrader(makeTraderRequest(overrides));
  const id = res.data.data.id;
  await http.patch(`${MOCK}/traders/${id}`, { status: "ACTIVE" });
  return id;
}
```

The `PATCH /traders/:id` route is a test utility — it bypasses business logic for direct state injection.

### How to add an API test

1. Identify the endpoint and scenario
2. Add the test in the appropriate file inside the relevant `describe` block
3. Use `activeTrader()` helper if the test needs an ACTIVE trader
4. Call `http.patch('...?force=true')` to set up specific order states

```typescript
it("returns orders sorted by createdAt descending", async () => {
  const traderId = await activeTrader();
  await api.createOrder(makeOrderRequest(traderId, { symbol: "BTCUSDT" }));
  await api.createOrder(makeOrderRequest(traderId, { symbol: "ETHUSDT" }));

  const res = await api.listOrders({ traderId });
  expect(res.data.data[0].symbol).toBe("ETHUSDT"); // most recent first
});
```

---

## Suite 3 — Trading Logic Tests

**File:** `tests/trading-logic/order-state-machine.test.ts`
**Infrastructure:** Mock OMS (starts automatically)
**What it validates:** Business rules — state machine correctness, fill accuracy, risk checks, time-in-force behaviour

### What these tests do

These tests go deeper than the API tests — they validate the correctness of trading business logic rather than just HTTP mechanics. The mock OMS enforces real rules, and these tests probe those rules deliberately.

### State Machine tests cover

- Full valid lifecycle: NEW → PENDING → FILLED
- Illegal backward transition: FILLED → NEW returns 409
- No resurrection: CANCELLED → PENDING returns 409
- PARTIALLY_FILLED → FILLED transition
- PARTIALLY_FILLED → CANCELLED (mid-fill cancellation)

### Fill Accuracy tests cover

- Weighted average fill price math: `Σ(qty × price) / Σ(qty)` calculated explicitly
- Quantity invariant: `filledQuantity + remainingQuantity === originalQuantity` across partial fills
- LIMIT BUY fill price constraint: fill prices must not exceed the limit price

### Risk Check tests cover

- POSITION_LIMIT_BREACH: order quantity exceeds `maxOrderSize`
- DAILY_LOSS_LIMIT_REACHED: trader's `dailyPnL` at or below negative limit
- Max open orders: creating order when at `maxOpenOrders` limit
- Happy path: order accepted when all limits are within bounds
- INVALID_SYMBOL: order on symbol not in `allowedSymbols`

### Time-in-Force tests cover

- IOC: partial fill accepted, remainder cancelled
- FOK: full cancel when full fill impossible
- DAY: transitions to EXPIRED after session close

### How to add a trading logic test

Risk check tests follow a clear pattern — set up the trader in the specific risk state, try to place an order, assert the rejection reason:

```typescript
it("rejects order when trader has exceeded max position size", async () => {
  const traderId = await activeTrader({
    riskLimits: { ...RISK_LIMIT_TIERS.STANDARD, maxPositionSize: 10 }
  });

  // Simulate existing position
  await http.patch(`${MOCK}/traders/${traderId}`, { capitalUsed: 10 });

  const res = await api.createOrder(makeOrderRequest(traderId, { quantity: 1 }));
  expect(res.status).toBe(422);
  expect(res.data.code).toBe("POSITION_LIMIT_BREACH");
});
```

---

## Suite 4 — Integration Tests

**File:** `tests/integration/nats-message-flow.test.ts`
**Infrastructure:** Docker (Testcontainers spins up real NATS)
**What it validates:** NATS pub/sub mechanics and message contract correctness on a real broker

### What these tests do

Integration tests use Testcontainers to spin up a real NATS 2.10 server in Docker. They publish events and subscribe to receive them, validating that the message schemas are correct and delivery works end-to-end.

These tests are deliberately isolated from the OMS API layer — they focus purely on the broker contract. The question they answer is: "If an OMS publishes this event, will consumers receive the right data?"

### What's covered

**`orders.created` events:**
- Publishes a full `OrderCreatedEvent` and receives it back via subscription
- Validates the full schema with `OrderCreatedEventSchema`
- Verifies all field values match exactly what was published

**`orders.filled` events:**
- Publishes an `OrderFilledEvent` and validates schema
- Collects 3 partial fill events in sequence, verifies total filled quantity

**`orders.rejected` events:**
- Publishes with each of the 5 rejection reasons and validates all are accepted by schema

**`traders.limit.breached` events:**
- Validates all 3 breach types: DAILY_LOSS, POSITION_SIZE, ORDER_COUNT
- Verifies `currentValue > limitValue` invariant

### How Testcontainers works here

```typescript
beforeAll(async () => {
  env = await createTestEnvironment();
  // Starts real NATS in Docker, connects the broker adapter
}, 120_000);

afterAll(async () => {
  await env.teardown();
  // Stops Docker containers
});
```

`createTestEnvironment()` is in `src/utils/test-env.ts`. It starts NATS via Testcontainers and returns a configured `BrokerAdapter` instance.

### How to add an integration test

```typescript
it("publishes and receives a valid orders.updated event", async () => {
  const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_UPDATED, 5_000);

  await env.broker.publish(NATS_SUBJECTS.ORDER_UPDATED, {
    subject: NATS_SUBJECTS.ORDER_UPDATED,
    orderId: randomUUID(),
    traderId: randomUUID(),
    status: "PENDING",
    timestamp: new Date().toISOString(),
  });

  const envelope = await messagePromise;
  const parsed = OrderUpdatedEventSchema.safeParse(envelope.data);
  expect(parsed.success).toBe(true);
});
```

Steps:
1. Add the new subject to `NATS_SUBJECTS` in `src/types.ts`
2. Add the Zod schema to `src/contracts/schemas.ts`
3. Add a contract test in `tests/contracts/schema-validation.test.ts`
4. Add the integration test above

---

## Contributing to order-sentinel

### Project structure

```
src/
├── types.ts              Domain types — edit here to add new Order/Trader fields
├── broker/               Broker layer — add new adapters here
├── contracts/schemas.ts  Zod schemas — add new event/request schemas here
├── api/client.ts         HTTP client — add new endpoint methods here
├── fixtures/factories.ts Test factories — add new scenario builders here
└── utils/test-env.ts     Testcontainers setup — edit for new infra

mock/
├── server.ts             Add new routes here
├── store.ts              Add new entity storage here
└── risk.ts               Edit risk check logic and state machine here

tests/
├── contracts/            Schema tests — one describe block per schema
├── api/                  HTTP endpoint tests
├── trading-logic/        Business rule tests
└── integration/          Broker pub/sub tests
```

### Adding a new order type

1. Add the type to `OrderType` union in `src/types.ts`
2. Update `CreateOrderSchema` in `src/contracts/schemas.ts` to include the new type
3. Add validation logic to `mock/server.ts` if the new type has special rules (e.g. STOP orders need a stop price)
4. Add contract tests for the new type
5. Add API tests verifying the new type is created correctly

### Adding a new rejection reason

1. Add to `RejectionReason` union in `src/types.ts`
2. Add the check to `runRiskChecks()` in `mock/risk.ts`
3. Add a contract test verifying the schema accepts the new reason
4. Add a trading logic test that triggers the new rejection

### Adding a new broker adapter

1. Create `src/broker/adapters/yourbroker.adapter.ts`
2. Implement the `BrokerAdapter` interface (all methods required)
3. Add the `BROKER_TYPE=yourbroker` case to `src/broker/index.ts`
4. All existing integration tests will work unchanged — they program to the interface

```typescript
export class YourBrokerAdapter implements BrokerAdapter {
  async connect(): Promise<void> { ... }
  async disconnect(): Promise<void> { ... }
  async publish<T>(subject: string, data: T): Promise<void> { ... }
  async subscribe<T>(subject: string, handler: MessageHandler<T>): Promise<Unsubscribe> { ... }
  async waitForMessage<T>(subject: string, timeoutMs = 5000): Promise<MessageEnvelope<T>> { ... }
  async collectMessages<T>(subject: string, count: number, timeoutMs = 10000): Promise<MessageEnvelope<T>[]> { ... }
  async drain(): Promise<void> { ... }
  isConnected(): boolean { ... }
}
```

### Code style

- TypeScript strict mode — no `any` except where explicitly required for Fastify internals
- All test utilities use `axios.create({ validateStatus: () => true })` — never let axios throw on 4xx/5xx
- Test data through factories only — never hardcode UUIDs or emails in test bodies
- One `describe` block per endpoint or feature area
- `beforeEach` always resets mock OMS state via `await http.post('/reset')`

### Running typecheck before committing

```bash
npm run typecheck
```

All commits should pass typecheck with zero errors.
