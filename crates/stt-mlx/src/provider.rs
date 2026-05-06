// SttProvider trait + SttSegment + SttError + FakeStt.
// Per docs/ARCHITECTURE.md §3.1 (STT Interface) and Phase 1 T-1.5 task plan.
//
// Sync trait: callers (T-1.6 event bridge, T-1.9 state machine) own the per-chunk pump loop;
// the trait is one input chunk → one Vec of segments. Consumers will run the call on a
// blocking task (e.g. `tokio::task::spawn_blocking`) since real impls (MlxWhisperSubprocess)
// shell out to a Python subprocess. ARCH §3.1's async-stream shape is the IPC contract for
// the helper-daemon, not the per-provider trait.

use audio_capture::PcmChunk;
use thiserror::Error;

/// One transcribed segment emitted from a chunk's audio. Phase 1 always emits `is_final = true`
/// (no streaming partials); Phase 1.x `T-1.5b` adds partial+final hypothesis pairs once VAD
/// utterance boundaries land. Timestamps are absolute meeting-time millisec — already offset
/// by `chunk.ts_ms` so consumers don't have to re-stamp.
#[derive(Debug, Clone, PartialEq)]
pub struct SttSegment {
    pub text: String,
    pub start_ts_ms: u64,
    pub end_ts_ms: u64,
    pub is_final: bool,
    pub confidence: Option<f32>,
}

#[derive(Debug, Error)]
pub enum SttError {
    #[error("io error: {0}")]
    Io(String),

    #[error("subprocess spawn failed: {0}")]
    SubprocessSpawn(String),

    #[error("subprocess error: {0}")]
    Subprocess(String),

    #[error("decode error: {0}")]
    Decode(String),

    /// Configuration / pre-flight error — missing API key, malformed URL, unparseable
    /// header value, etc. Surfaced before any network IO so callers (settings UI test-
    /// connection button, factory) can present a typed actionable error rather than an
    /// opaque transport failure. Phase 3 T-3.2 (Deepgram adapter) introduced this variant;
    /// T-3.4 (ElevenLabs) and T-3.6 (Settings) reuse it.
    #[error("config error: {0}")]
    Config(String),
}

/// Object-safe trait for any STT engine. `Box<dyn SttProvider>` compiles + is `Send` so the
/// helper-daemon can hold the active provider behind a `Mutex<Box<dyn SttProvider>>` and
/// hot-swap it (Phase 3 T-3.1) without restarting the meeting.
pub trait SttProvider: Send {
    fn name(&self) -> &'static str;
    fn transcribe_chunk(&mut self, chunk: &PcmChunk) -> Result<Vec<SttSegment>, SttError>;
}

/// Deterministic in-process STT for tests and dev-time UI demos. Returns one fixed-text
/// segment per chunk with `confidence = Some(1.0)`. Used by T-1.6 / T-1.9 / T-1.13 tests
/// to avoid the MLX subprocess on CI.
pub struct FakeStt {
    pub fixed_text: String,
}

impl FakeStt {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            fixed_text: text.into(),
        }
    }
}

impl Default for FakeStt {
    fn default() -> Self {
        Self::new("fake transcript")
    }
}

impl SttProvider for FakeStt {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn transcribe_chunk(&mut self, chunk: &PcmChunk) -> Result<Vec<SttSegment>, SttError> {
        let dur_ms = duration_ms(chunk.samples.len(), chunk.sample_rate);
        Ok(vec![SttSegment {
            text: self.fixed_text.clone(),
            start_ts_ms: chunk.ts_ms,
            end_ts_ms: chunk.ts_ms.saturating_add(dur_ms),
            is_final: true,
            confidence: Some(1.0),
        }])
    }
}

