// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Contract Tests
//
// Contract tests validate that message schemas and API response shapes
// remain stable. These are the first tests to fail when a service changes
// its output format without updating consumers.
//
// In a microservices trading system, contract drift is dangerous:
//   - Order service changes "quantity" to "qty"
//   - Risk service silently reads undefined → approves everything
//   - Money is lost before anyone notices
//
// These tests are the canary.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  CreateOrderSchema,
  OrderSchema,
  FillSchema,
  CreateTraderSchema,
  TraderProfileSchema,
  OrderCreatedEventSchema,
  OrderFilledEventSchema,
  OrderRejectedEventSchema,
  RiskCheckRequestedEventSchema,
  TraderLimitBreachedEventSchema,
  ApiErrorSchema,
} from "../../src/contracts/schemas.js";

// ── Order API Contracts ───────────────────────────────────────────────────────

describe("Contract: CreateOrder Request", () => {
  it("accepts a valid LIMIT BUY order", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1.5,
      price: 60000,
      timeInForce: "GTC",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid MARKET SELL order (no price)", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "ETHUSDT",
      side: "SELL",
      type: "MARKET",
      quantity: 10,
      timeInForce: "IOC",
    });
    expect(result.success).toBe(true);
  });

  it("rejects LIMIT order without price", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      timeInForce: "GTC",
      // price missing
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/price/i);
  });

  it("rejects non-UUID traderId", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "not-a-uuid",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 60000,
      timeInForce: "GTC",
    });
    expect(result.success).toBe(false);
  });

  it("rejects lowercase symbol", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "btcusdt", // must be uppercase
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 60000,
      timeInForce: "GTC",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero or negative quantity", () => {
    for (const quantity of [0, -1, -0.001]) {
      const result = CreateOrderSchema.safeParse({
        traderId: "550e8400-e29b-41d4-a716-446655440000",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity,
        timeInForce: "IOC",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects invalid side value", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "LONG", // invalid — must be BUY or SELL
      type: "MARKET",
      quantity: 1,
      timeInForce: "IOC",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timeInForce", () => {
    const result = CreateOrderSchema.safeParse({
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      timeInForce: "NEVER", // invalid
    });
    expect(result.success).toBe(false);
  });
});

describe("Contract: Order Response", () => {
  it("validates a complete FILLED order response", () => {
    const result = OrderSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 10,
      filledQuantity: 10,
      remainingQuantity: 0,
      price: 60000,
      averageFillPrice: 59990.5,
      status: "FILLED",
      timeInForce: "GTC",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects order where filled + remaining != quantity", () => {
    const result = OrderSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 10,
      filledQuantity: 7,
      remainingQuantity: 5, // 7 + 5 ≠ 10 — data corruption
      price: 60000,
      status: "PARTIALLY_FILLED",
      timeInForce: "GTC",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

// ── Trader Profile Contracts ──────────────────────────────────────────────────

describe("Contract: CreateTrader Request", () => {
  it("accepts valid trader creation payload", () => {
    const result = CreateTraderSchema.safeParse({
      name: "Algo BTC Desk",
      email: "algo.btc@propfirm.internal",
      capitalAllocated: 500_000,
      riskLimits: {
        maxOrderSize: 1000,
        maxPositionSize: 5000,
        maxDailyLoss: 250_000,
        maxOpenOrders: 100,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects trader with invalid email", () => {
    const result = CreateTraderSchema.safeParse({
      name: "Bad Trader",
      email: "not-valid",
      capitalAllocated: 10_000,
      riskLimits: {
        maxOrderSize: 10,
        maxPositionSize: 50,
        maxDailyLoss: 5000,
        maxOpenOrders: 5,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects risk limits with maxOpenOrders > 1000", () => {
    const result = CreateTraderSchema.safeParse({
      name: "Unlimited Trader",
      email: "unlimited@propfirm.internal",
      capitalAllocated: 1_000_000,
      riskLimits: {
        maxOrderSize: 1000,
        maxPositionSize: 5000,
        maxDailyLoss: 250_000,
        maxOpenOrders: 9999, // exceeds system cap
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── NATS Event Contracts ──────────────────────────────────────────────────────

describe("Contract: NATS orders.created Event", () => {
  it("validates a complete order created event", () => {
    const result = OrderCreatedEventSchema.safeParse({
      subject: "orders.created",
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      price: 60000,
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects event with wrong subject literal", () => {
    const result = OrderCreatedEventSchema.safeParse({
      subject: "orders.updated", // wrong subject
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects event with missing timestamp", () => {
    const result = OrderCreatedEventSchema.safeParse({
      subject: "orders.created",
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      // timestamp missing
    });
    expect(result.success).toBe(false);
  });
});

describe("Contract: NATS orders.filled Event", () => {
  it("validates a complete order filled event", () => {
    const result = OrderFilledEventSchema.safeParse({
      subject: "orders.filled",
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      filledQuantity: 5,
      averageFillPrice: 60012.5,
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects fill event with zero averageFillPrice", () => {
    const result = OrderFilledEventSchema.safeParse({
      subject: "orders.filled",
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      symbol: "BTCUSDT",
      side: "BUY",
      filledQuantity: 5,
      averageFillPrice: 0, // invalid — price must be positive
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("Contract: NATS orders.rejected Event", () => {
  it("validates rejection with all known rejection reasons", () => {
    const validReasons = [
      "INSUFFICIENT_CAPITAL",
      "POSITION_LIMIT_BREACH",
      "DAILY_LOSS_LIMIT_REACHED",
      "INVALID_SYMBOL",
      "MARKET_CLOSED",
      "PRICE_DEVIATION_TOO_HIGH",
      "DUPLICATE_ORDER",
      "TRADER_SUSPENDED",
      "RISK_CHECK_TIMEOUT",
    ];

    for (const reason of validReasons) {
      const result = OrderRejectedEventSchema.safeParse({
        subject: "orders.rejected",
        orderId: "550e8400-e29b-41d4-a716-446655440001",
        traderId: "550e8400-e29b-41d4-a716-446655440000",
        reason,
        timestamp: new Date().toISOString(),
      });
      expect(result.success, `${reason} should be valid`).toBe(true);
    }
  });

  it("rejects unknown rejection reason", () => {
    const result = OrderRejectedEventSchema.safeParse({
      subject: "orders.rejected",
      orderId: "550e8400-e29b-41d4-a716-446655440001",
      traderId: "550e8400-e29b-41d4-a716-446655440000",
      reason: "UNKNOWN_REASON", // not in the enum
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("Contract: NATS traders.limit.breached Event", () => {
  it("validates all breach types", () => {
    const breachTypes = ["DAILY_LOSS", "POSITION_SIZE", "ORDER_COUNT"] as const;

    for (const breachType of breachTypes) {
      const result = TraderLimitBreachedEventSchema.safeParse({
        subject: "traders.limit.breached",
        traderId: "550e8400-e29b-41d4-a716-446655440000",
        breachType,
        currentValue: 55_000,
        limitValue: 50_000,
        timestamp: new Date().toISOString(),
      });
      expect(result.success, `${breachType} should be valid`).toBe(true);
    }
  });
});

// ── API Error Contract ────────────────────────────────────────────────────────

describe("Contract: API Error Response", () => {
  it("validates a well-formed error response", () => {
    const result = ApiErrorSchema.safeParse({
      code: "POSITION_LIMIT_BREACH",
      message: "Order quantity 200 exceeds maximum order size of 10",
      details: { requestedQuantity: 200, maxAllowed: 10 },
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects error without code field", () => {
    const result = ApiErrorSchema.safeParse({
      message: "Something went wrong",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
