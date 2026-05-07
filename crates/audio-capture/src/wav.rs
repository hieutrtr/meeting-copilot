// WavFileSource — fixture-driven AudioSource implementation backed by `hound`.
// Per T-1.3 task plan §"Goal" #1 + §"TDD Plan".

use std::io::{Cursor, Read};
use std::path::Path;

use hound::{SampleFormat, WavReader};

use crate::source::{i16_to_f32, AudioError, AudioSource, PcmChunk};

/// AudioSource backed by a 16-bit PCM WAV file (mono or multi-channel; samples are
/// emitted interleaved exactly as stored in the WAV).
///
/// Read into memory eagerly (Phase 1 fixtures are short — typically < 10 s);
/// streaming-read of multi-minute files is a Phase 1.x optimization.
#[derive(Debug)]
pub struct WavFileSource {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    chunk_size: usize,
    cursor: usize,
    chunk_idx: u64,
}

impl WavFileSource {
    /// Open a WAV file from disk. Convenience wrapper around `from_reader`.
    pub fn open<P: AsRef<Path>>(path: P, chunk_size: usize) -> Result<Self, AudioError> {
        let reader = WavReader::open(path)?;
        Self::from_wav_reader(reader, chunk_size)
    }

    /// Read a WAV from any byte source. Used by tests with `Cursor<Vec<u8>>` to avoid tempfiles.
    pub fn from_reader<R: Read>(reader: R, chunk_size: usize) -> Result<Self, AudioError> {
        let r = WavReader::new(reader)?;
        Self::from_wav_reader(r, chunk_size)
    }

    fn from_wav_reader<R: Read>(
        mut reader: WavReader<R>,
        chunk_size: usize,
    ) -> Result<Self, AudioError> {
        if chunk_size == 0 {
            return Err(AudioError::UnsupportedWavFormat(
                "chunk_size must be > 0".to_string(),
            ));
        }
        let spec = reader.spec();
        if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
            return Err(AudioError::UnsupportedWavFormat(format!(
                "expected 16-bit PCM (Int), got {:?} {} bps",
                spec.sample_format, spec.bits_per_sample
            )));
        }
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|r| r.map(i16_to_f32))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            samples,
            sample_rate: spec.sample_rate,
            channels: spec.channels,
            chunk_size,
            cursor: 0,
            chunk_idx: 0,
        })
    }

    /// Total number of samples available from this source (interleaved across channels).
    pub fn total_samples(&self) -> usize {
        self.samples.len()
    }
}

