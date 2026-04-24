// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Zod Contract Schemas
//
// These schemas serve as the single source of truth for message and API
// contracts. They provide both compile-time types (via z.infer) and
// runtime validation — critical for catching schema drift between services.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────────────

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export const OrderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP"]);
export const TimeInForceSchema = z.enum(["DAY", "GTC", "IOC", "FOK"]);

export const OrderStatusSchema = z.enum([
  "NEW",
  "PENDING",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

export const RejectionReasonSchema = z.enum([
  "INSUFFICIENT_CAPITAL",
  "POSITION_LIMIT_BREACH",
  "DAILY_LOSS_LIMIT_REACHED",
  "INVALID_SYMBOL",
  "MARKET_CLOSED",
  "PRICE_DEVIATION_TOO_HIGH",
  "DUPLICATE_ORDER",
  "TRADER_SUSPENDED",
  "RISK_CHECK_TIMEOUT",
]);

export const TraderStatusSchema = z.enum([
  "ACTIVE",
  "SUSPENDED",
  "PENDING_APPROVAL",
  "CLOSED",
]);

// ── Order Schemas ─────────────────────────────────────────────────────────────

export const CreateOrderSchema = z.object({
  traderId: z.string().uuid("traderId must be a valid UUID"),
  symbol: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9/]+$/, "Symbol must be uppercase alphanumeric"),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z
    .number()
    .positive("Quantity must be positive")
    .max(1_000_000, "Quantity exceeds maximum allowed"),
  price: z
    .number()
    .positive("Price must be positive")
    .optional(),
  timeInForce: TimeInForceSchema,
  expiresAt: z.string().datetime().optional(),
  tags: z.array(z.string()).max(10).optional(),
}).refine(
  (data) => {
    // LIMIT and STOP orders must have a price
    if (data.type === "LIMIT" || data.type === "STOP") {
      return data.price !== undefined;
    }
    return true;
  },
  { message: "LIMIT and STOP orders require a price", path: ["price"] }
);

export const OrderSchema = z.object({
  id: z.string().uuid(),
  traderId: z.string().uuid(),
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z.number().positive(),
  filledQuantity: z.number().min(0),
  remainingQuantity: z.number().min(0),
  price: z.number().positive().optional(),
  averageFillPrice: z.number().positive().optional(),
  status: OrderStatusSchema,
  timeInForce: TimeInForceSchema,
  rejectionReason: RejectionReasonSchema.optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
}).refine(
  (o) => o.filledQuantity + o.remainingQuantity === o.quantity,
  { message: "filledQuantity + remainingQuantity must equal quantity" }
);

// ── Fill Schemas ──────────────────────────────────────────────────────────────

export const FillSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  traderId: z.string().uuid(),
  symbol: z.string(),
  side: OrderSideSchema,
  filledQuantity: z.number().positive(),
  fillPrice: z.number().positive(),
  executionVenue: z.string().min(1),
  executedAt: z.string().datetime(),
});

// ── Trader / Profile Schemas ──────────────────────────────────────────────────

export const RiskLimitsSchema = z.object({
  maxOrderSize: z.number().positive(),
  maxPositionSize: z.number().positive(),
  maxDailyLoss: z.number().positive(),
  maxOpenOrders: z.number().int().positive().max(1000),
  allowedSymbols: z.array(z.string()).optional(),
});

export const CreateTraderSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  capitalAllocated: z.number().positive(),
  riskLimits: RiskLimitsSchema,
});

export const TraderProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  status: TraderStatusSchema,
  capitalAllocated: z.number(),
  capitalUsed: z.number(),
  dailyPnL: z.number(),
  totalPnL: z.number(),
  riskLimits: RiskLimitsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ── NATS Event Schemas ────────────────────────────────────────────────────────

export const OrderCreatedEventSchema = z.object({
  subject: z.literal("orders.created"),
  orderId: z.string().uuid(),
  traderId: z.string().uuid(),
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  timestamp: z.string().datetime(),
});

export const OrderFilledEventSchema = z.object({
  subject: z.literal("orders.filled"),
  orderId: z.string().uuid(),
  traderId: z.string().uuid(),
  symbol: z.string(),
  side: OrderSideSchema,
  filledQuantity: z.number().positive(),
  averageFillPrice: z.number().positive(),
  timestamp: z.string().datetime(),
});

export const OrderRejectedEventSchema = z.object({
  subject: z.literal("orders.rejected"),
  orderId: z.string().uuid(),
  traderId: z.string().uuid(),
  reason: RejectionReasonSchema,
  timestamp: z.string().datetime(),
});

export const RiskCheckRequestedEventSchema = z.object({
  subject: z.literal("risk.check.requested"),
  orderId: z.string().uuid(),
  traderId: z.string().uuid(),
  symbol: z.string(),
  side: OrderSideSchema,
  quantity: z.number().positive(),
  estimatedValue: z.number().positive(),
  timestamp: z.string().datetime(),
});

export const TraderLimitBreachedEventSchema = z.object({
  subject: z.literal("traders.limit.breached"),
  traderId: z.string().uuid(),
  breachType: z.enum(["DAILY_LOSS", "POSITION_SIZE", "ORDER_COUNT"]),
  currentValue: z.number(),
  limitValue: z.number(),
  timestamp: z.string().datetime(),
});

// ── API Response Schemas ──────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime(),
});

export function ApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: z
      .object({
        total: z.number().optional(),
        page: z.number().optional(),
        pageSize: z.number().optional(),
      })
      .optional(),
  });
}

// ── Inferred Types ────────────────────────────────────────────────────────────
// Use these in tests for fully type-safe assertions

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type OrderOutput = z.infer<typeof OrderSchema>;
export type FillOutput = z.infer<typeof FillSchema>;
export type CreateTraderInput = z.infer<typeof CreateTraderSchema>;
export type TraderProfileOutput = z.infer<typeof TraderProfileSchema>;
export type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;
export type OrderFilledEvent = z.infer<typeof OrderFilledEventSchema>;
export type OrderRejectedEvent = z.infer<typeof OrderRejectedEventSchema>;
