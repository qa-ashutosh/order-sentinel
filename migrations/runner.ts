// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Migration Runner
//
// Lightweight migration runner — no heavy ORM needed.
// Migrations are plain SQL with TypeScript orchestration.
// Each migration runs in a transaction — all-or-nothing.
// ─────────────────────────────────────────────────────────────────────────────

import type { Sql } from "postgres";
import { createDbClientFromEnv } from "../src/db/client.js";

interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "create_trader_profiles",
    up: `
      CREATE TABLE IF NOT EXISTS trader_profiles (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              VARCHAR(100) NOT NULL,
        email             VARCHAR(255) NOT NULL UNIQUE,
        status            VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL'
                          CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_APPROVAL','CLOSED')),
        capital_allocated NUMERIC(20,4) NOT NULL CHECK (capital_allocated >= 0),
        capital_used      NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (capital_used >= 0),
        daily_pnl         NUMERIC(20,4) NOT NULL DEFAULT 0,
        total_pnl         NUMERIC(20,4) NOT NULL DEFAULT 0,

        -- Risk limits (denormalized for fast reads during order validation)
        risk_max_order_size     NUMERIC(20,8) NOT NULL,
        risk_max_position_size  NUMERIC(20,8) NOT NULL,
        risk_max_daily_loss     NUMERIC(20,4) NOT NULL,
        risk_max_open_orders    INTEGER NOT NULL DEFAULT 20,
        risk_allowed_symbols    TEXT[],  -- NULL means all symbols allowed

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_trader_profiles_email  ON trader_profiles(email);
      CREATE INDEX idx_trader_profiles_status ON trader_profiles(status);
    `,
    down: `DROP TABLE IF EXISTS trader_profiles;`,
  },

  {
    version: 2,
    name: "create_orders",
    up: `
      CREATE TABLE IF NOT EXISTS orders (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_id          UUID NOT NULL REFERENCES trader_profiles(id),
        symbol             VARCHAR(20) NOT NULL,
        side               VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
        type               VARCHAR(10) NOT NULL CHECK (type IN ('MARKET','LIMIT','STOP')),
        quantity           NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
        filled_quantity    NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
        remaining_quantity NUMERIC(20,8) NOT NULL CHECK (remaining_quantity >= 0),
        price              NUMERIC(20,8),  -- NULL for MARKET orders
        average_fill_price NUMERIC(20,8),  -- Populated after fills

        status             VARCHAR(20) NOT NULL DEFAULT 'NEW'
                           CHECK (status IN (
                             'NEW','PENDING','PARTIALLY_FILLED',
                             'FILLED','CANCELLED','REJECTED','EXPIRED'
                           )),

        time_in_force      VARCHAR(5) NOT NULL CHECK (time_in_force IN ('DAY','GTC','IOC','FOK')),
        rejection_reason   VARCHAR(50),
        tags               TEXT[],

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,

        -- Data integrity: filled + remaining must equal total
        CONSTRAINT chk_order_quantities
          CHECK (filled_quantity + remaining_quantity = quantity),

        -- LIMIT and STOP orders must have a price
        CONSTRAINT chk_limit_stop_price
          CHECK (type = 'MARKET' OR price IS NOT NULL)
      );

      CREATE INDEX idx_orders_trader_id ON orders(trader_id);
      CREATE INDEX idx_orders_status    ON orders(status);
      CREATE INDEX idx_orders_symbol    ON orders(symbol);
      CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

      -- Composite: most common query pattern in OMS
      CREATE INDEX idx_orders_trader_status ON orders(trader_id, status);
    `,
    down: `DROP TABLE IF EXISTS orders;`,
  },

  {
    version: 3,
    name: "create_fills",
    up: `
      CREATE TABLE IF NOT EXISTS fills (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id         UUID NOT NULL REFERENCES orders(id),
        trader_id        UUID NOT NULL REFERENCES trader_profiles(id),
        symbol           VARCHAR(20) NOT NULL,
        side             VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
        filled_quantity  NUMERIC(20,8) NOT NULL CHECK (filled_quantity > 0),
        fill_price       NUMERIC(20,8) NOT NULL CHECK (fill_price > 0),
        execution_venue  VARCHAR(50) NOT NULL,
        executed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_fills_order_id   ON fills(order_id);
      CREATE INDEX idx_fills_trader_id  ON fills(trader_id);
      CREATE INDEX idx_fills_executed_at ON fills(executed_at DESC);
    `,
    down: `DROP TABLE IF EXISTS fills;`,
  },

  {
    version: 4,
    name: "create_order_audit_log",
    up: `
      -- Immutable audit log: every order state transition is recorded.
      -- In prop trading, this is non-negotiable for compliance and debugging.
      CREATE TABLE IF NOT EXISTS order_audit_log (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id     UUID NOT NULL REFERENCES orders(id),
        trader_id    UUID NOT NULL,
        from_status  VARCHAR(20),  -- NULL on first entry (creation)
        to_status    VARCHAR(20) NOT NULL,
        reason       TEXT,
        metadata     JSONB,        -- Flexible: store fill price, rejection detail etc.
        created_by   VARCHAR(100) NOT NULL DEFAULT 'system',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Audit log is append-only — no UPDATE or DELETE allowed
      CREATE INDEX idx_audit_order_id    ON order_audit_log(order_id);
      CREATE INDEX idx_audit_created_at  ON order_audit_log(created_at DESC);

      -- Trigger: automatically log every order status change
      CREATE OR REPLACE FUNCTION log_order_status_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status THEN
          INSERT INTO order_audit_log (order_id, trader_id, from_status, to_status, created_at)
          VALUES (NEW.id, NEW.trader_id, OLD.status, NEW.status, NOW());
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_order_audit
        AFTER UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION log_order_status_change();
    `,
    down: `
      DROP TRIGGER IF EXISTS trg_order_audit ON orders;
      DROP FUNCTION IF EXISTS log_order_status_change;
      DROP TABLE IF EXISTS order_audit_log;
    `,
  },

  {
    version: 5,
    name: "create_schema_migrations_table",
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
    down: `DROP TABLE IF EXISTS schema_migrations;`,
  },
];

