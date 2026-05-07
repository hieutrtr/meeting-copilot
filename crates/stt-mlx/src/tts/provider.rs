// `TtsProvider` trait + sibling types — Phase 3 T-3.7.
//
// Mirrors the shape of `crate::provider::SttProvider` (Phase 1 T-1.5): sync
// trait, `Send` bound for `Mutex<Box<dyn TtsProvider>>` hot-swap, one input
// (`text` + `opts`) → one output (`Vec<TtsAudioChunk>`). Caller pumps on a
// `tokio::task::spawn_blocking` boundary if the impl shells out to a network or
// subprocess.
//
// ARCH §4 reference (TS interface, transcribed for Rust):
//
//     interface TTSProvider {
//       name: "mlx" | "elevenlabs";
//       speak(text: string, opts: { voice: string }): AsyncIterable<AudioChunk>
//     }
//
// The TS interface returns an async iterable so the audio player can render
// the first chunk before the full synthesis is done (latency target < 400 ms
// first audio per ARCH §4). The Rust adapter currently returns the full
// `Vec<TtsAudioChunk>` because the production path is fronted by the TS
// `ElevenLabsTts` (uses `fetch` + `ReadableStream` reader); the Rust adapter
// exists for future Tauri command wiring + structural test parity. When that
// wiring lands, the Rust adapter can swap to `Iterator<Item = TtsAudioChunk>`
// — additive change, no consumer break.

use thiserror::Error;

/// One synthesised audio buffer. PCM 16-bit signed, mono, sample-rate stamped
/// from the request (ElevenLabs `output_format` defaults to `pcm_16000` —
/// matches the helper-daemon's input convention so a future "TTS-as-mic"
/// loopback path needs no resampling).
///
/// `ts_ms` is relative to the `speak()` call — `0` for the first chunk, then
/// the running sum of preceding chunk durations. Consumers (audio player) use
/// it for play-out scheduling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TtsAudioChunk {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
    pub ts_ms: u64,
}

impl TtsAudioChunk {
    /// Duration of this chunk in milliseconds. Saturates on a zero sample-rate
    /// (degenerate input — should never happen on production paths).
    pub fn duration_ms(&self) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        (self.samples.len() as u64).saturating_mul(1000) / self.sample_rate as u64
    }
}

/// Per-call options for `TtsProvider::speak`. Voice ID is the ElevenLabs voice
/// identifier (long alphanumeric string, e.g. `"21m00Tcm4TlvDq8ikWAM"` for
/// "Rachel"). Future opts (stability, similarity_boost) can extend additively.
#[derive(Debug, Clone)]
pub struct TtsSpeakOptions {
    pub voice: String,
}

