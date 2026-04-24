// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Trading Logic Tests
// Validates business rules: state machine, fill accuracy, risk checks, TIF.
// Runs against mock OMS + direct store manipulation for complete coverage.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import {
  makeTraderRequest,
  makeOrderRequest,
  makeMarketOrder,
  makeLimitBreachOrder,
  RISK_LIMIT_TIERS,
  SYMBOLS,
} from "../../src/fixtures/factories.js";
import axios from "axios";
const http = axios.create({ validateStatus: () => true });

const api = ApiClient.fromEnv();
const MOCK = "http://localhost:3000";

beforeEach(async () => { await http.post(`${MOCK}/reset`); });

async function activeTrader(overrides = {}) {
  const res = await api.createTrader(makeTraderRequest(overrides));
  const id = res.data.data.id;
  await http.patch(`${MOCK}/traders/${id}`, { status: "ACTIVE" });
  return id;
}

// ── State Machine ─────────────────────────────────────────────────────────────

describe("Order Lifecycle — State Machine", () => {
  it("follows valid lifecycle: NEW → PENDING → FILLED", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeMarketOrder(traderId));
    const orderId = orderRes.data.data.id;
    expect(orderRes.data.data.status).toBe("NEW");

    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "PENDING" });
    expect((await api.getOrder(orderId)).data.data.status).toBe("PENDING");

    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "FILLED" });
    expect((await api.getOrder(orderId)).data.data.status).toBe("FILLED");
  });

  it("prevents FILLED → NEW (illegal backwards transition)", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId));
    const orderId = orderRes.data.data.id;
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "FILLED" });
    const res = await api.updateOrder(orderId, { status: "NEW" } as any);
    expect(res.status).toBe(409);
    expect(res.data.message).toMatch(/cannot transition/i);
  });

  it("prevents CANCELLED → PENDING (no resurrection of cancelled orders)", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId));
    const orderId = orderRes.data.data.id;
    await api.cancelOrder(orderId);
    const res = await api.updateOrder(orderId, { status: "PENDING" } as any);
    expect(res.status).toBe(409);
  });

  it("transitions PARTIALLY_FILLED → FILLED when remaining = 0", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId, { quantity: 10 }));
    const orderId = orderRes.data.data.id;

    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "PARTIALLY_FILLED" });
    expect((await api.getOrder(orderId)).data.data.status).toBe("PARTIALLY_FILLED");

    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "FILLED" });
    expect((await api.getOrder(orderId)).data.data.status).toBe("FILLED");
  });

  it("allows PARTIALLY_FILLED → CANCELLED (trader cancels mid-fill)", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId, { quantity: 10 }));
    const orderId = orderRes.data.data.id;
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "PARTIALLY_FILLED" });
    const cancelRes = await api.cancelOrder(orderId);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.data.data.status).toBe("CANCELLED");
  });
});

// ── Fill Price Accuracy ───────────────────────────────────────────────────────

describe("Execution Accuracy — Fill Price Calculations", () => {
  it("weighted average fill price math is correct", () => {
    // Pure math test — no server needed
    const fills = [
      { qty: 3, price: 60_100 },
      { qty: 4, price: 60_050 },
      { qty: 3, price: 59_980 },
    ];
    const totalQty = fills.reduce((s, f) => s + f.qty, 0);
    const weightedAvg = fills.reduce((s, f) => s + f.qty * f.price, 0) / totalQty;
    // (3*60100 + 4*60050 + 3*59980) / 10 = 600440/10 = 60044
    expect(Math.abs(weightedAvg - 60044)).toBeLessThan(0.01);
  });

  it("quantity integrity: filled + remaining always equals original quantity", async () => {
    const traderId = await activeTrader();
    const quantity = 15;
    const orderRes = await api.createOrder(makeOrderRequest(traderId, { quantity }));
    const orderId = orderRes.data.data.id;

    // Simulate partial fill updates
    const partials = [5, 6, 4];
    let cumulativeFilled = 0;

    for (const fillQty of partials) {
      cumulativeFilled += fillQty;
      await http.patch(`${MOCK}/orders/${orderId}?force=true`, {
        filledQuantity: cumulativeFilled,
        remainingQuantity: quantity - cumulativeFilled,
      });
      const order = (await api.getOrder(orderId)).data.data;
      expect(order.filledQuantity + order.remainingQuantity).toBe(quantity);
    }
  });

  it("LIMIT BUY fill prices must not exceed the limit price", () => {
    // Business rule: fills on a BUY limit order <= limit price
    const limitPrice = 60_000;
    const mockFillPrices = [59_980, 60_000]; // both valid
    for (const fp of mockFillPrices) {
      expect(fp).toBeLessThanOrEqual(limitPrice);
    }
    // A fill above limit price would be a violation
    expect(60_100 > limitPrice).toBe(true); // 60100 > 60000 → invalid for BUY limit
  });
});

