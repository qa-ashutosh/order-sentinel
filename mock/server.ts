// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Mock OMS Server (Fastify)
//
// A lightweight but realistic mock of an Order/Profile Management System.
// Implements all endpoints that the test suite calls against.
//
// This is NOT a simplified stub — it enforces real trading business rules:
//   - Order lifecycle state machine with valid/invalid transition enforcement
//   - Risk checks on every order (position limits, daily loss, symbol whitelist)
//   - Trader suspension blocking all new orders
//   - Proper HTTP status codes (201, 400, 404, 409, 422)
//   - Consistent response envelope: { data: T, meta?: { total: number } }
//
// Usage:
//   npm run mock          — start on port 3000
//   npm run mock:start    — start in background
//
// The /reset endpoint clears all in-memory state between test runs.
// ─────────────────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import sensible from "@fastify/sensible";
import {
  createTrader,
  createOrder,
  getTrader,
  getTraderByEmail,
  listTraders,
  updateTrader,
  getOrder,
  listOrders,
  updateOrder,
  getFills,
  resetStore,
} from "./store.js";
import { runRiskChecks, isValidTransition } from "./risk.js";
import { CreateOrderSchema, CreateTraderSchema } from "../src/contracts/schemas.js";

// ── Server factory ────────────────────────────────────────────────────────────

