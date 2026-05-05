// experimental, not for prod — Phase 0 T-0.5 pricing math sanity tests.

import { describe, expect, test } from "bun:test";
import { computeCostUsd, cacheReadRatio, SONNET_4_6_PRICING_USD_PER_MTOK } from "../src/pricing.ts";

describe("T-0.5 pricing math", () => {
  test("uncached input math matches public Sonnet 4.6 rate", () => {
    const cost = computeCostUsd({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(cost).toBeCloseTo(SONNET_4_6_PRICING_USD_PER_MTOK.input_uncached, 6);
  });

  test("cache read is ~10x cheaper than uncached input (ARCH §13)", () => {
    const uncached = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const cached = computeCostUsd({ input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 0 });
    expect(uncached / cached).toBeCloseTo(10, 0); // $3.00 / $0.30 = 10
  });

  test("cache write is ~1.25x uncached input (ephemeral 5m write premium)", () => {
    const uncached = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const write = computeCostUsd({ input_tokens: 0, cache_creation_input_tokens: 100_000, output_tokens: 0 });
    expect(write / uncached).toBeCloseTo(1.25, 1); // $3.75 / $3.00
  });

  test("output tokens cost 5x uncached input", () => {
    const inn = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const out = computeCostUsd({ input_tokens: 0, output_tokens: 100_000 });
    expect(out / inn).toBeCloseTo(5, 0); // $15 / $3
  });

  test("cacheReadRatio: cold call (0% read) returns 0", () => {
    const r = cacheReadRatio({
      input_tokens: 5,
      cache_creation_input_tokens: 21_000,
      cache_read_input_tokens: 0,
      output_tokens: 200,
    });
    expect(r).toBeCloseTo(0, 3);
  });

  test("cacheReadRatio: warm call (>90% read) returns >0.9", () => {
    const r = cacheReadRatio({
      input_tokens: 80,                  // recent transcript + question only
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 21_000,
      output_tokens: 200,
    });
    expect(r).toBeGreaterThan(0.99);
  });

  test("warm-call cost lands ~$0.01–0.02 per §13 reference profile", () => {
    // ARCH §13 line 439: per-question Sonnet w/ cache hit ≈ $0.30 across 10
    // questions, with 30k cached + 1k fresh + 300 output ⇒ ~$0.03/question
    // worst case. Our bench profile is leaner (21k cached, 100 fresh, ~250
    // output) so the warm cost lands lower — ~$0.01. The AC-5 advisory bar
    // of $0.015 reflects this reality (the original $0.005 was too tight
    // because output tokens dominate at $15/MTok).
    const cost = computeCostUsd({
      input_tokens: 100,                 // ~recent transcript + question
      cache_read_input_tokens: 21_000,   // 20k context cache hit
      output_tokens: 250,                // typical answer
    });
    expect(cost).toBeLessThan(0.015); // AC-5 advisory bar
    expect(cost).toBeGreaterThan(0.005); // sanity floor — output tokens alone exceed this
  });
});
