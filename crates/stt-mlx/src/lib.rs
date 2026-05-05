// stt-mlx — Phase 1 T-1.5 (Meeting Copilot).
//
// Public surface:
// - `provider::{SttProvider, SttSegment, SttError, FakeStt}` — always available.
// - `mlx::{MlxConfig, MlxWhisperSubprocess}` — gated by feature `mlx-runtime` (default-on).
//   Disabled for headless CI where Python is not installed; the trait + FakeStt remain.
//
// Layered above `audio-capture` (`PcmChunk`); consumed by T-1.6 (Tauri event bridge),
// T-1.9 (meeting state machine), T-1.13 (E2E smoke). See ARCHITECTURE.md §3.1/§3.2.

pub mod provider;

#[cfg(feature = "mlx-runtime")]
pub mod mlx;

pub use provider::{FakeStt, SttError, SttProvider, SttSegment};

#[cfg(feature = "mlx-runtime")]
pub use mlx::{MlxConfig, MlxWhisperSubprocess};