impl AudioSource for WavFileSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn next_chunk(&mut self) -> Option<PcmChunk> {
        if self.cursor >= self.samples.len() {
            return None;
        }
        let end = (self.cursor + self.chunk_size).min(self.samples.len());
        let samples = self.samples[self.cursor..end].to_vec();
        // Integer math keeps timestamps deterministic without f64 rounding noise.
        let ts_ms = self.chunk_idx * (self.chunk_size as u64) * 1000 / (self.sample_rate as u64);
        self.cursor = end;
        self.chunk_idx += 1;
        Some(PcmChunk {
            samples,
            sample_rate: self.sample_rate,
            ts_ms,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_util {
    use std::io::Cursor;

    use hound::{SampleFormat, WavSpec, WavWriter};

    /// Build an in-memory 16-bit PCM WAV byte buffer from a slice of i16 samples.
    /// Tests feed the result back through `WavFileSource::from_reader(Cursor::new(bytes), ...)`.
    pub fn make_wav_bytes(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut buf = Cursor::new(Vec::<u8>::new());
        {
            let mut writer = WavWriter::new(&mut buf, spec).expect("WavWriter::new");
            for s in samples {
                writer.write_sample(*s).expect("write_sample");
            }
            writer.finalize().expect("finalize");
        }
        buf.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::make_wav_bytes;
    use super::*;

    fn ramp_samples(n: usize) -> Vec<i16> {
        // Deterministic linear ramp inside i16 range; avoids overflow at n up to ~32k.
        (0..n).map(|i| (i as i16).wrapping_mul(7)).collect()
    }

    #[test]
    fn wav_source_metadata_matches_header() {
        let bytes = make_wav_bytes(&ramp_samples(16), 16_000, 1);
        let src = WavFileSource::from_reader(Cursor::new(bytes), 8).expect("open");
        assert_eq!(src.sample_rate(), 16_000);
        assert_eq!(src.channels(), 1);
        assert_eq!(src.total_samples(), 16);
    }

    #[test]
    fn wav_source_emits_all_samples_concatenated() {
        let raw = ramp_samples(1000);
        let bytes = make_wav_bytes(&raw, 16_000, 1);
        let mut src = WavFileSource::from_reader(Cursor::new(bytes), 128).expect("open");

        let mut concat: Vec<f32> = Vec::new();
        while let Some(chunk) = src.next_chunk() {
            assert_eq!(chunk.sample_rate, 16_000);
            concat.extend_from_slice(&chunk.samples);
        }
        assert_eq!(concat.len(), 1000);
        // Spot-check the round-trip on a few indices: i16 → f32 → asserted float-equal.
        assert!((concat[0] - i16_to_f32(raw[0])).abs() < f32::EPSILON);
        assert!((concat[42] - i16_to_f32(raw[42])).abs() < f32::EPSILON);
        assert!((concat[999] - i16_to_f32(raw[999])).abs() < f32::EPSILON);
    }

    #[test]
    fn wav_source_chunks_at_configured_size() {
        let raw = ramp_samples(1000);
        let bytes = make_wav_bytes(&raw, 16_000, 1);
        let mut src = WavFileSource::from_reader(Cursor::new(bytes), 300).expect("open");

        let mut chunk_lens = Vec::new();
        while let Some(chunk) = src.next_chunk() {
            chunk_lens.push(chunk.samples.len());
        }
        assert_eq!(chunk_lens, vec![300, 300, 300, 100]);
    }

    #[test]
    fn wav_source_timestamps_monotonic() {
        let raw = ramp_samples(800);
        let bytes = make_wav_bytes(&raw, 16_000, 1);
        let mut src = WavFileSource::from_reader(Cursor::new(bytes), 200).expect("open");

        let mut timestamps = Vec::new();
        while let Some(chunk) = src.next_chunk() {
            timestamps.push(chunk.ts_ms);
        }
        // chunk_idx * 200 * 1000 / 16000 = chunk_idx * 12 (integer division: 200_000 / 16_000 = 12)
        assert_eq!(timestamps, vec![0, 12, 25, 37]);
        // Strict monotonic.
        assert!(timestamps.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn wav_source_returns_none_after_exhaustion() {
        let raw = ramp_samples(100);
        let bytes = make_wav_bytes(&raw, 16_000, 1);
        let mut src = WavFileSource::from_reader(Cursor::new(bytes), 128).expect("open");

        let first = src.next_chunk().expect("first chunk");
        assert_eq!(first.samples.len(), 100);
        assert!(src.next_chunk().is_none());
        // Idempotent: re-poll after exhaustion stays None.
        assert!(src.next_chunk().is_none());
    }

    #[test]
    fn wav_source_rejects_non_pcm_format() {
        // 32-bit IEEE float WAV — valid file, but T-1.3 only handles 16-bit PCM Int.
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut writer = hound::WavWriter::new(&mut buf, spec).unwrap();
            for i in 0..16 {
                writer.write_sample(i as f32 / 16.0).unwrap();
            }
            writer.finalize().unwrap();
        }
        let bytes = buf.into_inner();
        let err = WavFileSource::from_reader(Cursor::new(bytes), 8).expect_err("should reject");
        assert!(matches!(err, AudioError::UnsupportedWavFormat(_)));
    }

    #[test]
    fn wav_source_rejects_zero_chunk_size() {
        let bytes = make_wav_bytes(&ramp_samples(16), 16_000, 1);
        let err = WavFileSource::from_reader(Cursor::new(bytes), 0).expect_err("should reject");
        assert!(matches!(err, AudioError::UnsupportedWavFormat(_)));
    }

    #[test]
    fn audio_source_trait_is_object_safe_and_send() {
        let bytes = make_wav_bytes(&ramp_samples(16), 16_000, 1);
        let boxed: Box<dyn AudioSource + Send> =
            Box::new(WavFileSource::from_reader(Cursor::new(bytes), 8).expect("open"));
        // Spawn into a thread to verify Send at the type system level.
        let handle = std::thread::spawn(move || {
            let mut s = boxed;
            let chunk = s.next_chunk().expect("chunk");
            chunk.samples.len()
        });
        assert_eq!(handle.join().expect("join"), 8);
    }
}