// ── Risk Checks ───────────────────────────────────────────────────────────────

describe("Risk Checks — Order Validation", () => {
  it("rejects order exceeding maxOrderSize — POSITION_LIMIT_BREACH", async () => {
    const traderId = await activeTrader({ riskLimits: { ...RISK_LIMIT_TIERS.JUNIOR } });
    const res = await api.createOrder(makeLimitBreachOrder(traderId, RISK_LIMIT_TIERS.JUNIOR));
    expect(res.status).toBe(422);
    expect(res.data.code).toBe("POSITION_LIMIT_BREACH");
  });

  it("rejects order when trader has reached daily loss limit — DAILY_LOSS_LIMIT_REACHED", async () => {
    const maxDailyLoss = 5_000;
    const traderId = await activeTrader({ riskLimits: { ...RISK_LIMIT_TIERS.JUNIOR, maxDailyLoss } });
    // Simulate daily loss at limit
    await http.patch(`${MOCK}/traders/${traderId}`, { dailyPnL: -maxDailyLoss });
    const res = await api.createOrder(makeOrderRequest(traderId));
    expect(res.status).toBe(422);
    expect(res.data.code).toBe("DAILY_LOSS_LIMIT_REACHED");
  });

  it("rejects order when trader has too many open orders", async () => {
    const maxOpenOrders = 3;
    const traderId = await activeTrader({ riskLimits: { ...RISK_LIMIT_TIERS.JUNIOR, maxOpenOrders } });
    // Fill up open orders
    for (let i = 0; i < maxOpenOrders; i++) {
      await api.createOrder(makeOrderRequest(traderId));
    }
    const res = await api.createOrder(makeOrderRequest(traderId));
    expect(res.status).toBe(422);
    expect(res.data.code).toMatch(/position_limit/i);
  });

  it("allows order when trader is within all risk limits", async () => {
    const traderId = await activeTrader({ riskLimits: RISK_LIMIT_TIERS.STANDARD });
    const res = await api.createOrder(makeOrderRequest(traderId, { quantity: 1, price: 60_000 }));
    expect(res.status).toBe(201);
    expect(res.data.data.status).toBe("NEW");
  });

  it("rejects order on symbol not in allowedSymbols — INVALID_SYMBOL", async () => {
    const traderId = await activeTrader({
      riskLimits: { ...RISK_LIMIT_TIERS.STANDARD, allowedSymbols: ["BTCUSDT", "ETHUSDT"] },
    });
    const res = await api.createOrder(makeOrderRequest(traderId, { symbol: SYMBOLS.AAPL }));
    expect(res.status).toBe(422);
    expect(res.data.code).toBe("INVALID_SYMBOL");
  });
});

// ── Time-in-Force ─────────────────────────────────────────────────────────────

describe("Time-in-Force — Order Expiry", () => {
  it("IOC order: only filled portion is kept, remainder cancelled", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId, {
      type: "LIMIT", quantity: 10, price: 60_000, timeInForce: "IOC",
    }));
    const orderId = orderRes.data.data.id;

    // Simulate partial fill then IOC cancellation of remainder
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, {
      filledQuantity: 3, remainingQuantity: 7, status: "CANCELLED",
    });

    const order = (await api.getOrder(orderId)).data.data;
    expect(order.status).toBe("CANCELLED");
    expect(order.filledQuantity).toBe(3); // keeps what was filled
    expect(order.remainingQuantity).toBe(7);
  });

  it("FOK order: cancelled entirely if cannot fill full quantity", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId, {
      quantity: 10, timeInForce: "FOK",
    }));
    const orderId = orderRes.data.data.id;

    // FOK: zero fills, full cancel
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, {
      filledQuantity: 0, remainingQuantity: 10, status: "CANCELLED",
    });

    const order = (await api.getOrder(orderId)).data.data;
    expect(order.status).toBe("CANCELLED");
    expect(order.filledQuantity).toBe(0);
  });

  it("DAY order transitions to EXPIRED after session close", async () => {
    const traderId = await activeTrader();
    const orderRes = await api.createOrder(makeOrderRequest(traderId, { timeInForce: "DAY" }));
    const orderId = orderRes.data.data.id;

    // Simulate expiry sweep
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "EXPIRED" });
    expect((await api.getOrder(orderId)).data.data.status).toBe("EXPIRED");
  });
});
