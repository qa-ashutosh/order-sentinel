# Adding New Tests to order-sentinel

This guide covers how to add new test scenarios to the framework, following the conventions already established.

---

## Quick Reference: Which Test Suite?

| Scenario | Suite | File Location |
|---|---|---|
| API returns correct status code | `tests/api/` | `order-lifecycle.test.ts` |
| API response shape is correct | `tests/api/` | Any API test file |
| Order state transitions | `tests/trading-logic/` | `order-state-machine.test.ts` |
| Fill price math is correct | `tests/trading-logic/` | `order-state-machine.test.ts` |
| Risk check enforcement | `tests/trading-logic/` | `order-state-machine.test.ts` |
| NATS event fires after API call | `tests/integration/` | `nats-message-flow.test.ts` |
| NATS event payload matches DB | `tests/integration/` | `nats-message-flow.test.ts` |
| NATS message schema is valid | `tests/contracts/` | `schema-validation.test.ts` |
| API request/response schema | `tests/contracts/` | `schema-validation.test.ts` |

---

## Adding an API Test

```typescript
// tests/api/your-feature.test.ts

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import { cleanDatabase } from "../../src/db/client.js";
import { getSharedEnv } from "../../src/utils/test-env.js";
import { makeTraderRequest, makeOrderRequest } from "../../src/fixtures/factories.js";

let env: TestEnvironment;
let api: ApiClient;

beforeAll(async () => {
  env = await getSharedEnv();
  api = ApiClient.fromEnv();
});

afterAll(async () => env.teardown());
afterEach(async () => cleanDatabase(env.db));

describe("Your Feature", () => {
  it("describes what it tests", async () => {
    // 1. Set up test data
    const traderRes = await api.createTrader(makeTraderRequest());
    const traderId = traderRes.data.data.id;

    // 2. Make the API call
    const res = await api.createOrder(makeOrderRequest(traderId, {
      // Override only what matters for THIS test
      quantity: 5,
    }));

    // 3. Assert on response
    expect(res.status).toBe(201);
    expect(res.data.data.quantity).toBe(5);
  });
});
```

---

## Adding a Trading Logic Test

Trading logic tests validate business rules — state machine transitions, price math, risk limits.

```typescript
it("cannot fill more than the order quantity", async () => {
  const traderRes = await api.createTrader(makeTraderRequest());
  const traderId = traderRes.data.data.id;
  const orderRes = await api.createOrder(makeOrderRequest(traderId, { quantity: 10 }));
  const orderId = orderRes.data.data.id;

  // Attempt to inject a fill that exceeds the order quantity
  await expect(
    env.db`
      INSERT INTO fills (order_id, trader_id, symbol, side, filled_quantity, fill_price, execution_venue)
      VALUES (${orderId}, ${traderId}, 'BTCUSDT', 'BUY', 20, 60000, 'BINANCE')
    `
  ).rejects.toThrow(); // DB constraint should prevent this
});
```

---

## Adding an Integration Test

Integration tests cross service boundaries: API call → NATS event → DB state.

**The pattern is always:**
1. Subscribe BEFORE triggering the action
2. Trigger the action
3. Await the message (with timeout)
4. Assert message AND DB state

```typescript
it("publishes correct event when X happens", async () => {
  // 1. Subscribe FIRST
  const messagePromise = env.broker.waitForMessage(
    NATS_SUBJECTS.ORDER_CREATED,
    8_000 // 8 second timeout
  );

  // 2. Trigger
  await api.createOrder(makeOrderRequest(traderId));

  // 3. Await message
  const envelope = await messagePromise;

  // 4. Assert message schema
  const parsed = OrderCreatedEventSchema.safeParse(envelope.data);
  expect(parsed.success).toBe(true);

  // 5. Assert DB state matches event
  const dbOrder = await orders.findById(parsed.data!.orderId);
  expect(dbOrder.status).toBe("NEW");
});
```

---

## Adding a Contract Test

Contract tests are pure schema validation — no infra needed, runs in milliseconds.

```typescript
describe("Contract: NewEvent", () => {
  it("validates a complete new event", () => {
    const result = NewEventSchema.safeParse({
      subject: "new.subject",
      // ... valid payload
    });
    expect(result.success).toBe(true);
  });

  it("rejects event missing required field", () => {
    const result = NewEventSchema.safeParse({
      // Missing required fields
    });
    expect(result.success).toBe(false);
  });
});
```

---

## Adding a New Fixture / Factory

Add realistic trading data to `src/fixtures/factories.ts`:

```typescript
// For a new order type scenario
export function makeStopLossOrder(
  traderId: string,
  stopPrice: number,
  overrides: Partial<CreateOrderRequest> = {}
): CreateOrderRequest {
  return makeOrderRequest(traderId, {
    type: "STOP",
    price: stopPrice,
    timeInForce: "GTC",
    tags: ["stop-loss"],
    ...overrides,
  });
}
```

---

## Adding a New NATS Subject

1. Add to `NATS_SUBJECTS` in `src/types.ts`
2. Add event interface in `src/types.ts`
3. Add Zod schema in `src/contracts/schemas.ts`
4. Add contract test in `tests/contracts/schema-validation.test.ts`
5. Add integration test in `tests/integration/`

---

## Test Naming Convention

```
it("[condition], [result]")

// Good
it("rejects LIMIT order without price — 400")
it("cancels a NEW order — status transitions to CANCELLED")
it("publishes orders.rejected when daily loss limit is breached")

// Avoid
it("test order creation")
it("should work")
```

---

## DB State Setup in Tests

Sometimes you need to put the DB in a state the API doesn't expose directly. Use raw SQL:

```typescript
// Simulate an order that's been partially filled by the execution engine
await env.db`
  UPDATE orders
  SET status = 'PARTIALLY_FILLED',
      filled_quantity = 3,
      remaining_quantity = 7
  WHERE id = ${orderId}
`;
```

This is intentional. QA frameworks need to test all states, including ones that can only be reached by the internal execution engine — not just the public API.
