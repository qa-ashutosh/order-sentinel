// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — API Tests: Trader Profile Management
// Runs against the built-in mock OMS server (started via globalSetup).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import {
  makeTraderRequest,
  makeOrderRequest,
  RISK_LIMIT_TIERS,
  SCENARIOS,
} from "../../src/fixtures/factories.js";
import { TraderProfileSchema } from "../../src/contracts/schemas.js";
import axios from "axios";
const http = axios.create({ validateStatus: () => true });

const api = ApiClient.fromEnv();
const MOCK = "http://localhost:3000";

beforeEach(async () => { await http.post(`${MOCK}/reset`); });

// ── Creation ──────────────────────────────────────────────────────────────────

describe("POST /traders — Trader Creation", () => {
  it("creates a trader profile with PENDING_APPROVAL status", async () => {
    const payload = makeTraderRequest();
    const res = await api.createTrader(payload);
    expect(res.status).toBe(201);
    const parsed = TraderProfileSchema.safeParse(res.data.data);
    expect(parsed.success, `Schema error: ${JSON.stringify(parsed.error)}`).toBe(true);
    expect(res.data.data.status).toBe("PENDING_APPROVAL");
    expect(res.data.data.capitalUsed).toBe(0);
    expect(res.data.data.dailyPnL).toBe(0);
  });

  it("enforces unique email constraint — 409 on duplicate", async () => {
    const payload = makeTraderRequest({ email: "unique@propfirm.internal" });
    await api.createTrader(payload);
    const duplicate = await api.createTrader(payload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.code).toMatch(/duplicate/i);
  });

  it("rejects invalid email format — 400", async () => {
    const res = await api.createTrader(makeTraderRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("rejects negative capital allocation — 400", async () => {
    const res = await api.createTrader(makeTraderRequest({ capitalAllocated: -1000 }));
    expect(res.status).toBe(400);
  });

  it("creates a senior algo trader with high limits", async () => {
    const res = await api.createTrader(SCENARIOS.ALGO_TRADER_BTC.trader);
    expect(res.status).toBe(201);
    expect(res.data.data.riskLimits.maxOrderSize).toBe(RISK_LIMIT_TIERS.SENIOR.maxOrderSize);
    expect(res.data.data.capitalAllocated).toBe(500_000);
  });

  it("creates junior trader with restricted limits", async () => {
    const res = await api.createTrader(SCENARIOS.JUNIOR_FX_TRADER.trader);
    expect(res.status).toBe(201);
    expect(res.data.data.riskLimits.maxOrderSize).toBe(RISK_LIMIT_TIERS.JUNIOR.maxOrderSize);
  });
});

// ── Retrieval ─────────────────────────────────────────────────────────────────

describe("GET /traders/:id — Trader Retrieval", () => {
  it("retrieves a trader by ID with correct schema", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    const res = await api.getTrader(traderId);
    expect(res.status).toBe(200);
    expect(TraderProfileSchema.safeParse(res.data.data).success).toBe(true);
  });

  it("returns 404 for unknown trader ID", async () => {
    const res = await api.getTrader("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

// ── Risk Limits ───────────────────────────────────────────────────────────────

describe("PATCH /traders/:id/risk-limits — Risk Limit Updates", () => {
  it("updates daily loss limit for a trader", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    const res = await api.updateRiskLimits(traderId, { maxDailyLoss: 75_000 });
    expect(res.status).toBe(200);
    expect(res.data.data.riskLimits.maxDailyLoss).toBe(75_000);
  });

  it("restricts a trader to specific symbols only", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    const allowedSymbols = ["BTCUSDT", "ETHUSDT"];
    const res = await api.updateRiskLimits(traderId, { allowedSymbols });
    expect(res.status).toBe(200);
    expect(res.data.data.riskLimits.allowedSymbols).toEqual(allowedSymbols);
  });

  it("rejects limit update with maxOrderSize of 0 — 400", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    const res = await api.updateRiskLimits(traderId, { maxOrderSize: 0 });
    expect(res.status).toBe(400);
  });

  it("orders placed after limit reduction respect the new limits", async () => {
    const createRes = await api.createTrader(makeTraderRequest({ riskLimits: { ...RISK_LIMIT_TIERS.SENIOR } }));
    const traderId = createRes.data.data.id;
    await http.patch(`${MOCK}/traders/${traderId}`, { status: "ACTIVE" });
    await api.updateRiskLimits(traderId, { maxOrderSize: 5 });
    const orderRes = await api.createOrder(makeOrderRequest(traderId, { quantity: 100 }));
    expect(orderRes.status).toBe(422);
    expect(orderRes.data.code).toBe("POSITION_LIMIT_BREACH");
  });
});

// ── Suspension ────────────────────────────────────────────────────────────────

describe("POST /traders/:id/suspend — Trader Suspension", () => {
  it("suspends an ACTIVE trader — status transitions to SUSPENDED", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    await http.patch(`${MOCK}/traders/${traderId}`, { status: "ACTIVE" });
    const suspendRes = await api.suspendTrader(traderId, "Breach of daily loss limit");
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.data.data.status).toBe("SUSPENDED");
  });

  it("rejects new orders from a SUSPENDED trader — 422 TRADER_SUSPENDED", async () => {
    const createRes = await api.createTrader(SCENARIOS.SUSPENDED_TRADER.trader);
    const traderId = createRes.data.data.id;
    await http.patch(`${MOCK}/traders/${traderId}`, { status: "SUSPENDED" });
    const orderRes = await api.createOrder(makeOrderRequest(traderId));
    expect(orderRes.status).toBe(422);
    expect(orderRes.data.code).toBe("TRADER_SUSPENDED");
  });

  it("cannot suspend an already suspended trader — 409", async () => {
    const createRes = await api.createTrader(makeTraderRequest());
    const traderId = createRes.data.data.id;
    await http.patch(`${MOCK}/traders/${traderId}`, { status: "SUSPENDED" });
    const res = await api.suspendTrader(traderId, "Already suspended");
    expect(res.status).toBe(409);
  });
});
