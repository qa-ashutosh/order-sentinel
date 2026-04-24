// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Core Domain Types
// These types mirror the real OMS/PMS domain. Every test scenario, fixture,
// and assertion is built on top of these contracts.
// ─────────────────────────────────────────────────────────────────────────────

// ── Order Domain ─────────────────────────────────────────────────────────────

/**
 * Full order lifecycle as it moves through the OMS.
 *
 * NEW        → Order received, not yet validated
 * PENDING    → Passed risk checks, sent to execution venue
 * PARTIALLY_FILLED → Some quantity filled, remainder open
 * FILLED     → Fully executed at exchange/venue
 * CANCELLED  → Cancelled before full execution (manual or system)
 * REJECTED   → Failed risk/compliance checks, never sent to venue
 * EXPIRED    → Time-in-force elapsed before fill
 */
export type OrderStatus =
  | "NEW"
  | "PENDING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export type OrderSide = "BUY" | "SELL";

/**
 * MARKET  → Execute immediately at best available price
 * LIMIT   → Execute only at specified price or better
 * STOP    → Trigger order when price reaches stop level
 */
export type OrderType = "MARKET" | "LIMIT" | "STOP";

/**
 * Time-in-force: controls how long an order remains active
 *
 * DAY    → Valid until end of trading session
 * GTC    → Good Till Cancelled — persists across sessions
 * IOC    → Immediate Or Cancel — fill what's available, cancel rest
 * FOK    → Fill Or Kill — fill entire quantity immediately or cancel
 */
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK";

/**
 * Why an order was rejected. Critical for audit and compliance.
 */
export type RejectionReason =
  | "INSUFFICIENT_CAPITAL"
  | "POSITION_LIMIT_BREACH"
  | "DAILY_LOSS_LIMIT_REACHED"
  | "INVALID_SYMBOL"
  | "MARKET_CLOSED"
  | "PRICE_DEVIATION_TOO_HIGH"
  | "DUPLICATE_ORDER"
  | "TRADER_SUSPENDED"
  | "RISK_CHECK_TIMEOUT";

export interface Order {
  id: string;
  traderId: string;
  symbol: string; // e.g. "BTCUSDT", "AAPL", "EUR/USD"
  side: OrderSide;
  type: OrderType;
  quantity: number; // Requested quantity
  filledQuantity: number; // How much has been executed so far
  remainingQuantity: number; // quantity - filledQuantity
  price?: number; // Limit/Stop price (undefined for MARKET orders)
  averageFillPrice?: number; // Weighted average of all fills
  status: OrderStatus;
  timeInForce: TimeInForce;
  rejectionReason?: RejectionReason;
  tags?: string[]; // Optional labels e.g. ["algo-strategy-1", "hedge"]
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export type CreateOrderRequest = Pick<
  Order,
  "traderId" | "symbol" | "side" | "type" | "quantity" | "timeInForce"
> & {
  price?: number;
  expiresAt?: Date;
  tags?: string[];
};

export type UpdateOrderRequest = Partial<
  Pick<Order, "status" | "filledQuantity" | "averageFillPrice" | "rejectionReason">
>;

// ── Fill / Execution Domain ───────────────────────────────────────────────────

/**
 * A Fill represents a single execution event.
 * One order can have multiple partial fills.
 */
export interface Fill {
  id: string;
  orderId: string;
  traderId: string;
  symbol: string;
  side: OrderSide;
  filledQuantity: number;
  fillPrice: number;
  executionVenue: string; // e.g. "BINANCE", "NYSE", "INTERNAL_BOOK"
  executedAt: Date;
}

// ── Trader Profile Domain ─────────────────────────────────────────────────────

export type TraderStatus = "ACTIVE" | "SUSPENDED" | "PENDING_APPROVAL" | "CLOSED";

export interface RiskLimits {
  maxOrderSize: number; // Max quantity per single order
  maxPositionSize: number; // Max total open position
  maxDailyLoss: number; // Daily loss limit in USD
  maxOpenOrders: number; // Max concurrent open orders
  allowedSymbols?: string[]; // Symbol whitelist (undefined = all allowed)
}

export interface TraderProfile {
  id: string;
  name: string;
  email: string;
  status: TraderStatus;
  capitalAllocated: number; // USD capital allocated to this trader
  capitalUsed: number; // Currently deployed capital
  dailyPnL: number; // Today's P&L (resets at session open)
  totalPnL: number; // Lifetime P&L
  riskLimits: RiskLimits;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateTraderRequest = Pick<
  TraderProfile,
  "name" | "email" | "capitalAllocated" | "riskLimits"
>;

// ── NATS Message Contracts ────────────────────────────────────────────────────

/**
 * All message subjects used on the NATS bus.
 * Having these as constants prevents typos and enables contract testing.
 */
export const NATS_SUBJECTS = {
  ORDER_CREATED: "orders.created",
  ORDER_UPDATED: "orders.updated",
  ORDER_CANCELLED: "orders.cancelled",
  ORDER_REJECTED: "orders.rejected",
  ORDER_FILLED: "orders.filled",
  ORDER_PARTIALLY_FILLED: "orders.partially_filled",
  FILL_EXECUTED: "fills.executed",
  RISK_CHECK_REQUESTED: "risk.check.requested",
  RISK_CHECK_PASSED: "risk.check.passed",
  RISK_CHECK_FAILED: "risk.check.failed",
  TRADER_SUSPENDED: "traders.suspended",
  TRADER_LIMIT_BREACHED: "traders.limit.breached",
} as const;

export type NatsSubject = (typeof NATS_SUBJECTS)[keyof typeof NATS_SUBJECTS];

export interface OrderCreatedEvent {
  subject: typeof NATS_SUBJECTS.ORDER_CREATED;
  orderId: string;
  traderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  timestamp: string; // ISO-8601
}

export interface OrderFilledEvent {
  subject: typeof NATS_SUBJECTS.ORDER_FILLED;
  orderId: string;
  traderId: string;
  symbol: string;
  side: OrderSide;
  filledQuantity: number;
  averageFillPrice: number;
  timestamp: string;
}

export interface OrderRejectedEvent {
  subject: typeof NATS_SUBJECTS.ORDER_REJECTED;
  orderId: string;
  traderId: string;
  reason: RejectionReason;
  timestamp: string;
}

export interface RiskCheckRequestedEvent {
  subject: typeof NATS_SUBJECTS.RISK_CHECK_REQUESTED;
  orderId: string;
  traderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  estimatedValue: number;
  timestamp: string;
}

export interface TraderLimitBreachedEvent {
  subject: typeof NATS_SUBJECTS.TRADER_LIMIT_BREACHED;
  traderId: string;
  breachType: "DAILY_LOSS" | "POSITION_SIZE" | "ORDER_COUNT";
  currentValue: number;
  limitValue: number;
  timestamp: string;
}

// ── API Response Wrappers ─────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

// ── Test Utilities ────────────────────────────────────────────────────────────

export interface TestContext {
  traderId: string;
  traderProfile: TraderProfile;
  cleanup: () => Promise<void>;
}