export async function runMigrations(sql: Sql): Promise<void> {
  // Ensure migrations table exists
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied = await sql`SELECT version FROM schema_migrations ORDER BY version`;
  const appliedVersions = new Set(applied.map((r) => r.version as number));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    console.log(`[Migration] Applying v${migration.version}: ${migration.name}`);

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.up);
      await tx`
        INSERT INTO schema_migrations (version, name)
        VALUES (${migration.version}, ${migration.name})
      `;
    });

    console.log(`[Migration] ✓ v${migration.version} applied`);
  }
}

export async function rollbackMigration(sql: Sql, version: number): Promise<void> {
  const migration = migrations.find((m) => m.version === version);
  if (!migration) throw new Error(`Migration v${version} not found`);

  await sql.begin(async (tx) => {
    await tx.unsafe(migration.down);
    await tx`DELETE FROM schema_migrations WHERE version = ${version}`;
  });

  console.log(`[Migration] Rolled back v${version}: ${migration.name}`);
}

// CLI runner
if (process.argv[2] === "up" || process.argv[2] === "down") {
  const sql = createDbClientFromEnv();
  const command = process.argv[2];

  if (command === "up") {
    runMigrations(sql)
      .then(() => { console.log("[Migration] All migrations applied"); process.exit(0); })
      .catch((err) => { console.error(err); process.exit(1); })
      .finally(() => sql.end());
  } else {
    const version = parseInt(process.argv[3] ?? "0");
    rollbackMigration(sql, version)
      .then(() => { console.log("[Migration] Rollback complete"); process.exit(0); })
      .catch((err) => { console.error(err); process.exit(1); })
      .finally(() => sql.end());
  }
}
