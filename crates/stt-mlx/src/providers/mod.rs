// providers — Phase 3 T-3.1 (Pluggable STT providers).
//
// Trait-extraction refactor: the `SttProvider` trait + `SttSegment` + `SttError` + `FakeStt`
// already exist in `crate::provider` (Phase 1 T-1.5). This module adds:
//
//   1. `ProviderKind` — caller-facing enum identifying which adapter to instantiate.
//   2. `ProviderConfig` — adapter-specific construction config (per-variant payload).
//   3. `factory(kind, cfg) -> Result<Box<dyn SttProvider>, FactoryError>` — single seam the
//      helper-daemon (Phase 3 T-3.1) and src-tauri commands (Phase 3 T-3.6 settings UI) call
//      to swap providers at runtime without restarting the meeting.
//
// Phase 3 T-3.2 fills in `Deepgram`; T-3.4 fills in `ElevenLabs`. T-3.1's job is the trait
// extraction + factory pattern + carry-forward Phase 1/2 cargo test green. **Behavior of
// existing adapters (MLX + Fake) is unchanged** — relocation + factory wiring only.
//
// ARCH refs: §3 "STT — Pluggable Provider" (3.1 interface, 3.2 default = MLX, 3.3 alternates
// = Deepgram / ElevenLabs Scribe).

use crate::provider::{FakeStt, SttError, SttProvider};

#[cfg(feature = "mlx-runtime")]
pub mod mlx;

#[cfg(feature = "mlx-runtime")]
pub use mlx::{MlxConfig, MlxWhisperSubprocess};

/// Identifier for an STT provider. Phase 3 T-3.1 ships `Mlx` + `Fake`; T-3.2 adds `Deepgram`,
/// T-3.4 adds `ElevenLabs`. Variants stay flat (no nested config) so the kind alone can be
/// serialised into settings (`src/store/settingsStore.ts` v2 schema, T-3.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    Mlx,
    Fake,
    // Deepgram,    — added in T-3.2
    // ElevenLabs,  — added in T-3.4
}

impl ProviderKind {
    /// Stable string ID used in settings persistence + telemetry log lines (T-3.9). Distinct
    /// from `SttProvider::name()` which is the runtime instance name (e.g. `MlxWhisperSubprocess`
    /// reports `"mlx-whisper"`); kind IDs are the user-facing picker values.
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Mlx => "mlx",
            ProviderKind::Fake => "fake",
        }
    }
}

/// Config payload for `factory()`. One variant per `ProviderKind`. Mismatched
/// (kind, config) pairs surface as `FactoryError::ConfigMismatch` so the typo path is
/// loud rather than silent.
#[derive(Debug, Clone)]
pub enum ProviderConfig {
    #[cfg(feature = "mlx-runtime")]
    Mlx(MlxConfig),
    Fake(FakeConfig),
}