impl TtsSpeakOptions {
    pub fn new(voice: impl Into<String>) -> Self {
        Self {
            voice: voice.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum TtsError {
    /// Configuration / pre-flight error — missing API key, malformed URL, etc.
    /// Surfaced before any network IO so callers (settings UI test-connection
    /// button, factory) can present a typed actionable error rather than an
    /// opaque transport failure. Mirrors `SttError::Config` from T-3.2/T-3.4.
    #[error("config error: {0}")]
    Config(String),

    /// Transport failure — network IO, transport-injected mock returning an
    /// error, or the live HTTP transport surfacing a non-2xx status.
    #[error("io error: {0}")]
    Io(String),

    /// Decode failure — the response payload could not be parsed into PCM
    /// samples (e.g. odd number of bytes for i16 LE pairs, or an unexpected
    /// content-type). Distinct from `Io` so the live HTTP transport can
    /// differentiate "couldn't reach the server" from "got a response we don't
    /// understand".
    #[error("decode error: {0}")]
    Decode(String),
}

/// Object-safe trait for any TTS engine. `Box<dyn TtsProvider>` compiles + is
/// `Send` so the helper-daemon (when it lands) can hold the active provider
/// behind a `Mutex<Box<dyn TtsProvider>>` and hot-swap.
pub trait TtsProvider: Send {
    fn name(&self) -> &'static str;
    /// Synthesize `text` into PCM audio chunks. Blocking; caller pumps on a
    /// `tokio::task::spawn_blocking` boundary.
    fn speak(
        &mut self,
        text: &str,
        opts: &TtsSpeakOptions,
    ) -> Result<Vec<TtsAudioChunk>, TtsError>;
}

// ---------------------------------------------------------------------------
// Transport seam — used by `ElevenLabsTtsAdapter` to keep `reqwest` out of the
// default dep graph. Tests inject a `FakeTransport`; the live wire-up (Phase
// 3.x) plugs in a `reqwest::blocking::Client`-backed transport.
// ---------------------------------------------------------------------------

/// HTTP-shaped request carried over `TtsTransport::execute`. The shape is
/// agnostic to the transport (live HTTP, fake, in-process Tauri command) so a
/// future Tauri-bridge transport can plug in without changing the adapter.
#[derive(Debug, Clone)]
pub struct TtsRequest {
    pub url: String,
    pub method: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Transport seam — execute one TTS request, return the response body bytes.
/// Implementations: `tts::elevenlabs::tests::FakeTransport` (deterministic,
/// returns a pre-recorded PCM payload); a future `ReqwestBlockingTransport`
/// (live HTTP, gated behind a deeper feature flag).
pub trait TtsTransport: Send {
    fn execute(&mut self, req: TtsRequest) -> Result<Vec<u8>, TtsError>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Trait must be object-safe + `Send` so it compiles inside a
    /// `Mutex<Box<dyn TtsProvider>>` (the runtime hot-swap pattern, even though
    /// no swap call site exists yet — the constraint stays for parity with
    /// `SttProvider`). A no-op shim is enough; we just need the constraint to
    /// hold.
    struct NoopTts;
    impl TtsProvider for NoopTts {
        fn name(&self) -> &'static str {
            "noop"
        }
        fn speak(
            &mut self,
            _text: &str,
            _opts: &TtsSpeakOptions,
        ) -> Result<Vec<TtsAudioChunk>, TtsError> {
            Ok(vec![])
        }
    }

    #[test]
    fn ttsprovider_is_object_safe_and_send() {
        let mut boxed: Box<dyn TtsProvider> = Box::new(NoopTts);
        let opts = TtsSpeakOptions::new("test-voice");
        let out = boxed.speak("hi", &opts).unwrap();
        assert!(out.is_empty());

        // Move into a thread to exercise `: Send`.
        let handle = std::thread::spawn(move || {
            let mut b = boxed;
            b.speak("threaded", &TtsSpeakOptions::new("test-voice"))
                .unwrap()
        });
        let segs = handle.join().unwrap();
        assert!(segs.is_empty());
    }

    #[test]
    fn audio_chunk_duration_ms_at_16khz() {
        let chunk = TtsAudioChunk {
            samples: vec![0; 16_000],
            sample_rate: 16_000,
            ts_ms: 0,
        };
        assert_eq!(chunk.duration_ms(), 1_000);
    }

    #[test]
    fn audio_chunk_duration_ms_handles_zero_rate() {
        let chunk = TtsAudioChunk {
            samples: vec![0; 16_000],
            sample_rate: 0,
            ts_ms: 0,
        };
        assert_eq!(chunk.duration_ms(), 0);
    }

    #[test]
    fn audio_chunk_duration_ms_partial_buffer() {
        // 8 000 samples @ 16 kHz = 0.5 s = 500 ms.
        let chunk = TtsAudioChunk {
            samples: vec![0; 8_000],
            sample_rate: 16_000,
            ts_ms: 500,
        };
        assert_eq!(chunk.duration_ms(), 500);
    }

    #[test]
    fn tts_speak_options_constructor_takes_string_or_str() {
        let a = TtsSpeakOptions::new("rachel");
        let b = TtsSpeakOptions::new(String::from("rachel"));
        assert_eq!(a.voice, b.voice);
    }

    #[test]
    fn tts_error_variants_format_distinctly() {
        let cfg = TtsError::Config("missing key".into());
        let io = TtsError::Io("connection refused".into());
        let dec = TtsError::Decode("odd byte count".into());
        assert!(cfg.to_string().contains("config"));
        assert!(io.to_string().contains("io"));
        assert!(dec.to_string().contains("decode"));
    }
}
