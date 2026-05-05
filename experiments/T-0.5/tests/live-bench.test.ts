// experimental, not for prod — Phase 0 T-0.5 LIVE integration test.
// Hits the real Anthropic API. Skipped automatically when ANTHROPIC_API_KEY
// is not set, so `bun test` stays green-without-spend in dev environments.

import { describe, expect, test } from "bun:test";
import { runBench } from "../src/streamBench.ts";

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const describeLive = HAS_KEY ? describe : describe.skip;

describeLive("T-0.5 live bench (10 streaming calls, real API)", () => {
  test(
    "all gating ACs pass over 10 runs",
    async () => {
      const { runs, summary } = await runBench({ runs: 10 });

      // Surface the full summary so test logs double as bench output.
      console.log("[live-bench] summary:", JSON.stringify(summary, null, 2));
      console.log("[live-bench] per-run first_token_ms:",
        runs.map((r) => `#${r.run_index}: ${r.first_token_ms}ms ratio=${r.cache_read_ratio.toFixed(3)}`));

      // Gating: AC-1, AC-3, AC-4, AC-6 (per task plan §3 headline GO).
      expect(summary.ac_results["AC-1: avg first-token < 2000ms"].pass).toBe(true);
      expect(summary.ac_results["AC-3: warm cache_read_ratio > 0.9"].pass).toBe(true);
      expect(summary.ac_results["AC-4: cached context >= 20000 tokens"].pass).toBe(true);
      expect(summary.ac_results["AC-6: 0 errors"].pass).toBe(true);
      expect(summary.ok).toBe(true);
    },
    180_000, // 3 min — generous for 10 streaming calls + warm-up retries
  );
});

if (!HAS_KEY) {
  describe("T-0.5 live bench (skipped — no ANTHROPIC_API_KEY)", () => {
    test.skip("set ANTHROPIC_API_KEY then re-run `bun test` to gate the live bench", () => {});
  });
}
