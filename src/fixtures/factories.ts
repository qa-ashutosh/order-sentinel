// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Test Fixtures & Factories
//
// Realistic trading data factories. These aren't "test-order-1" placeholders.
// Every fixture reflects real prop trading scenarios:
//   - Algorithmic traders with strategy tags
//   - Risk limits that reflect real capital allocation tiers
//   - Symbols from actual markets (equities, crypto, FX)
//   - Order sizes that make sense for the position limits
//
// Pattern: Sensible defaults + override anything for specific scenarios.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import type {
  CreateOrderRequest,
  CreateTraderRequest,
  Order,
  TraderProfile,
  Fill,
  RiskLimits,
  OrderSide,
  OrderType,
  TimeInForce,
} from "../types.js";

// ── Symbols ───────────────────────────────────────────────────────────────────

export const SYMBOLS = {
  // Crypto
  BTC_USDT: "BTCUSDT",
  ETH_USDT: "ETHUSDT",
  SOL_USDT: "SOLUSDT",
  // Equities
  AAPL: "AAPL",
  TSLA: "TSLA",
  NVDA: "NVDA",
  // FX
  EUR_USD: "EURUSD",
  GBP_USD: "GBPUSD",
} as const;

export type TradingSymbol = (typeof SYMBOLS)[keyof typeof SYMBOLS];

// ── Trader Profiles ───────────────────────────────────────────────────────────

/**
 * Risk limit tiers matching real prop firm capital allocation structures
 */
export const RISK_LIMIT_TIERS = {
  /** Junior trader — tight limits, learning the system */
  JUNIOR: {
    maxOrderSize: 10,
    maxPositionSize: 50,
    maxDailyLoss: 5_000,
    maxOpenOrders: 5,
  } satisfies RiskLimits,

  /** Mid-level trader — moderate limits */
  STANDARD: {
    maxOrderSize: 100,
    maxPositionSize: 500,
    maxDailyLoss: 50_000,
    maxOpenOrders: 20,
  } satisfies RiskLimits,

  /** Senior / algorithmic trader — high throughput, high limits */
  SENIOR: {
    maxOrderSize: 1_000,
    maxPositionSize: 5_000,
    maxDailyLoss: 250_000,
    maxOpenOrders: 100,
  } satisfies RiskLimits,

  /** Restricted — used for suspended/watchlisted traders */
  RESTRICTED: {
    maxOrderSize: 1,
    maxPositionSize: 1,
    maxDailyLoss: 100,
    maxOpenOrders: 1,
    allowedSymbols: [],
  } satisfies RiskLimits,
};

export function makeTraderRequest(
  overrides: Partial<CreateTraderRequest> = {}
): CreateTraderRequest {
  const id = randomUUID().slice(0, 8);
  return {
    name: `Trader ${id}`,
    email: `trader.${id}@propfirm.internal`,
    capitalAllocated: 100_000,
    riskLimits: RISK_LIMIT_TIERS.STANDARD,
    ...overrides,
  };
}

