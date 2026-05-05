// AudioSource trait + PcmChunk + AudioError.
// Per docs/ARCHITECTURE.md §3.1 (PCMChunk shape) and INDEX T-1.3 (pluggable source).

use std::io;

/// One window of PCM audio samples emitted by an `AudioSource`.
///
/// Samples are normalized to `[-1.0, 1.0]` (i16 inputs scaled by `i16::MAX = 32767.0` and
/// clamped — see `WavFileSource` for details). `sample_rate` reports the source's native rate;
/// resampling to the canonical 16 kHz is the chunker's job (T-1.4).
#[derive(Debug, Clone, PartialEq)]
pub struct PcmChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub ts_ms: u64,
}

/// Object-safe trait for any source of PCM frames (WAV file, cpal mic, future Aggregate Device).
///
/// Consumers iterate via `next_chunk()` until it returns `None`. For finite sources (WAV) `None`
/// signals exhaustion; for infinite sources (live mic) `None` signals shutdown (sender dropped).
pub trait AudioSource: Send {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> u16;
    fn next_chunk(&mut self) -> Option<PcmChunk>;
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),

    #[error("hound wav error: {0}")]
    Wav(#[from] hound::Error),

    #[error("unsupported wav format: {0}")]
    UnsupportedWavFormat(String),

    #[error("no default input device available")]
    NoInputDevice,

    #[error("cpal device error: {0}")]
    CpalDevice(String),

    #[error("cpal stream error: {0}")]
    CpalStream(String),

    #[error("source not started")]
    NotStarted,
}

/// i16 → f32 normalization. Returns a value in `[-1.0, 1.0]`; `i16::MIN` clamps to `-1.0`.
#[inline]
pub(crate) fn i16_to_f32(s: i16) -> f32 {
    let scaled = s as f32 / i16::MAX as f32;
    scaled.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i16_to_f32_zero_maps_to_zero() {
        assert_eq!(i16_to_f32(0), 0.0);
    }

    #[test]
    fn i16_to_f32_max_maps_to_one() {
        assert_eq!(i16_to_f32(i16::MAX), 1.0);
    }

    #[test]
    fn i16_to_f32_min_clamps_to_negative_one() {
        // i16::MIN / i16::MAX = -1.000_030_5...; the clamp pins it at -1.0 exactly.
        assert_eq!(i16_to_f32(i16::MIN), -1.0);
    }
}
