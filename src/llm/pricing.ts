// Phase 1 T-1.10 — Sonnet 4.6 pricing constants + helpers (prod copy).
//
// Ported from `experiments/T-0.5/src/pricing.ts` so the prod path doesn't
// depend on a Phase 0 spike directory. Source: Anthropic public pricing
// snapshot 2026-05; verify before relying for billing-critical decisions.
//
// Cost AC for warm calls (per spike-memo C-3) = $0.015 advisory.

export const SONNET_4_6_PRICING_USD_PER_MTOK = {
  input_uncached: 3.0,
  cache_creation_5m: 3.75,
  cache_read: 0.3,
  output: 15.0,
} as const;

// Phase 2 T-2.3 — Haiku 4.5 pricing (Anthropic public pricing snapshot 2026-05).
// Used by the Stage-2 detector cost-per-call surface and consumed by T-2.7
// cost guard for the per-meeting projection. ARCH §13 budgets ~$0.0002/call,
// < $0.005/h on a 3-10 candidate/min meeting.
export const HAIKU_4_5_PRICING_USD_PER_MTOK = {
  input_uncached: 1.0,
  cache_creation_5m: 1.25,
  cache_read: 0.1,
  output: 5.0,
} as const;

export interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

interface PricingTable {
  readonly input_uncached: number;
  readonly cache_creation_5m: number;
  readonly cache_read: number;
  readonly output: number;
}

function _cost(p: PricingTable, u: AnthropicUsage): number {
  const inFresh = (u.input_tokens / 1_000_000) * p.input_uncached;
  const inWrite = ((u.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cache_creation_5m;
  const inRead = ((u.cache_read_input_tokens ?? 0) / 1_000_000) * p.cache_read;
  const out = (u.output_tokens / 1_000_000) * p.output;
  return inFresh + inWrite + inRead + out;
}

export function computeCostUsd(u: AnthropicUsage): number {
  return _cost(SONNET_4_6_PRICING_USD_PER_MTOK, u);
}

export function computeHaikuCostUsd(u: AnthropicUsage): number {
  return _cost(HAIKU_4_5_PRICING_USD_PER_MTOK, u);
}

export function cacheReadRatio(u: AnthropicUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const fresh = u.input_tokens;
  const denom = read + write + fresh;
  if (denom === 0) return 0;
  return read / denom;
}
