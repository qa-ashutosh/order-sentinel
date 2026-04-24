// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Integration Tests: NATS Message Flow
//
// Tests message broker contracts and event flow using real NATS
// (spun up via Testcontainers). Validates that message schemas conform
// to contracts and that pub/sub mechanics work correctly.
//
// These tests focus purely on the broker layer — no OMS API calls needed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTestEnvironment, type TestEnvironment } from "../../src/utils/test-env.js";
import { NATS_SUBJECTS } from "../../src/types.js";
import {
  OrderCreatedEventSchema,
  OrderFilledEventSchema,
  OrderRejectedEventSchema,
  TraderLimitBreachedEventSchema,
} from "../../src/contracts/schemas.js";
import { randomUUID } from "crypto";

let env: TestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env.teardown();
});

afterEach(async () => {
  await env.broker.drain();
});

const makeTraderId = () => randomUUID();
const makeOrderId = () => randomUUID();

// ── orders.created ────────────────────────────────────────────────────────────

describe("NATS: orders.created — Order Creation Events", () => {
  it("publishes and receives a valid orders.created event", async () => {
    const orderId = makeOrderId();
    const traderId = makeTraderId();

    const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_CREATED, 5_000);

    await env.broker.publish(NATS_SUBJECTS.ORDER_CREATED, {
      subject: NATS_SUBJECTS.ORDER_CREATED,
      orderId,
      traderId,
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      price: 60_000,
      timestamp: new Date().toISOString(),
    });

    const envelope = await messagePromise;
    const parsed = OrderCreatedEventSchema.safeParse(envelope.data);
    expect(parsed.success, `Schema error: ${JSON.stringify(parsed.error)}`).toBe(true);
    expect(parsed.data!.orderId).toBe(orderId);
    expect(parsed.data!.traderId).toBe(traderId);
    expect(parsed.data!.symbol).toBe("BTCUSDT");
    expect(parsed.data!.quantity).toBe(2);
  });

  it("event fields match exactly what was published", async () => {
    const payload = {
      subject: NATS_SUBJECTS.ORDER_CREATED,
      orderId: makeOrderId(),
      traderId: makeTraderId(),
      symbol: "ETHUSDT",
      side: "SELL" as const,
      type: "MARKET" as const,
      quantity: 5,
      timestamp: new Date().toISOString(),
    };

    const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_CREATED, 5_000);
    await env.broker.publish(NATS_SUBJECTS.ORDER_CREATED, payload);
    const envelope = await messagePromise;
    const event = envelope.data as typeof payload;

    expect(event.orderId).toBe(payload.orderId);
    expect(event.traderId).toBe(payload.traderId);
    expect(event.symbol).toBe(payload.symbol);
    expect(event.side).toBe(payload.side);
    expect(event.quantity).toBe(payload.quantity);
  });
});

// ── orders.filled ─────────────────────────────────────────────────────────────

describe("NATS: orders.filled — Fill Execution Events", () => {
  it("publishes and receives a valid orders.filled event", async () => {
    const orderId = makeOrderId();
    const traderId = makeTraderId();

    const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_FILLED, 5_000);

    await env.broker.publish(NATS_SUBJECTS.ORDER_FILLED, {
      subject: NATS_SUBJECTS.ORDER_FILLED,
      orderId,
      traderId,
      symbol: "BTCUSDT",
      side: "BUY",
      filledQuantity: 5,
      averageFillPrice: 60_000,
      timestamp: new Date().toISOString(),
    });

    const envelope = await messagePromise;
    const parsed = OrderFilledEventSchema.safeParse(envelope.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.filledQuantity).toBe(5);
    expect(parsed.data!.averageFillPrice).toBe(60_000);
  });

  it("collects multiple partial fill events", async () => {
    const orderId = makeOrderId();
    const traderId = makeTraderId();

    const eventsPromise = env.broker.collectMessages(
      NATS_SUBJECTS.ORDER_PARTIALLY_FILLED,
      3,
      10_000
    );

    const partialFills = [
      { qty: 3, price: 60_100 },
      { qty: 3, price: 60_050 },
      { qty: 3, price: 59_980 },
    ];

    for (const fill of partialFills) {
      await env.broker.publish(NATS_SUBJECTS.ORDER_PARTIALLY_FILLED, {
        subject: NATS_SUBJECTS.ORDER_PARTIALLY_FILLED,
        orderId,
        traderId,
        symbol: "BTCUSDT",
        side: "BUY",
        filledQuantity: fill.qty,
        fillPrice: fill.price,
        timestamp: new Date().toISOString(),
      });
    }

    const events = await eventsPromise;
    expect(events.length).toBe(3);

    const totalFilled = events.reduce((s, e) => s + (e.data as any).filledQuantity, 0);
    expect(totalFilled).toBe(9);
  });
});