export function makeTraderProfile(
  overrides: Partial<TraderProfile> = {}
): TraderProfile {
  const now = new Date();
  return {
    id: randomUUID(),
    name: "Alex Chen",
    email: `alex.chen.${Date.now()}@propfirm.internal`,
    status: "ACTIVE",
    capitalAllocated: 100_000,
    capitalUsed: 0,
    dailyPnL: 0,
    totalPnL: 0,
    riskLimits: RISK_LIMIT_TIERS.STANDARD,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Orders ────────────────────────────────────────────────────────────────────

export function makeOrderRequest(
  traderId: string,
  overrides: Partial<CreateOrderRequest> = {}
): CreateOrderRequest {
  return {
    traderId,
    symbol: SYMBOLS.BTC_USDT,
    side: "BUY",
    type: "LIMIT",
    quantity: 1,
    price: 60_000,
    timeInForce: "GTC",
    ...overrides,
  };
}

/** Market order — no price, executes immediately */
export function makeMarketOrder(
  traderId: string,
  overrides: Partial<CreateOrderRequest> = {}
): CreateOrderRequest {
  return makeOrderRequest(traderId, {
    type: "MARKET",
    price: undefined,
    timeInForce: "IOC",
    ...overrides,
  });
}

/** Large order designed to breach position limits */
export function makeLimitBreachOrder(
  traderId: string,
  riskLimits: RiskLimits
): CreateOrderRequest {
  return makeOrderRequest(traderId, {
    quantity: riskLimits.maxOrderSize * 10, // 10x the limit
    symbol: SYMBOLS.BTC_USDT,
    side: "BUY",
  });
}

/** Order that would push daily loss over the limit */
export function makeDailyLossBreachOrder(
  traderId: string,
  currentDailyLoss: number,
  maxDailyLoss: number
): CreateOrderRequest {
  const remainingBudget = maxDailyLoss - currentDailyLoss;
  return makeOrderRequest(traderId, {
    type: "MARKET",
    quantity: Math.ceil(remainingBudget / 50_000) + 1, // Enough to breach
    symbol: SYMBOLS.BTC_USDT,
    side: "BUY",
    price: undefined,
    timeInForce: "IOC",
  });
}

export function makeOrder(
  traderId: string,
  overrides: Partial<Order> = {}
): Order {
  const now = new Date();
  const quantity = overrides.quantity ?? 1;
  const filledQty = overrides.filledQuantity ?? 0;

  return {
    id: randomUUID(),
    traderId,
    symbol: SYMBOLS.BTC_USDT,
    side: "BUY",
    type: "LIMIT",
    quantity,
    filledQuantity: filledQty,
    remainingQuantity: quantity - filledQty,
    price: 60_000,
    status: "NEW",
    timeInForce: "GTC",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Fills ─────────────────────────────────────────────────────────────────────

export function makeFill(
  orderId: string,
  traderId: string,
  overrides: Partial<Fill> = {}
): Fill {
  return {
    id: randomUUID(),
    orderId,
    traderId,
    symbol: SYMBOLS.BTC_USDT,
    side: "BUY",
    filledQuantity: 1,
    fillPrice: 60_000,
    executionVenue: "BINANCE",
    executedAt: new Date(),
    ...overrides,
  };
}

/**
 * Generates a series of partial fills that add up to the full order quantity.
 * Simulates realistic partial fill scenarios common in prop trading.
 *
 * e.g. 10 BTC order might fill as: 3 BTC @ 60100, 4 BTC @ 60050, 3 BTC @ 59980
 */
export function makePartialFills(
  orderId: string,
  traderId: string,
  totalQuantity: number,
  basePrice: number,
  symbol: TradingSymbol = SYMBOLS.BTC_USDT
): Fill[] {
  const fills: Fill[] = [];
  let remaining = totalQuantity;
  const slices = [0.3, 0.4, 0.3]; // 30/40/30 split
  const priceVariance = basePrice * 0.001; // 0.1% price movement between fills

  for (const slice of slices) {
    const qty = parseFloat((totalQuantity * slice).toFixed(8));
    const priceOffset = (Math.random() - 0.5) * 2 * priceVariance;
    remaining -= qty;

    fills.push(makeFill(orderId, traderId, {
      filledQuantity: qty,
      fillPrice: parseFloat((basePrice + priceOffset).toFixed(2)),
      symbol,
      executedAt: new Date(Date.now() + fills.length * 100), // 100ms apart
    }));
  }

  return fills;
}

// ── Scenario Presets ──────────────────────────────────────────────────────────

/**
 * Ready-made scenario configurations for common test cases.
 * Import these for clarity — self-documenting test setups.
 */
export const SCENARIOS = {
  /** Active algo trader running a BTC momentum strategy */
  ALGO_TRADER_BTC: {
    trader: makeTraderRequest({
      name: "Algo Bot — BTC Momentum",
      email: "algo.btc@propfirm.internal",
      capitalAllocated: 500_000,
      riskLimits: RISK_LIMIT_TIERS.SENIOR,
    }),
    defaultSymbol: SYMBOLS.BTC_USDT,
  },

  /** Junior FX trader, tight risk limits */
  JUNIOR_FX_TRADER: {
    trader: makeTraderRequest({
      name: "Junior FX Desk",
      email: "junior.fx@propfirm.internal",
      capitalAllocated: 10_000,
      riskLimits: RISK_LIMIT_TIERS.JUNIOR,
    }),
    defaultSymbol: SYMBOLS.EUR_USD,
  },

  /** Trader near daily loss limit — used for risk boundary tests */
  TRADER_NEAR_DAILY_LIMIT: {
    trader: makeTraderRequest({
      name: "High Risk Trader",
      email: "highrisk@propfirm.internal",
      capitalAllocated: 200_000,
      riskLimits: { ...RISK_LIMIT_TIERS.STANDARD, maxDailyLoss: 50_000 },
    }),
    simulatedDailyLoss: 48_000, // $48k of $50k limit already burned
  },

  /** Suspended trader — all orders should be REJECTED */
  SUSPENDED_TRADER: {
    trader: makeTraderRequest({
      name: "Suspended Account",
      email: "suspended@propfirm.internal",
      capitalAllocated: 100_000,
      riskLimits: RISK_LIMIT_TIERS.RESTRICTED,
    }),
  },
} as const;
