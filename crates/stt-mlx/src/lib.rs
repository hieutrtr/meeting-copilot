// stt-mlx — Phase 1 T-1.5 (initial trait + MLX impl) + Phase 3 T-3.1 (pluggable provider
// factory) + Phase 3 T-3.2 (Deepgram WebSocket adapter) + Phase 3 T-3.3 (reconnect /
// chaos handling — bounded backoff + `ProviderUnavailable` typed error) + Phase 3 T-3.4
// (ElevenLabs Scribe streaming WebSocket adapter).
//
// Public surface (stable across the T-3.1 refactor — helper-daemon imports these by name):
// - `provider::{SttProvider, SttSegment, SttError, FakeStt}` — always available. T-3.3
//   adds `SttError::ProviderUnavailable { attempts, last_error }` (additive variant).
// - `providers::{ProviderKind, ProviderConfig, FakeConfig, FactoryError, factory}` — Phase 3 seam.
// - `providers::backoff::BackoffConfig` — feature-ungated; shared by every streaming-WS
//   adapter (T-3.2 Deepgram, T-3.4 ElevenLabs). T-3.4 relocated this from
//   `providers::deepgram` so the type isn't gated on the `deepgram` feature; the
//   `deepgram` module re-exports it via `pub use` for back-compat with T-3.3 callers.
// - `providers::mlx::{MlxConfig, MlxWhisperSubprocess}` — gated by feature `mlx-runtime`
//   (default-on). Disabled for headless CI / helper-daemon (`default-features = false`) where
//   Python is not installed; the trait + FakeStt + factory(Fake, …) remain.
// - `providers::deepgram::{DeepgramAdapter, DeepgramConfig, BackoffConfig}` — gated by feature
//   `deepgram` (default-on). T-3.2 ships the framing + parsing seam (plain `ws://`); T-3.3
//   wires the bounded-reconnect path that surfaces `SttError::ProviderUnavailable` after
//   `BackoffConfig::max_retries` consecutive transport failures.
// - `providers::elevenlabs::{ElevenLabsAdapter, ElevenLabsConfig}` — gated by feature
//   `elevenlabs` (default-on). T-3.4 ships the Scribe streaming seam (plain `ws://` with
//   `xi-api-key` header); reuses `BackoffConfig` for the bounded-reconnect path. TLS /
//   `wss://` deferred to T-3.6 (settings test-connection wires rustls for both adapters
//   in one place to avoid double-coupling the cargo features).
//
// T-3.1 relocates the previous top-level `mlx` module to `providers::mlx` and adds a
// `providers::factory()` seam used by helper-daemon (T-3.1) + settings UI (T-3.6) to swap
// providers at runtime. T-3.2 adds the Deepgram cell; T-3.4 adds ElevenLabs. The crate's
// existing public symbols (`SttProvider`, `FakeStt`, `MlxConfig`, `MlxWhisperSubprocess`,
// `DeepgramAdapter`, `BackoffConfig`) keep their crate-root re-exports so no downstream
// import path needs to change across the T-3.4 patch.
//
// Layered above `audio-capture` (`PcmChunk`); consumed by T-1.6 (Tauri event bridge),
// T-1.9 (meeting state machine), T-1.13 (E2E smoke), and Phase 3 T-3.6 (settings UI).
// See ARCHITECTURE.md §3.1/§3.2.

pub mod provider;
pub mod providers;

pub use provider::{FakeStt, SttError, SttProvider, SttSegment};
pub use providers::{factory, BackoffConfig, FactoryError, FakeConfig, ProviderConfig, ProviderKind};

#[cfg(feature = "mlx-runtime")]
pub use providers::{MlxConfig, MlxWhisperSubprocess};

#[cfg(feature = "deepgram")]
pub use providers::{DeepgramAdapter, DeepgramConfig};

#[cfg(feature = "elevenlabs")]
pub use providers::{ElevenLabsAdapter, ElevenLabsConfig};
