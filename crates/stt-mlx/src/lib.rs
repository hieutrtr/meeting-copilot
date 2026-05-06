// stt-mlx — Phase 1 T-1.5 (initial trait + MLX impl) + Phase 3 T-3.1 (pluggable provider
// factory) + Phase 3 T-3.2 (Deepgram WebSocket adapter).
//
// Public surface (stable across the T-3.1 refactor — helper-daemon imports these by name):
// - `provider::{SttProvider, SttSegment, SttError, FakeStt}` — always available.
// - `providers::{ProviderKind, ProviderConfig, FakeConfig, FactoryError, factory}` — Phase 3 seam.
// - `providers::mlx::{MlxConfig, MlxWhisperSubprocess}` — gated by feature `mlx-runtime`
//   (default-on). Disabled for headless CI / helper-daemon (`default-features = false`) where
//   Python is not installed; the trait + FakeStt + factory(Fake, …) remain.
// - `providers::deepgram::{DeepgramAdapter, DeepgramConfig}` — gated by feature `deepgram`
//   (default-on). Plain `ws://` only in T-3.2; TLS lands in T-3.3 alongside reconnect/chaos.
//
// T-3.1 relocates the previous top-level `mlx` module to `providers::mlx` and adds a
// `providers::factory()` seam used by helper-daemon (T-3.1) + settings UI (T-3.6) to swap
// providers at runtime. T-3.2 adds the Deepgram cell behind the same factory. The crate's
// existing public symbols (`SttProvider`, `FakeStt`, `MlxConfig`, `MlxWhisperSubprocess`)
// keep their crate-root re-exports so no downstream import path needs to change.
//
// Layered above `audio-capture` (`PcmChunk`); consumed by T-1.6 (Tauri event bridge),
// T-1.9 (meeting state machine), T-1.13 (E2E smoke), and Phase 3 T-3.6 (settings UI).
// See ARCHITECTURE.md §3.1/§3.2.

pub mod provider;
pub mod providers;

pub use provider::{FakeStt, SttError, SttProvider, SttSegment};
pub use providers::{factory, FactoryError, FakeConfig, ProviderConfig, ProviderKind};

#[cfg(feature = "mlx-runtime")]
pub use providers::{MlxConfig, MlxWhisperSubprocess};

#[cfg(feature = "deepgram")]
pub use providers::{DeepgramAdapter, DeepgramConfig};