// ── orders.rejected ───────────────────────────────────────────────────────────

describe("NATS: orders.rejected — Risk Check Failure Events", () => {
  it("publishes and receives a valid orders.rejected event", async () => {
    const orderId = makeOrderId();
    const traderId = makeTraderId();

    const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_REJECTED, 5_000);

    await env.broker.publish(NATS_SUBJECTS.ORDER_REJECTED, {
      subject: NATS_SUBJECTS.ORDER_REJECTED,
      orderId,
      traderId,
      reason: "POSITION_LIMIT_BREACH",
      timestamp: new Date().toISOString(),
    });

    const envelope = await messagePromise;
    const parsed = OrderRejectedEventSchema.safeParse(envelope.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.reason).toBe("POSITION_LIMIT_BREACH");
  });

  it("validates all rejection reason types are accepted by schema", async () => {
    const reasons = [
      "INSUFFICIENT_CAPITAL",
      "POSITION_LIMIT_BREACH",
      "DAILY_LOSS_LIMIT_REACHED",
      "INVALID_SYMBOL",
      "TRADER_SUSPENDED",
    ] as const;

    for (const reason of reasons) {
      const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.ORDER_REJECTED, 5_000);
      await env.broker.publish(NATS_SUBJECTS.ORDER_REJECTED, {
        subject: NATS_SUBJECTS.ORDER_REJECTED,
        orderId: makeOrderId(),
        traderId: makeTraderId(),
        reason,
        timestamp: new Date().toISOString(),
      });
      const envelope = await messagePromise;
      const parsed = OrderRejectedEventSchema.safeParse(envelope.data);
      expect(parsed.success, `${reason} should be valid`).toBe(true);
    }
  });
});

// ── traders.limit.breached ────────────────────────────────────────────────────

describe("NATS: traders.limit.breached — Risk Limit Breach Notifications", () => {
  it("publishes and receives a valid limit breach event", async () => {
    const traderId = makeTraderId();

    const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.TRADER_LIMIT_BREACHED, 5_000);

    await env.broker.publish(NATS_SUBJECTS.TRADER_LIMIT_BREACHED, {
      subject: NATS_SUBJECTS.TRADER_LIMIT_BREACHED,
      traderId,
      breachType: "DAILY_LOSS",
      currentValue: 55_000,
      limitValue: 50_000,
      timestamp: new Date().toISOString(),
    });

    const envelope = await messagePromise;
    const parsed = TraderLimitBreachedEventSchema.safeParse(envelope.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.traderId).toBe(traderId);
    expect(parsed.data!.currentValue).toBeGreaterThan(parsed.data!.limitValue);
  });

  it("validates all breach types", async () => {
    const breachTypes = ["DAILY_LOSS", "POSITION_SIZE", "ORDER_COUNT"] as const;

    for (const breachType of breachTypes) {
      const messagePromise = env.broker.waitForMessage(NATS_SUBJECTS.TRADER_LIMIT_BREACHED, 5_000);
      await env.broker.publish(NATS_SUBJECTS.TRADER_LIMIT_BREACHED, {
        subject: NATS_SUBJECTS.TRADER_LIMIT_BREACHED,
        traderId: makeTraderId(),
        breachType,
        currentValue: 55_000,
        limitValue: 50_000,
        timestamp: new Date().toISOString(),
      });
      const envelope = await messagePromise;
      const parsed = TraderLimitBreachedEventSchema.safeParse(envelope.data);
      expect(parsed.success, `${breachType} should be valid`).toBe(true);
    }
  });
});
