// Phase 1 T-1.10 — pricing math (CL-S12 / CL-S13).
//
// Mirrors the spike's `experiments/T-0.5/tests/pricing.test.ts` against the
// prod copy of the constants. Phase 0 spike is read-only per loop rule.

import { describe, expect, it } from "vitest";

import {
  cacheReadRatio,
  computeCostUsd,
  computeHaikuCostUsd,
  HAIKU_4_5_PRICING_USD_PER_MTOK,
  SONNET_4_6_PRICING_USD_PER_MTOK,
} from "./pricing";

describe("CL-S13: Sonnet 4.6 pricing math", () => {
  it("uncached input math matches the public rate ($3 / MTok)", () => {
    const cost = computeCostUsd({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(cost).toBeCloseTo(SONNET_4_6_PRICING_USD_PER_MTOK.input_uncached, 6);
  });

  it("cache read is ~10x cheaper than uncached input ($3.00 / $0.30)", () => {
    const uncached = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const cached = computeCostUsd({
      input_tokens: 0,
      cache_read_input_tokens: 100_000,
      output_tokens: 0,
    });
    expect(uncached / cached).toBeCloseTo(10, 0);
  });

  it("cache write is ~1.25x uncached input ($3.75 / $3.00)", () => {
    const uncached = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const write = computeCostUsd({
      input_tokens: 0,
      cache_creation_input_tokens: 100_000,
      output_tokens: 0,
    });
    expect(write / uncached).toBeCloseTo(1.25, 1);
  });

  it("output tokens cost 5x uncached input ($15 / $3)", () => {
    const inn = computeCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const out = computeCostUsd({ input_tokens: 0, output_tokens: 100_000 });
    expect(out / inn).toBeCloseTo(5, 0);
  });

  it("warm-call cost lands under the $0.015 advisory bar (spike-memo C-3)", () => {
    const cost = computeCostUsd({
      input_tokens: 100,
      cache_read_input_tokens: 21_000,
      output_tokens: 250,
    });
    expect(cost).toBeLessThan(0.015);
    expect(cost).toBeGreaterThan(0.005);
  });
});

describe("T-2.3: Haiku 4.5 pricing math", () => {
  it("uncached input math matches the public rate ($1 / MTok)", () => {
    const cost = computeHaikuCostUsd({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(cost).toBeCloseTo(HAIKU_4_5_PRICING_USD_PER_MTOK.input_uncached, 6);
  });

  it("Haiku is ~3x cheaper than Sonnet on uncached input ($1.00 / $3.00)", () => {
    const sonnet = computeCostUsd({ input_tokens: 1_000_000, output_tokens: 0 });
    const haiku = computeHaikuCostUsd({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(sonnet / haiku).toBeCloseTo(3, 1);
  });

  it("Haiku is ~3x cheaper than Sonnet on output tokens ($5 / $15)", () => {
    const sonnet = computeCostUsd({ input_tokens: 0, output_tokens: 1_000_000 });
    const haiku = computeHaikuCostUsd({ input_tokens: 0, output_tokens: 1_000_000 });
    expect(sonnet / haiku).toBeCloseTo(3, 1);
  });

  it("Haiku per-call cost on a typical filter-shaped usage (~150 in, ~30 out) lands < $0.001", () => {
    const cost = computeHaikuCostUsd({
      input_tokens: 150,
      output_tokens: 30,
    });
    expect(cost).toBeLessThan(0.001);
    expect(cost).toBeGreaterThan(0);
  });

  it("Haiku cache_read is ~10x cheaper than uncached input ($1.00 / $0.10)", () => {
    const uncached = computeHaikuCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const cached = computeHaikuCostUsd({
      input_tokens: 0,
      cache_read_input_tokens: 100_000,
      output_tokens: 0,
    });
    expect(uncached / cached).toBeCloseTo(10, 0);
  });

  it("Haiku output costs 5x uncached input ($5 / $1)", () => {
    const inn = computeHaikuCostUsd({ input_tokens: 100_000, output_tokens: 0 });
    const out = computeHaikuCostUsd({ input_tokens: 0, output_tokens: 100_000 });
    expect(out / inn).toBeCloseTo(5, 0);
  });
});

describe("CL-S12: cacheReadRatio", () => {
  it("returns 0 when no cache reads (cold call)", () => {
    const r = cacheReadRatio({
      input_tokens: 5,
      cache_creation_input_tokens: 21_000,
      cache_read_input_tokens: 0,
      output_tokens: 200,
    });
    expect(r).toBeCloseTo(0, 3);
  });

  it("returns >0.99 when warm-call hits cache for ~all input", () => {
    const r = cacheReadRatio({
      input_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 21_000,
      output_tokens: 200,
    });
    expect(r).toBeGreaterThan(0.99);
  });

  it("returns 0 (not NaN) when usage is empty", () => {
    const r = cacheReadRatio({ input_tokens: 0, output_tokens: 0 });
    expect(r).toBe(0);
  });
});
