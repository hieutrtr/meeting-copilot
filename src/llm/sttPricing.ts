// Phase 3 T-3.5 — Per-provider STT pricing constants + helper.
//
// Rates pinned to docs/ARCHITECTURE.md §3.2 "Implementations":
//   - MLX local (default)        → $0 (lines 103-108).
//   - Deepgram WebSocket         → $0.0043 / minute (line 113).
//   - ElevenLabs Speech-to-Text  → $0.40 / hour (line 119).
//   - Fake (test stub)           → $0.
//
// Provider IDs (`mlx`, `fake`, `deepgram`, `elevenlabs`) MUST match the Rust
// `ProviderKind::as_str()` returned by `crates/stt-mlx/src/providers/mod.rs::ProviderKind::as_str`
// — drift here breaks the v2 settings schema (T-3.6) since persisted picker values
// round-trip through both surfaces. The parity test in `sttPricing.test.ts` (ST-S9)
// is the gate.
//
// On price drift: update both this file and `docs/provider-comparison.md` (T-3.10).
// A single grep for `0.0043` or `0.40` finds every reference.

export const MLX_USD_PER_MINUTE = 0 as const;
export const FAKE_USD_PER_MINUTE = 0 as const;
export const DEEPGRAM_USD_PER_MINUTE = 0.0043 as const;
export const ELEVENLABS_USD_PER_HOUR = 0.4 as const;
export const ELEVENLABS_USD_PER_MINUTE = ELEVENLABS_USD_PER_HOUR / 60;

export const STT_PROVIDER_USD_PER_MINUTE = {
  mlx: MLX_USD_PER_MINUTE,
  fake: FAKE_USD_PER_MINUTE,
  deepgram: DEEPGRAM_USD_PER_MINUTE,
  elevenlabs: ELEVENLABS_USD_PER_MINUTE,
} as const;

export type SttProviderId = keyof typeof STT_PROVIDER_USD_PER_MINUTE;

export const STT_PROVIDER_IDS: readonly SttProviderId[] = Object.freeze([
  "mlx",
  "fake",
  "deepgram",
  "elevenlabs",
]);

export function isSttProviderId(value: unknown): value is SttProviderId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(STT_PROVIDER_USD_PER_MINUTE, value)
  );
}

/**
 * Compute the streaming USD cost for a chunk of `audioSeconds` at the given
 * provider's per-minute rate.
 *
 * Defensive: non-positive (or non-finite) `audioSeconds` clamps to 0. The helper-daemon
 * may emit a late-arriving partial whose `(endTs - startTs)` goes negative; the meter
 * drops it from the cost ledger rather than the transcript stream.
 */
export function computeSttCostUsd(provider: SttProviderId, audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 0;
  const ratePerMin = STT_PROVIDER_USD_PER_MINUTE[provider];
  return (audioSeconds / 60) * ratePerMin;
}
