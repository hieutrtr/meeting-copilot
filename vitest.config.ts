import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: [
      "shared/**/*.test.ts",
      "src/**/*.test.{ts,tsx}",
      "tests/e2e/**/*.e2e.test.ts",
    ],
    environment: "node",
    // T-4.10 — per-scenario subprocess spawn under bun cold-start runs ~1–2s;
    // 30s gives ample headroom for slow CI / cold caches.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
