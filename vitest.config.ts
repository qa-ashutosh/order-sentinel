import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    // Start mock OMS before any test file runs
    globalSetup: "./vitest.setup.ts",

    // Vitest 4 syntax: run all test files sequentially in a single worker
    // The mock OMS store is shared in-process, so parallel files would race
    // on /reset calls and corrupt each other's state
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,

    testTimeout: 60_000,
    hookTimeout: 120_000,

    reporters: process.env.CI ? ["verbose", "junit"] : ["verbose"],

    outputFile: {
      junit: "test-results/junit.xml",
    },

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      exclude: [
        "node_modules/**",
        "dist/**",
        "migrations/**",
        "infra/**",
        "mock/**",
        "**/*.config.*",
        "**/types.ts",
          "src/db/**",
  "src/fixtures/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 60,
        statements: 80,
      },
    },
  },
});
