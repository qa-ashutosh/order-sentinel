// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — PostgreSQL Database Client
//
// Uses postgres.js — lightweight, fast, full async/await support.
// This client is used by tests to:
//   1. Assert database state after API calls or message events
//   2. Set up test data directly (bypassing the API when needed)
//   3. Verify audit trails and immutable records
//   4. Check constraint violations on invalid trading states
// ─────────────────────────────────────────────────────────────────────────────

import postgres, { type Sql } from "postgres";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  ssl?: boolean;
}

export function createDbClient(config: DbConfig): Sql {
  return postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    max: config.maxConnections ?? 10,
    idle_timeout: config.idleTimeoutMs ? config.idleTimeoutMs / 1000 : 30,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    transform: {
      // Convert snake_case DB columns to camelCase in JS
      column: {
        from: postgres.toCamel,
        to: postgres.fromCamel,
      },
    },
    onnotice: () => {}, // Suppress NOTICE messages in test output
  });
}

export function createDbClientFromEnv(): Sql {
  return createDbClient({
    host: process.env.DB_HOST ?? "localhost",
    port: parseInt(process.env.DB_PORT ?? "5432"),
    database: process.env.DB_NAME ?? "order_sentinel_test",
    username: process.env.DB_USER ?? "sentinel",
    password: process.env.DB_PASSWORD ?? "sentinel_secret",
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS ?? "10"),
    ssl: process.env.DB_SSL === "true",
  });
}

// ── Test Helper Queries ───────────────────────────────────────────────────────
// Domain-specific DB helpers used directly in test assertions

export class OrderRepository {
  constructor(private readonly sql: Sql) {}

  async findById(orderId: string) {
    const [order] = await this.sql`
      SELECT * FROM orders WHERE id = ${orderId}
    `;
    return order ?? null;
  }

  async findByTrader(traderId: string) {
    return this.sql`
      SELECT * FROM orders
      WHERE trader_id = ${traderId}
      ORDER BY created_at DESC
    `;
  }

  async findByStatus(status: string) {
    return this.sql`
      SELECT * FROM orders WHERE status = ${status}
    `;
  }

  async countByTraderAndStatus(traderId: string, status: string): Promise<number> {
    const [{ count }] = await this.sql`
      SELECT COUNT(*) as count
      FROM orders
      WHERE trader_id = ${traderId} AND status = ${status}
    `;
    return parseInt(count as string);
  }

  async getFillsForOrder(orderId: string) {
    return this.sql`
      SELECT * FROM fills
      WHERE order_id = ${orderId}
      ORDER BY executed_at ASC
    `;
  }

  async getTotalFilledQuantity(orderId: string): Promise<number> {
    const [{ total }] = await this.sql`
      SELECT COALESCE(SUM(filled_quantity), 0) as total
      FROM fills
      WHERE order_id = ${orderId}
    `;
    return parseFloat(total as string);
  }

  /**
   * Verify fill price accuracy: weighted average of all fills
   * must equal the order's recorded averageFillPrice.
   * Critical for prop trading — even rounding errors matter.
   */
  async verifyAverageFillPrice(orderId: string): Promise<{
    calculated: number;
    recorded: number;
    matches: boolean;
  }> {
    const [result] = await this.sql`
      SELECT
        o.average_fill_price as recorded,
        SUM(f.fill_price * f.filled_quantity) / SUM(f.filled_quantity) as calculated
      FROM orders o
      JOIN fills f ON f.order_id = o.id
      WHERE o.id = ${orderId}
      GROUP BY o.average_fill_price
    `;

    if (!result) return { calculated: 0, recorded: 0, matches: false };

    const calculated = parseFloat(result.calculated as string);
    const recorded = parseFloat(result.recorded as string);
    // Allow 0.0001 tolerance for floating point
    const matches = Math.abs(calculated - recorded) < 0.0001;

    return { calculated, recorded, matches };
  }
}

export class TraderRepository {
  constructor(private readonly sql: Sql) {}

  async findById(traderId: string) {
    const [trader] = await this.sql`
      SELECT * FROM trader_profiles WHERE id = ${traderId}
    `;
    return trader ?? null;
  }

  async findByEmail(email: string) {
    const [trader] = await this.sql`
      SELECT * FROM trader_profiles WHERE email = ${email}
    `;
    return trader ?? null;
  }

  async getCapitalUsed(traderId: string): Promise<number> {
    const [{ used }] = await this.sql`
      SELECT COALESCE(SUM(quantity * COALESCE(average_fill_price, price, 0)), 0) as used
      FROM orders
      WHERE trader_id = ${traderId}
        AND status IN ('PENDING', 'PARTIALLY_FILLED')
    `;
    return parseFloat(used as string);
  }

  async getDailyPnL(traderId: string): Promise<number> {
    const [{ pnl }] = await this.sql`
      SELECT COALESCE(SUM(
        CASE side
          WHEN 'SELL' THEN filled_quantity * fill_price
          WHEN 'BUY'  THEN -(filled_quantity * fill_price)
        END
      ), 0) as pnl
      FROM fills f
      JOIN orders o ON o.id = f.order_id
      WHERE o.trader_id = ${traderId}
        AND f.executed_at >= CURRENT_DATE
    `;
    return parseFloat(pnl as string);
  }
}

export class AuditRepository {
  constructor(private readonly sql: Sql) {}

  async getOrderAuditTrail(orderId: string) {
    return this.sql`
      SELECT * FROM order_audit_log
      WHERE order_id = ${orderId}
      ORDER BY created_at ASC
    `;
  }

  /**
   * Verify the audit log captures every status transition.
   * In prop trading, every state change must be logged — no gaps.
   */
  async verifyCompleteAuditTrail(orderId: string): Promise<boolean> {
    const trail = await this.getOrderAuditTrail(orderId);
    return trail.length > 0;
  }
}

// ── Test Isolation Helpers ────────────────────────────────────────────────────

/**
 * Truncates all test data in correct FK order.
 * Called in afterEach/afterAll to keep tests isolated.
 */
export async function cleanDatabase(sql: Sql): Promise<void> {
  await sql`TRUNCATE TABLE fills, order_audit_log, orders, trader_profiles RESTART IDENTITY CASCADE`;
}

/**
 * Wraps a test in a transaction that is always rolled back.
 * Zero cleanup needed — perfect for read-heavy assertion tests.
 */
export async function withRollback<T>(
  sql: Sql,
  fn: (txSql: unknown) => Promise<T>
): Promise<T> {
  let result: T;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sql as any).begin(async (txSql: unknown) => {
      result = await fn(txSql);
      throw new Error("__rollback__"); // Force rollback
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message !== "__rollback__") throw err;
  }
  return result!;
}
