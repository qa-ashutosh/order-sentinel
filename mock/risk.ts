// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Mock OMS: Risk Check Engine
//
// Simulates the risk validation layer of a prop trading OMS.
// Every order passes through these checks before being accepted.
// Mirrors the rejection reasons defined in the domain types.
// ─────────────────────────────────────────────────────────────────────────────

import type { RejectionReason } from "../src/types.js";
import { type StoredTrader, countOpenOrders } from "./store.js";

export interface RiskCheckResult {
  passed: boolean;
  reason?: RejectionReason;
  message?: string;
}

export function runRiskChecks(
  trader: StoredTrader,
  order: {
    symbol: string;
    quantity: number;
    price?: number;
    side: "BUY" | "SELL";
  }
): RiskCheckResult {
  // 1. Trader must be ACTIVE
  if (trader.status === "SUSPENDED") {
    return {
      passed: false,
      reason: "TRADER_SUSPENDED",
      message: `Trader ${trader.id} is suspended. All orders blocked.`,
    };
  }

  if (trader.status !== "ACTIVE") {
    return {
      passed: false,
      reason: "TRADER_SUSPENDED",
      message: `Trader ${trader.id} status is ${trader.status}. Must be ACTIVE to place orders.`,
    };
  }

  // 2. Symbol whitelist check
  if (
    trader.riskLimits.allowedSymbols &&
    trader.riskLimits.allowedSymbols.length > 0 &&
    !trader.riskLimits.allowedSymbols.includes(order.symbol)
  ) {
    return {
      passed: false,
      reason: "INVALID_SYMBOL",
      message: `Symbol ${order.symbol} is not in trader's allowed symbols: ${trader.riskLimits.allowedSymbols.join(", ")}`,
    };
  }

  // 3. Order size check
  if (order.quantity > trader.riskLimits.maxOrderSize) {
    return {
      passed: false,
      reason: "POSITION_LIMIT_BREACH",
      message: `Order quantity ${order.quantity} exceeds maxOrderSize ${trader.riskLimits.maxOrderSize}`,
    };
  }

  // 4. Daily loss limit check
  if (trader.dailyPnL <= -trader.riskLimits.maxDailyLoss) {
    return {
      passed: false,
      reason: "DAILY_LOSS_LIMIT_REACHED",
      message: `Daily P&L ${trader.dailyPnL} has reached daily loss limit ${trader.riskLimits.maxDailyLoss}`,
    };
  }

  // 5. Max open orders check
  const openOrders = countOpenOrders(trader.id);
  if (openOrders >= trader.riskLimits.maxOpenOrders) {
    return {
      passed: false,
      reason: "POSITION_LIMIT_BREACH",
      message: `Trader has ${openOrders} open orders, max is ${trader.riskLimits.maxOpenOrders}`,
    };
  }

  // 6. Insufficient capital check
  if (trader.capitalAllocated <= 0 && order.side === "BUY") {
    return {
      passed: false,
      reason: "INSUFFICIENT_CAPITAL",
      message: `Trader has no capital allocated`,
    };
  }

  return { passed: true };
}

// ── Valid state machine transitions ───────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["PENDING", "CANCELLED", "REJECTED", "EXPIRED"],
  PENDING: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"],
  PARTIALLY_FILLED: ["FILLED", "CANCELLED", "EXPIRED"],
  FILLED: [], // terminal
  CANCELLED: [], // terminal
  REJECTED: [], // terminal
  EXPIRED: [], // terminal
};

export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
