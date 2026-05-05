// audio-capture — Phase 1 T-1.3 (Meeting Copilot).
// Pluggable AudioSource trait + WAV-fixture impl + cpal mic impl.
//
// Public surface re-exports below; module docs live in the per-file rustdoc.

pub mod mic;
pub mod source;
pub mod wav;

pub use mic::CpalMicSource;
pub use source::{AudioError, AudioSource, PcmChunk};
pub use wav::WavFileSource;
