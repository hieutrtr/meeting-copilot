// audio-capture — Phase 1 T-1.3 + T-1.4 (Meeting Copilot).
// T-1.3: pluggable AudioSource trait + WAV-fixture impl + cpal mic impl.
// T-1.4: PCM ring buffer + sliding-window chunker (resample + mono mixdown to 16 kHz / 2-s windows).
//
// Public surface re-exports below; module docs live in the per-file rustdoc.

pub mod chunker;
pub mod mic;
pub mod ring;
pub mod source;
pub mod wav;

pub use chunker::{Chunker, ChunkerConfig};
pub use mic::CpalMicSource;
pub use ring::RingBuffer;
pub use source::{AudioError, AudioSource, PcmChunk};
pub use wav::WavFileSource;
