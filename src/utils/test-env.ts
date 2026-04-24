// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Test Environment (Testcontainers)
//
// Spins up real PostgreSQL and NATS instances in Docker for every test run.
// No mocks. No in-memory fakes. The test suite talks to the same stack
// that production does — catching integration bugs that mocks never would.
//
// Testcontainers manages the full lifecycle:
//   - Pulls images if not cached
//   - Starts containers with dynamic ports (no conflicts)
//   - Waits for health checks before tests run
//   - Stops and removes containers after tests finish
// ─────────────────────────────────────────────────────────────────────────────

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { Sql } from "postgres";
import { createDbClient } from "../db/client.js";
import { NatsAdapter } from "../broker/adapters/nats.adapter.js";
import { runMigrations } from "../../migrations/runner.js";

export interface TestEnvironment {
  db: Sql;
  broker: NatsAdapter;
  dbConfig: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  };
  natsUrl: string;
  teardown: () => Promise<void>;
}

let _sharedEnv: TestEnvironment | null = null;
let _pgContainer: StartedPostgreSqlContainer | null = null;
let _natsContainer: StartedTestContainer | null = null;

/**
 * Creates a full test environment with real PostgreSQL and NATS.
 *
 * Call this in beforeAll(). Tear down in afterAll() via env.teardown().
 * For most test suites, use getSharedEnv() to reuse across files.
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  console.log("[TestEnv] Starting containers...");

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  _pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("order_sentinel_test")
    .withUsername("sentinel")
    .withPassword("sentinel_secret")
    .withExposedPorts(5432)
    .withStartupTimeout(60_000)
    .start();

  const dbConfig = {
    host: _pgContainer.getHost(),
    port: _pgContainer.getMappedPort(5432),
    database: _pgContainer.getDatabase(),
    username: _pgContainer.getUsername(),
    password: _pgContainer.getPassword(),
  };

  const db = createDbClient(dbConfig);

  // Run migrations to set up schema
  await runMigrations(db);
  console.log("[TestEnv] PostgreSQL ready, migrations applied");

  // ── NATS ───────────────────────────────────────────────────────────────────
  _natsContainer = await new GenericContainer("nats:2.10-alpine")
    .withExposedPorts(4222)
    .withCommand(["-js"]) // Enable JetStream for durable messaging tests
    .withWaitStrategy(Wait.forLogMessage("Server is ready"))
    .withStartupTimeout(30_000)
    .start();

  const natsPort = _natsContainer.getMappedPort(4222);
  const natsUrl = `nats://${_natsContainer.getHost()}:${natsPort}`;

  const broker = new NatsAdapter({ natsUrl });
  await broker.connect();
  console.log("[TestEnv] NATS ready");

  const teardown = async () => {
    console.log("[TestEnv] Tearing down...");
    await broker.disconnect();
    await db.end();
    await _natsContainer?.stop();
    await _pgContainer?.stop();
    _sharedEnv = null;
  };

  return { db, broker, dbConfig, natsUrl, teardown };
}

/**
 * Returns a shared environment instance, creating it if needed.
 * Safe to call from multiple test files — only one set of containers.
 *
 * NOTE: Vitest's --pool=forks means each worker gets its own containers.
 * This is intentional — full isolation between test suites.
 */
export async function getSharedEnv(): Promise<TestEnvironment> {
  if (!_sharedEnv) {
    _sharedEnv = await createTestEnvironment();
  }
  return _sharedEnv;
}

/**
 * Creates an isolated environment for a single test file.
 * Use when tests need a completely clean state (e.g. risk limit tests).
 */
export async function createIsolatedEnv(): Promise<TestEnvironment> {
  return createTestEnvironment();
}
