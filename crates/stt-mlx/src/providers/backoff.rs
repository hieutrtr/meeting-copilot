// Shared bounded-reconnect / retry policy — Phase 3 T-3.4.
//
// This module exists to break the coupling between adapters that share a streaming
// WebSocket transport. T-3.3 introduced `BackoffConfig` inside `providers::deepgram`
// with a comment explicitly anticipating reuse by T-3.4 (ElevenLabs Scribe). When
// both adapters lived behind the `deepgram` feature flag the in-place definition was
// fine; T-3.4 needs to compile the ElevenLabs adapter without `deepgram`, which means
// the type must live in a feature-ungated location.
//
// Behavior is **byte-identical** to the original `providers::deepgram::BackoffConfig`
// (T-3.3 commit `8108a15`). Defaults, math (`next_delay`, `jittered`), and clock-derived
// jitter sample are all moved verbatim. The `providers::deepgram` module re-exports
// `BackoffConfig` (`pub use crate::providers::backoff::BackoffConfig`) so existing call
// sites — `crate::providers::deepgram::BackoffConfig`, `stt_mlx::BackoffConfig` —
// continue to resolve to the same type.
//
// Rationale for placement:
// - `provider.rs` (where `SttProvider` + `SttError` live) describes the trait surface;
//   layering reconnect policy there would conflate "what an STT provider is" with "how
//   *some* STT providers handle their transport". Network adapters only.
// - `providers/mod.rs` could host it, but a dedicated file keeps the module header focused
//   on the factory pattern.
// - `providers/backoff.rs` — small, named, lives next to its consumers (`deepgram.rs`
//   and `elevenlabs.rs`). Tests for the schedule remain in `deepgram.rs` (where T-3.3
//   authored them) — the migration is the type definition only, not the test surface.
//   T-3.4 adds its own ElevenLabs-flavoured smoke test on top (operational reuse, not
//   schedule re-coverage).

use std::time::Duration;

/// Bounded reconnect / retry policy. Used by streaming-WS adapters' `connect_with_backoff`
/// to cap the wall-clock spent on transient transport failures before surfacing
/// `SttError::ProviderUnavailable`.
///
/// Defaults (200 ms initial, 2.0× multiplier, 3 s cap, 3 attempts, ±25 % jitter) keep the
/// worst-case wall-clock at ~5 s per call (200 + 400 + 800 + small jitter), well under
/// the Phase 3 AC of "reconnect within 10 s". Tests override with shorter delays so the
/// chaos suite finishes in tens of milliseconds.
///
/// `max_retries` counts *total* connect attempts (not retries-after-first), so `1` =
/// no retries (single attempt then fail). `0` is normalized to `1` at use-time.
#[derive(Debug, Clone)]
pub struct BackoffConfig {
    pub initial_delay: Duration,
    pub multiplier: f32,
    pub max_delay: Duration,
    pub max_retries: u32,
    /// Symmetric jitter as a fraction of the current delay. `0.0` = deterministic;
    /// `0.25` = each sleep is uniformly distributed in `[0.75d, 1.25d]`. Bounded
    /// upper-side to avoid pathological waits when `multiplier × delay` already
    /// approaches `max_delay`.
    pub jitter: f32,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_millis(200),
            multiplier: 2.0,
            max_delay: Duration::from_secs(3),
            max_retries: 3,
            jitter: 0.25,
        }
    }
}

impl BackoffConfig {
    /// Apply the multiplier-and-cap rule once. Pure (no sleep, no I/O) so this is the
    /// unit-test seam for the backoff schedule. Result is rounded to whole milliseconds —
    /// `Duration::mul_f32` produces sub-microsecond f32 noise on otherwise-round inputs
    /// (e.g. `100ms × 2.0 = 200.000003ms`) which sleep can't honour anyway.
    pub fn next_delay(&self, current: Duration) -> Duration {
        let scaled = round_to_ms(current.mul_f32(self.multiplier.max(1.0)));
        if scaled > self.max_delay {
            self.max_delay
        } else {
            scaled
        }
    }

    /// Apply jitter in `[1-j, 1+j]` to `d`. Deterministic for `jitter == 0.0`.
    /// `pseudo_unit_sample` is in `[0.0, 1.0]` — the caller injects randomness so this
    /// helper stays pure and testable. Rounded to whole milliseconds (see `next_delay`).
    pub fn jittered(&self, d: Duration, pseudo_unit_sample: f32) -> Duration {
        let j = self.jitter.clamp(0.0, 1.0);
        if j == 0.0 {
            return d;
        }
        let s = pseudo_unit_sample.clamp(0.0, 1.0);
        let factor = (1.0 - j) + (s * 2.0 * j); // ∈ [1-j, 1+j]
        round_to_ms(d.mul_f32(factor))
    }
}

/// Round a Duration to the nearest whole millisecond. `Duration::mul_f32` produces
/// sub-microsecond f32 quantisation noise on otherwise-round inputs (e.g.
/// `100ms × 2.0` resolves to `200.000003ms` instead of `200ms`). `thread::sleep`
/// cannot honour sub-millisecond precision anyway, and downstream tests assert
/// against `Duration::from_millis(_)` literals — so collapse to ms at the source.
fn round_to_ms(d: Duration) -> Duration {
    let nanos = d.as_nanos();
    let ms = (nanos + 500_000) / 1_000_000;
    Duration::from_millis(ms.min(u64::MAX as u128) as u64)
}

/// Cheap pseudo-random unit sample in `[0.0, 1.0]` derived from the system clock — good
/// enough for connect-storm jitter (we only need to de-correlate parallel reconnect
/// attempts; cryptographic randomness is overkill). Lives here so adapters don't
/// pull in `rand` for one float.
pub fn clock_jitter_sample() -> f32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 10_000) as f32 / 10_000.0
}
