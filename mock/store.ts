// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Mock OMS: In-Memory Store
//
// Holds all state for the mock server. Pure in-memory — no DB needed.
// Reset between test runs via the /reset endpoint or by restarting the server.
//
// Why in-memory and not Testcontainers here?
// Testcontainers already handles real Postgres + NATS for infra assertions.
// This store is purely for the OMS REST API layer — simulating the service
// under test so the full framework can run standalone.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import type {
  Order,
  TraderProfile,
  Fill,
  OrderStatus,
  RejectionReason,
} from "../src/types.js";

export interface StoredOrder extends Omit<Order, "createdAt" | "updatedAt" | "expiresAt"> {
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface StoredTrader extends Omit<TraderProfile, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}

export interface StoredFill extends Omit<Fill, "executedAt"> {
  executedAt: string;
}

export interface AuditEntry {
  id: string;
  orderId: string;
  traderId: string;
  fromStatus: string | null;
  toStatus: string;
  reason?: string;
  createdAt: string;
}

// ── Global store ──────────────────────────────────────────────────────────────

const store = {
  traders: new Map<string, StoredTrader>(),
  orders: new Map<string, StoredOrder>(),
  fills: new Map<string, StoredFill[]>(), // orderId → fills[]
  auditLog: new Map<string, AuditEntry[]>(), // orderId → entries[]
};

export function resetStore(): void {
  store.traders.clear();
  store.orders.clear();
  store.fills.clear();
  store.auditLog.clear();
}

// ── Trader helpers ────────────────────────────────────────────────────────────

export function createTrader(payload: {
  name: string;
  email: string;
  capitalAllocated: number;
  riskLimits: TraderProfile["riskLimits"];
}): StoredTrader {
  const now = new Date().toISOString();
  const trader: StoredTrader = {
    id: randomUUID(),
    name: payload.name,
    email: payload.email,
    status: "PENDING_APPROVAL",
    capitalAllocated: payload.capitalAllocated,
    capitalUsed: 0,
    dailyPnL: 0,
    totalPnL: 0,
    riskLimits: payload.riskLimits,
    createdAt: now,
    updatedAt: now,
  };
  store.traders.set(trader.id, trader);
  return trader;
}

export function getTrader(id: string): StoredTrader | undefined {
  return store.traders.get(id);
}

export function getTraderByEmail(email: string): StoredTrader | undefined {
  for (const t of store.traders.values()) {
    if (t.email === email) return t;
  }
  return undefined;
}

export function listTraders(): StoredTrader[] {
  return Array.from(store.traders.values());
}

export function updateTrader(id: string, patch: Partial<StoredTrader>): StoredTrader | undefined {
  const trader = store.traders.get(id);
  if (!trader) return undefined;
  const updated = { ...trader, ...patch, updatedAt: new Date().toISOString() };
  store.traders.set(id, updated);
  return updated;
}

// ── Order helpers ─────────────────────────────────────────────────────────────

export function createOrder(payload: {
  traderId: string;
  symbol: string;
  side: Order["side"];
  type: Order["type"];
  quantity: number;
  price?: number;
  timeInForce: Order["timeInForce"];
  tags?: string[];
  expiresAt?: string;
  status?: OrderStatus;
  rejectionReason?: RejectionReason;
}): StoredOrder {
  const now = new Date().toISOString();
  const order: StoredOrder = {
    id: randomUUID(),
    traderId: payload.traderId,
    symbol: payload.symbol,
    side: payload.side,
    type: payload.type,
    quantity: payload.quantity,
    filledQuantity: 0,
    remainingQuantity: payload.quantity,
    price: payload.price,
    averageFillPrice: undefined,
    status: payload.status ?? "NEW",
    timeInForce: payload.timeInForce,
    rejectionReason: payload.rejectionReason,
    tags: payload.tags,
    expiresAt: payload.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  store.orders.set(order.id, order);
  store.fills.set(order.id, []);
  store.auditLog.set(order.id, []);
  return order;
}

export function getOrder(id: string): StoredOrder | undefined {
  return store.orders.get(id);
}

export function listOrders(filter?: {
  traderId?: string;
  status?: string;
  symbol?: string;
}): StoredOrder[] {
  let orders = Array.from(store.orders.values());
  if (filter?.traderId) orders = orders.filter((o) => o.traderId === filter.traderId);
  if (filter?.status) orders = orders.filter((o) => o.status === filter.status);
  if (filter?.symbol) orders = orders.filter((o) => o.symbol === filter.symbol);
  return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateOrder(id: string, patch: Partial<StoredOrder>): StoredOrder | undefined {
  const order = store.orders.get(id);
  if (!order) return undefined;
  const prevStatus = order.status;
  const updated = { ...order, ...patch, updatedAt: new Date().toISOString() };
  store.orders.set(id, updated);

  // Auto audit log on status change
  if (patch.status && patch.status !== prevStatus) {
    appendAudit(id, order.traderId, prevStatus, patch.status);
  }
  return updated;
}

export function countOpenOrders(traderId: string): number {
  return Array.from(store.orders.values()).filter(
    (o) => o.traderId === traderId && ["NEW", "PENDING", "PARTIALLY_FILLED"].includes(o.status)
  ).length;
}

// ── Fill helpers ──────────────────────────────────────────────────────────────

export function getFills(orderId: string): StoredFill[] {
  return store.fills.get(orderId) ?? [];
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

export function appendAudit(
  orderId: string,
  traderId: string,
  fromStatus: string | null,
  toStatus: string
): void {
  const entries = store.auditLog.get(orderId) ?? [];
  entries.push({
    id: randomUUID(),
    orderId,
    traderId,
    fromStatus,
    toStatus,
    createdAt: new Date().toISOString(),
  });
  store.auditLog.set(orderId, entries);
}

export function getAuditTrail(orderId: string): AuditEntry[] {
  return store.auditLog.get(orderId) ?? [];
}