/// Integer duration in ms from sample count + rate. Avoids `f64` rounding noise; saturates on
/// pathological zero-rate chunks (real chunks always have a positive `sample_rate`).
pub(crate) fn duration_ms(samples: usize, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    (samples as u64).saturating_mul(1000) / sample_rate as u64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use audio_capture::{Chunker, ChunkerConfig};

    fn fake_chunk(n: usize, rate: u32, ts: u64) -> PcmChunk {
        PcmChunk {
            samples: vec![0.0; n],
            sample_rate: rate,
            ts_ms: ts,
        }
    }

    #[test]
    fn fake_stt_returns_one_segment_with_fixed_text() {
        let mut stt = FakeStt::default();
        let chunk = fake_chunk(32_000, 16_000, 0);
        let segs = stt.transcribe_chunk(&chunk).expect("ok");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "fake transcript");
        assert!(segs[0].is_final);
    }

    #[test]
    fn fake_stt_segment_text_is_configurable() {
        let mut stt = FakeStt::new("hello world");
        let chunk = fake_chunk(16_000, 16_000, 4_000);
        let segs = stt.transcribe_chunk(&chunk).expect("ok");
        assert_eq!(segs[0].text, "hello world");
        assert_eq!(segs[0].start_ts_ms, 4_000);
        // 16_000 samples @ 16 kHz = 1_000 ms
        assert_eq!(segs[0].end_ts_ms, 5_000);
    }

    #[test]
    fn fake_stt_segment_duration_matches_chunk_samples() {
        let mut stt = FakeStt::default();
        let chunk = fake_chunk(8_000, 16_000, 100); // 0.5 s
        let segs = stt.transcribe_chunk(&chunk).expect("ok");
        assert_eq!(segs[0].start_ts_ms, 100);
        assert_eq!(segs[0].end_ts_ms, 600);
    }

    #[test]
    fn fake_stt_provides_unit_confidence() {
        let mut stt = FakeStt::default();
        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = stt.transcribe_chunk(&chunk).expect("ok");
        assert_eq!(segs[0].confidence, Some(1.0));
    }

    #[test]
    fn sttprovider_is_object_safe_and_send() {
        // Box<dyn SttProvider> compiles → object-safety holds.
        let mut boxed: Box<dyn SttProvider> = Box::new(FakeStt::default());
        let chunk = fake_chunk(32_000, 16_000, 0);
        let _ = boxed.transcribe_chunk(&chunk).unwrap();

        // Move into a thread → exercises the `: Send` bound.
        let handle = std::thread::spawn(move || {
            let mut b = boxed;
            b.transcribe_chunk(&fake_chunk(16_000, 16_000, 0))
                .expect("ok")
        });
        let segs = handle.join().expect("join");
        assert_eq!(segs.len(), 1);
        assert!(!segs[0].text.is_empty());
    }

    #[test]
    fn fake_stt_consumes_chunker_output() {
        // 5 seconds of synthetic PCM @ 16 kHz mono → Chunker drains 2 windows of 2 s each.
        let mut chunker = Chunker::new(ChunkerConfig::default());
        chunker.push(&vec![0.0; 80_000], 16_000, 1);

        let mut stt = FakeStt::default();
        let mut segments = Vec::new();
        while let Some(chunk) = chunker.try_next_chunk() {
            let segs = stt.transcribe_chunk(&chunk).expect("ok");
            segments.extend(segs);
        }
        assert!(segments.len() >= 2, "expected ≥ 2 segments, got {}", segments.len());
        for s in &segments {
            assert!(!s.text.is_empty());
        }
        // First segment timestamp = chunk[0].ts_ms = 0; second = 2_000 (per T-1.4 chunker).
        assert_eq!(segments[0].start_ts_ms, 0);
        assert_eq!(segments[1].start_ts_ms, 2_000);
    }

    #[test]
    fn duration_ms_handles_zero_sample_rate() {
        assert_eq!(duration_ms(16_000, 0), 0);
        assert_eq!(duration_ms(0, 16_000), 0);
        assert_eq!(duration_ms(16_000, 16_000), 1_000);
        assert_eq!(duration_ms(8_000, 16_000), 500);
    }
}
