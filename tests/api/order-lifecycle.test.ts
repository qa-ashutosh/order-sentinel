// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — API Tests: Order Lifecycle
// Runs against the built-in mock OMS server (started via globalSetup).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import {
  makeTraderRequest,
  makeOrderRequest,
  makeMarketOrder,
  SYMBOLS,
} from "../../src/fixtures/factories.js";
import { OrderSchema } from "../../src/contracts/schemas.js";
import axios from "axios";
const http = axios.create({ validateStatus: () => true });

const api = ApiClient.fromEnv();
const MOCK = "http://localhost:3000";

beforeEach(async () => { await http.post(`${MOCK}/reset`); });

// Helper: create trader and activate them
async function activeTrader(overrides = {}) {
  const res = await api.createTrader(makeTraderRequest(overrides));
  const id = res.data.data.id;
  await http.patch(`${MOCK}/traders/${id}`, { status: "ACTIVE" });
  return id;
}

// ── Creation ──────────────────────────────────────────────────────────────────

describe("POST /orders — Order Creation", () => {
  it("creates a LIMIT BUY order with correct initial state", async () => {
    const traderId = await activeTrader();
    const res = await api.createOrder(makeOrderRequest(traderId, {
      symbol: SYMBOLS.BTC_USDT, side: "BUY", type: "LIMIT", quantity: 2, price: 60_000, timeInForce: "GTC",
    }));
    expect(res.status).toBe(201);
    const parsed = OrderSchema.safeParse(res.data.data);
    expect(parsed.success, `Schema error: ${JSON.stringify(parsed.error)}`).toBe(true);
    expect(res.data.data.status).toBe("NEW");
    expect(res.data.data.filledQuantity).toBe(0);
    expect(res.data.data.remainingQuantity).toBe(2);
    expect(res.data.data.traderId).toBe(traderId);
  });

  it("creates a MARKET SELL order with no price field", async () => {
    const traderId = await activeTrader();
    const res = await api.createOrder(makeMarketOrder(traderId, { side: "SELL", symbol: SYMBOLS.ETH_USDT, quantity: 5 }));
    expect(res.status).toBe(201);
    expect(res.data.data.type).toBe("MARKET");
    expect(res.data.data.price).toBeUndefined();
  });

  it("rejects order with missing traderId — 400", async () => {
    const res = await api.createOrder({ traderId: "", symbol: SYMBOLS.BTC_USDT, side: "BUY", type: "LIMIT", quantity: 1, price: 60_000, timeInForce: "GTC" });
    expect(res.status).toBe(400);
  });

  it("rejects LIMIT order without a price — 400", async () => {
    const traderId = await activeTrader();
    const res = await api.createOrder({ traderId, symbol: SYMBOLS.BTC_USDT, side: "BUY", type: "LIMIT", quantity: 1, timeInForce: "GTC" } as any);
    expect(res.status).toBe(400);
    expect(res.data.message).toMatch(/price/i);
  });

  it("rejects order for a non-existent trader — 404", async () => {
    const res = await api.createOrder(makeOrderRequest("00000000-0000-0000-0000-000000000000"));
    expect(res.status).toBe(404);
  });

  it("rejects order with zero quantity — 400", async () => {
    const traderId = await activeTrader();
    const res = await api.createOrder(makeOrderRequest(traderId, { quantity: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects order with negative price — 400", async () => {
    const traderId = await activeTrader();
    const res = await api.createOrder(makeOrderRequest(traderId, { price: -100 }));
    expect(res.status).toBe(400);
  });
});

// ── Retrieval ─────────────────────────────────────────────────────────────────

describe("GET /orders/:id — Order Retrieval", () => {
  it("retrieves an existing order with correct shape", async () => {
    const traderId = await activeTrader();
    const createRes = await api.createOrder(makeOrderRequest(traderId));
    const res = await api.getOrder(createRes.data.data.id);
    expect(res.status).toBe(200);
    expect(OrderSchema.safeParse(res.data.data).success).toBe(true);
  });

  it("returns 404 for unknown order ID", async () => {
    const res = await api.getOrder("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("lists orders filtered by trader ID", async () => {
    const traderId = await activeTrader();
    await Promise.all([
      api.createOrder(makeOrderRequest(traderId, { symbol: SYMBOLS.BTC_USDT })),
      api.createOrder(makeOrderRequest(traderId, { symbol: SYMBOLS.ETH_USDT })),
      api.createOrder(makeOrderRequest(traderId, { symbol: SYMBOLS.AAPL })),
    ]);
    const res = await api.listOrders({ traderId });
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBe(3);
    expect(res.data.meta.total).toBe(3);
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe("DELETE /orders/:id — Order Cancellation", () => {
  it("cancels a NEW order — status transitions to CANCELLED", async () => {
    const traderId = await activeTrader();
    const createRes = await api.createOrder(makeOrderRequest(traderId));
    const orderId = createRes.data.data.id;
    const cancelRes = await api.cancelOrder(orderId);
    expect(cancelRes.status).toBe(200);
    const getRes = await api.getOrder(orderId);
    expect(getRes.data.data.status).toBe("CANCELLED");
  });

  it("cannot cancel a FILLED order — 409 Conflict", async () => {
    const traderId = await activeTrader();
    const createRes = await api.createOrder(makeOrderRequest(traderId));
    const orderId = createRes.data.data.id;
    await http.patch(`${MOCK}/orders/${orderId}?force=true`, { status: "FILLED" });
    const cancelRes = await api.cancelOrder(orderId);
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.data.message).toMatch(/cannot cancel/i);
  });

  it("cannot cancel an already CANCELLED order — 409 Conflict", async () => {
    const traderId = await activeTrader();
    const createRes = await api.createOrder(makeOrderRequest(traderId));
    const orderId = createRes.data.data.id;
    await api.cancelOrder(orderId);
    expect((await api.cancelOrder(orderId)).status).toBe(409);
  });

  it("returns 404 when cancelling non-existent order", async () => {
    expect((await api.cancelOrder("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

// ── Fills ─────────────────────────────────────────────────────────────────────

describe("GET /orders/:id/fills — Order Fills", () => {
  it("returns empty fills array for a NEW order", async () => {
    const traderId = await activeTrader();
    const createRes = await api.createOrder(makeOrderRequest(traderId));
    const res = await api.getOrderFills(createRes.data.data.id);
    expect(res.status).toBe(200);
    expect(res.data.data).toEqual([]);
  });
});
