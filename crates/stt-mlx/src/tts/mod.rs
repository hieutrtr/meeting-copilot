// Phase 3 T-3.7 — TTS (Text-to-Speech) interface + ElevenLabs adapter.
//
// The entire module is gated by `#[cfg(feature = "tts")]` (set in `Cargo.toml`,
// default OFF). Default builds dead-strip every `tts/*.rs` file: no compile cost,
// no symbols, no reachable code path. ARCH §4 ("V1 không bật TTS mặc định") is
// the binding spec — Phase 3 ships the seam, Phase 3.x flips the flag once
// audio routing on macOS (BlackHole virtual output) is verified on hardware.
//
// Layout:
//   - `provider.rs` — `TtsProvider` trait + `TtsAudioChunk` + `TtsSpeakOptions`
//     + `TtsError`. Sync trait (analogue of `SttProvider` in `crate::provider`).
//   - `elevenlabs.rs` — `ElevenLabsTtsAdapter` impl. Transport-injected: the
//     adapter takes a `Box<dyn TtsTransport + Send>` so tests can inject a
//     deterministic fake without pulling `reqwest` into the dep graph. Live
//     wiring (a `reqwest::blocking::Client` transport) is deferred to Phase 3.x.
//
// Public surface re-exported from `crate::tts::*` (and from the crate root via
// `pub use tts::{...}` in `lib.rs`):
//   `TtsProvider`, `TtsAudioChunk`, `TtsSpeakOptions`, `TtsError`,
//   `TtsRequest`, `TtsTransport`,
//   `ElevenLabsTtsAdapter`, `ElevenLabsTtsConfig`.
//
// Why no factory wiring: the STT factory (`providers::factory()`) returns
// `Box<dyn SttProvider>`. TTS is a sibling, distinct trait — bolting it onto the
// existing factory would conflate the two surfaces. A future `tts::factory()`
// can ship alongside if a second TTS provider lands (MLX TTS, ARCH §4 "MLX TTS
// thử nghiệm").

pub mod elevenlabs;
pub mod provider;

pub use elevenlabs::{ElevenLabsTtsAdapter, ElevenLabsTtsConfig};
pub use provider::{
    TtsAudioChunk, TtsError, TtsProvider, TtsRequest, TtsSpeakOptions, TtsTransport,
};