/// Construction config for the deterministic in-process `FakeStt`. `fixed_text = None`
/// means "use `FakeStt::default()`'s built-in placeholder" — keeps the call sites in
/// helper-daemon tests compact.
#[derive(Debug, Clone, Default)]
pub struct FakeConfig {
    pub fixed_text: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum FactoryError {
    /// `ProviderKind` requested but the cargo feature gating its impl is off. The helper-daemon
    /// builds `stt-mlx` with `default-features = false` (no `mlx-runtime`) — calling
    /// `factory(Mlx, …)` from that build returns this. Settings UI (T-3.6) uses this to grey
    /// out unavailable providers in the picker.
    #[error("provider {0:?} disabled in this build (missing feature flag)")]
    ProviderDisabled(ProviderKind),

    /// The `(kind, config)` pair didn't match — programmer error in the call site rather than
    /// a runtime config issue. Distinct from `ProviderDisabled` so settings UI (T-3.6) can tell
    /// "you didn't pass the right config struct" from "this provider isn't available on this
    /// build".
    #[error("provider {kind:?} requires matching ProviderConfig variant")]
    ConfigMismatch { kind: ProviderKind },

    /// Underlying provider construction failed (e.g. MLX `work_dir` couldn't be created, future
    /// Deepgram WS handshake refused). Wraps `SttError` so callers can pattern-match on the root
    /// cause without unwrapping a chain.
    #[error("stt construction error: {0}")]
    Stt(#[from] SttError),
}

/// Construct a boxed `dyn SttProvider` for `kind` using `cfg`. The single seam the
/// runtime + UI use to hot-swap providers. Callers hold the result behind a
/// `Mutex<Box<dyn SttProvider>>` (helper-daemon T-3.1) so swapping is just `*guard = factory(...)?`.
///
/// Stays object-safe: returns `Box<dyn SttProvider>` and the trait already requires `Send`
/// (verified by the carry-forward `sttprovider_is_object_safe_and_send` test in
/// `crate::provider::tests`).
pub fn factory(
    kind: ProviderKind,
    cfg: ProviderConfig,
) -> Result<Box<dyn SttProvider>, FactoryError> {
    match (kind, cfg) {
        #[cfg(feature = "mlx-runtime")]
        (ProviderKind::Mlx, ProviderConfig::Mlx(c)) => {
            let p = MlxWhisperSubprocess::new(c)?;
            Ok(Box::new(p))
        }
        (ProviderKind::Fake, ProviderConfig::Fake(c)) => {
            let p = match c.fixed_text {
                Some(text) => FakeStt::new(text),
                None => FakeStt::default(),
            };
            Ok(Box::new(p))
        }
        // `mlx-runtime` off + `Mlx` requested.
        #[cfg(not(feature = "mlx-runtime"))]
        (ProviderKind::Mlx, _) => Err(FactoryError::ProviderDisabled(ProviderKind::Mlx)),
        // Any other combination = programmer error: kind/config variant mismatch.
        // Only reachable under `mlx-runtime`-on (where the (Mlx, Fake) and (Fake, Mlx) cells
        // exist); under `mlx-runtime`-off the two arms above are exhaustive.
        #[cfg(feature = "mlx-runtime")]
        (k, _) => Err(FactoryError::ConfigMismatch { kind: k }),
    }
}

// ---------------------------------------------------------------------------
// Tests — T-3.1 carry-forward + new factory regression.
// ---------------------------------------------------------------------------
//
// The Phase 1/2 regression contract: the trait surface (`SttProvider::transcribe_chunk`),
// the `SttSegment` shape, the `FakeStt` reference impl, and the `MlxWhisperSubprocess`
// production path all behave **byte-identically** to Phase 2's last green commit. Tests
// in `crate::provider::tests` and `crate::providers::mlx::tests` re-run unchanged after
// the relocation; the new `factory` tests below assert the seam itself is sound.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{FakeStt, SttProvider};
    use audio_capture::PcmChunk;

    fn fake_chunk(n: usize, rate: u32, ts: u64) -> PcmChunk {
        PcmChunk {
            samples: vec![0.0; n],
            sample_rate: rate,
            ts_ms: ts,
        }
    }

    #[test]
    fn factory_kind_as_str_stable() {
        // `as_str()` is the persisted settings key — drift here breaks v2 migration in T-3.6.
        assert_eq!(ProviderKind::Mlx.as_str(), "mlx");
        assert_eq!(ProviderKind::Fake.as_str(), "fake");
    }

    #[test]
    fn factory_fake_returns_boxed_trait_object() {
        // Assertion #1: factory hands back a `Box<dyn SttProvider>` — trait-object compile = pass.
        let mut p: Box<dyn SttProvider> =
            factory(ProviderKind::Fake, ProviderConfig::Fake(FakeConfig::default()))
                .expect("factory(Fake, default) should succeed");
        assert_eq!(p.name(), "fake");
        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = p.transcribe_chunk(&chunk).expect("transcribe");
        assert_eq!(segs.len(), 1);
        // Default fixed_text path goes through `FakeStt::default()` → "fake transcript".
        assert_eq!(segs[0].text, "fake transcript");
    }

    #[test]
    fn factory_fake_honours_fixed_text_override() {
        let cfg = ProviderConfig::Fake(FakeConfig {
            fixed_text: Some("hello phase 3".into()),
        });
        let mut p = factory(ProviderKind::Fake, cfg).expect("factory");
        let chunk = fake_chunk(32_000, 16_000, 4_000);
        let segs = p.transcribe_chunk(&chunk).expect("transcribe");
        assert_eq!(segs[0].text, "hello phase 3");
        assert_eq!(segs[0].start_ts_ms, 4_000);
        assert_eq!(segs[0].end_ts_ms, 6_000); // 32k samples @ 16 kHz = 2_000 ms
    }

    #[test]
    fn factory_kind_config_mismatch_is_typed_error() {
        // Pass `ProviderKind::Mlx` against a `Fake` config — programmer error path.
        let cfg = ProviderConfig::Fake(FakeConfig::default());
        let err = factory(ProviderKind::Mlx, cfg).expect_err("mismatch must error");
        match err {
            #[cfg(feature = "mlx-runtime")]
            FactoryError::ConfigMismatch { kind } => assert_eq!(kind, ProviderKind::Mlx),
            #[cfg(not(feature = "mlx-runtime"))]
            FactoryError::ProviderDisabled(ProviderKind::Mlx) => (),
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    /// Behavioral parity: a provider obtained via `factory()` must produce **byte-identical**
    /// output to a directly-constructed `FakeStt::new()` for the same input. This is the
    /// core regression test for T-3.1 — proves the factory seam is a pass-through, no
    /// transformation, no shadow state.
    #[test]
    fn factory_fake_byte_identical_to_direct_construction() {
        let mut direct = FakeStt::new("byte parity");
        let mut via_factory = factory(
            ProviderKind::Fake,
            ProviderConfig::Fake(FakeConfig {
                fixed_text: Some("byte parity".into()),
            }),
        )
        .expect("factory");

        // Same chunk, same outputs.
        let chunk = fake_chunk(48_000, 16_000, 100);
        let direct_segs = direct.transcribe_chunk(&chunk).expect("direct");
        let factory_segs = via_factory.transcribe_chunk(&chunk).expect("factory");
        assert_eq!(direct_segs, factory_segs);
    }

    /// Phase 2 question-detection pipeline regression — through the trait seam.
    ///
    /// The TS-side question detector (`src/detector/heuristic.ts`, T-2.1) reads
    /// `TranscriptChunk.text` strings via the helper-daemon's `transcript:chunk` event
    /// (helper-daemon `EventBridge::pump_one` — T-1.6). The Rust seam is:
    ///
    ///   `Chunker → SttProvider::transcribe_chunk(&chunk) → SttSegment → TranscriptChunk JSON`
    ///
    /// T-3.1 only relocates `MLX` impl + adds the factory; the seam shape is fixed. This test
    /// drives a representative question utterance ("What time is the meeting?" — exactly the
    /// kind of string T-2.1's heuristic detector would receive) through the factory's
    /// `Box<dyn SttProvider>` and asserts the segment text is preserved verbatim — i.e. the
    /// trait extraction did not perturb whitespace, casing, punctuation, or timestamp offsets
    /// on the boundary the question detector reads.
    #[test]
    fn factory_preserves_text_for_phase2_question_detector() {
        // The fixture string mirrors `shared/fixtures/question-detector-50.json`'s `q-en-01`
        // shape (English question with trailing `?`). T-2.1 asserts `detectCandidate()` would
        // mark this as a candidate; T-3.1's job is to prove the upstream trait-object pipeline
        // delivers the string unchanged.
        let utterance = "What time is the meeting?";
        let mut p = factory(
            ProviderKind::Fake,
            ProviderConfig::Fake(FakeConfig {
                fixed_text: Some(utterance.into()),
            }),
        )
        .expect("factory");

        // 2 s of silent PCM @ 16 kHz — matches the Chunker's default 2 s window (T-1.4).
        let chunk = fake_chunk(32_000, 16_000, 0);
        let segs = p.transcribe_chunk(&chunk).expect("transcribe");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, utterance, "text must round-trip the trait verbatim");
        assert_eq!(segs[0].start_ts_ms, 0);
        assert_eq!(segs[0].end_ts_ms, 2_000);
        assert!(segs[0].is_final);
    }

    /// Mirror of `crate::provider::tests::sttprovider_is_object_safe_and_send` but exercised
    /// through the `factory()` seam — the boxed value must be `Send` so helper-daemon's
    /// `Mutex<Box<dyn SttProvider>>` swap pattern (Phase 3 T-3.1) compiles.
    #[test]
    fn factory_output_is_send_and_swappable_under_mutex() {
        use std::sync::Mutex;

        let p =
            factory(ProviderKind::Fake, ProviderConfig::Fake(FakeConfig::default())).expect("factory");
        let slot: Mutex<Box<dyn SttProvider>> = Mutex::new(p);

        // Hot-swap: replace the provider behind the Mutex without un-locking + re-locking
        // the surrounding meeting state. This is the runtime-switch primitive T-3.6 builds on.
        let next = factory(
            ProviderKind::Fake,
            ProviderConfig::Fake(FakeConfig {
                fixed_text: Some("swapped".into()),
            }),
        )
        .expect("factory");
        *slot.lock().expect("lock") = next;

        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = slot
            .lock()
            .expect("lock")
            .transcribe_chunk(&chunk)
            .expect("transcribe");
        assert_eq!(segs[0].text, "swapped");
    }

    #[cfg(feature = "mlx-runtime")]
    #[test]
    fn factory_mlx_constructs_subprocess_struct() {
        // Construction-only smoke. Does NOT spawn Python — `MlxWhisperSubprocess::new()` only
        // creates `work_dir` + writes `transcribe.py`. The hardware-verify path (Python +
        // mlx_whisper) lives in `providers::mlx::tests::mlx_subprocess_transcribes_short_utterance`.
        let dir = std::env::temp_dir().join(format!(
            "mc-stt-mlx-factory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let cfg = ProviderConfig::Mlx(MlxConfig {
            work_dir: dir.clone(),
            ..MlxConfig::default()
        });
        let p = factory(ProviderKind::Mlx, cfg).expect("factory(Mlx) construct");
        assert_eq!(p.name(), "mlx-whisper");
        assert!(dir.join("transcribe.py").exists(), "script written by ctor");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