export function buildServer(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(sensible);

  // Universal body parser — handles all content types including empty bodies
  // Overrides Fastify's strict JSON parser so DELETE with Content-Type:application/json works
  const bodyParser = (request: any, payload: any, done: any) => {
    if (request.method === "DELETE" || request.method === "GET") return done(null, {});
    let data = "";
    payload.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    payload.on("end", () => {
      if (!data) return done(null, {});
      try { done(null, JSON.parse(data)); } catch { done(null, {}); }
    });
    payload.on("error", done);
  };
  app.addContentTypeParser("application/json", bodyParser);
  app.addContentTypeParser("application/x-www-form-urlencoded", bodyParser);
  app.addContentTypeParser("*", bodyParser);


  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/health", async () => {
    return { status: "ok", service: "mock-oms", timestamp: new Date().toISOString() };
  });

  // ── Reset (test utility) ────────────────────────────────────────────────────

  app.post("/reset", async (_, reply) => {
    resetStore();
    return reply.status(200).send({ data: { message: "Store reset" } });
  });

  // ── Traders ─────────────────────────────────────────────────────────────────

  app.post("/traders", async (request, reply) => {
    const parsed = CreateTraderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid request",
        details: parsed.error.issues,
        timestamp: new Date().toISOString(),
      });
    }

    const { name, email, capitalAllocated, riskLimits } = parsed.data;

    // Unique email enforcement
    if (getTraderByEmail(email)) {
      return reply.status(409).send({
        code: "DUPLICATE_EMAIL",
        message: `A trader with email ${email} already exists`,
        timestamp: new Date().toISOString(),
      });
    }

    const trader = createTrader({ name, email, capitalAllocated, riskLimits });
    return reply.status(201).send({ data: trader });
  });

  app.get("/traders", async (request) => {
    const { status } = request.query as { status?: string };
    let traders = listTraders();
    if (status) traders = traders.filter((t) => t.status === status);
    return { data: traders, meta: { total: traders.length } };
  });

  app.get("/traders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const trader = getTrader(id);
    if (!trader) {
      return reply.status(404).send({
        code: "TRADER_NOT_FOUND",
        message: `Trader ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }
    return { data: trader };
  });

  app.patch("/traders/:id/risk-limits", async (request, reply) => {
    const { id } = request.params as { id: string };
    const trader = getTrader(id);
    if (!trader) {
      return reply.status(404).send({
        code: "TRADER_NOT_FOUND",
        message: `Trader ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    const body = request.body as Partial<typeof trader.riskLimits>;

    // Validate: no zero or negative limits
    for (const [key, value] of Object.entries(body)) {
      if (key !== "allowedSymbols" && typeof value === "number" && value <= 0) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: `${key} must be positive`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const updated = updateTrader(id, {
      riskLimits: { ...trader.riskLimits, ...body },
    });
    return { data: updated };
  });


  // Direct state patch — used by tests to force trader status, dailyPnL etc.
  app.patch("/traders/:id", async (request, reply) => {
    const { id } = (request.params as { id: string });
    const trader = getTrader(id);
    if (!trader) {
      return reply.status(404).send({ code: "TRADER_NOT_FOUND", message: `Trader ${id} not found`, timestamp: new Date().toISOString() });
    }
    const updated = updateTrader(id, request.body as any);
    return { data: updated };
  });
  app.post("/traders/:id/suspend", async (request, reply) => {
    const { id } = request.params as { id: string };
    const trader = getTrader(id);
    if (!trader) {
      return reply.status(404).send({
        code: "TRADER_NOT_FOUND",
        message: `Trader ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    if (trader.status === "SUSPENDED") {
      return reply.status(409).send({
        code: "ALREADY_SUSPENDED",
        message: `Trader ${id} is already suspended`,
        timestamp: new Date().toISOString(),
      });
    }

    const updated = updateTrader(id, { status: "SUSPENDED" });
    return { data: updated };
  });

  // ── Orders ──────────────────────────────────────────────────────────────────

  app.post("/orders", async (request, reply) => {
    const parsed = CreateOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid request",
        details: parsed.error.issues,
        timestamp: new Date().toISOString(),
      });
    }

    const { traderId, symbol, side, type, quantity, price, timeInForce, tags, expiresAt } =
      parsed.data;

    // Trader must exist
    const trader = getTrader(traderId);
    if (!trader) {
      return reply.status(404).send({
        code: "TRADER_NOT_FOUND",
        message: `Trader ${traderId} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    // Run risk checks
    const riskResult = runRiskChecks(trader, { symbol, quantity, price, side });
    if (!riskResult.passed) {
      // Persist rejected order for audit trail
      createOrder({
        traderId,
        symbol,
        side,
        type,
        quantity,
        price,
        timeInForce,
        tags,
        expiresAt,
        status: "REJECTED",
        rejectionReason: riskResult.reason,
      });

      return reply.status(422).send({
        code: riskResult.reason,
        message: riskResult.message,
        timestamp: new Date().toISOString(),
      });
    }

    const order = createOrder({
      traderId,
      symbol,
      side,
      type,
      quantity,
      price,
      timeInForce,
      tags,
      expiresAt,
      status: "NEW",
    });

    return reply.status(201).send({ data: order });
  });

  app.get("/orders", async (request) => {
    const { traderId, status, symbol } = request.query as {
      traderId?: string;
      status?: string;
      symbol?: string;
    };
    const orders = listOrders({ traderId, status, symbol });
    return { data: orders, meta: { total: orders.length } };
  });

  app.get("/orders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }
    return { data: order };
  });

  app.patch("/orders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    const body = request.body as { status?: string; filledQuantity?: number; remainingQuantity?: number };
    const force = (request.query as any).force === "true";

    if (!force && body.status && body.status !== order.status) {
      if (!isValidTransition(order.status, body.status)) {
        return reply.status(409).send({
          code: "INVALID_TRANSITION",
          message: `Cannot transition order from ${order.status} to ${body.status}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const updated = updateOrder(id, body as any);
    return { data: updated };
  });

  app.delete("/orders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }

    const terminalStates = ["FILLED", "CANCELLED", "REJECTED", "EXPIRED"];
    if (terminalStates.includes(order.status)) {
      return reply.status(409).send({
        code: "CANNOT_CANCEL",
        message: `Cannot cancel order in ${order.status} status`,
        timestamp: new Date().toISOString(),
      });
    }

    const updated = updateOrder(id, { status: "CANCELLED" });
    return { data: updated };
  });

  app.get("/orders/:id/fills", async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`,
        timestamp: new Date().toISOString(),
      });
    }
    const fills = getFills(id);
    return { data: fills, meta: { total: fills.length } };
  });

  return app;
}

// ── Entrypoint ─────────────────────────────────────────────────────────────────

async function start() {
  const port = parseInt(process.env.PORT ?? "3000");
  const host = process.env.HOST ?? "0.0.0.0";

  const app = buildServer({ logger: true });

  try {
    await app.listen({ port, host });
    console.log(`[mock-oms] Server running at http://${host}:${port}`);
  } catch (err) {
    console.error("[mock-oms] Failed to start:", err);
    process.exit(1);
  }
}

// Only run when executed directly, not when imported in tests
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  start();
}
