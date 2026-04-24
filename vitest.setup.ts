// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Global Test Setup
//
// Starts the mock OMS server once before the entire test suite runs,
// and shuts it down cleanly after all tests complete.
//
// Vitest picks this up via globalSetup in vitest.config.ts.
// The server binds to port 3000 (matching API_BASE_URL=http://localhost:3000).
// ─────────────────────────────────────────────────────────────────────────────

import { buildServer } from "./mock/server.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance | null = null;

export async function setup() {
  server = buildServer({ logger: false });
  await server.listen({ port: 3000, host: "127.0.0.1" });
  console.log("[global-setup] Mock OMS started on http://127.0.0.1:3000");
}

export async function teardown() {
  if (server) {
    await server.close();
    console.log("[global-setup] Mock OMS stopped");
  }
}
