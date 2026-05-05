// experimental, not for prod — Phase 0 T-0.5 pricing constants for Sonnet 4.6.
// Source: Anthropic public pricing page snapshot (2026-05). Verify before relying.
// Used by streamBench.ts to compute per-call cost from `usage` blocks.

export const SONNET_4_6_PRICING_USD_PER_MTOK = {
  input_uncached: 3.0,
  cache_creation_5m: 3.75,
  cache_read: 0.30,
  output: 15.0,
} as const;

export type Usage = {
  input_tokens: number;                // tokens NOT served from cache and NOT a cache write
  cache_creation_input_tokens?: number; // tokens written to cache this turn
  cache_read_input_tokens?: number;     // tokens served from cache this turn
  output_tokens: number;
};

export function computeCostUsd(u: Usage): number {
  const p = SONNET_4_6_PRICING_USD_PER_MTOK;
  const inFresh = (u.input_tokens / 1_000_000) * p.input_uncached;
  const inWrite = ((u.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cache_creation_5m;
  const inRead = ((u.cache_read_input_tokens ?? 0) / 1_000_000) * p.cache_read;
  const out = (u.output_tokens / 1_000_000) * p.output;
  return inFresh + inWrite + inRead + out;
}

export function cacheReadRatio(u: Usage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const fresh = u.input_tokens;
  const denom = read + write + fresh;
  if (denom === 0) return 0;
  return read / denom;
}
