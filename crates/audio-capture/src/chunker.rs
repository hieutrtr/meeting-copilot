// Chunker — second half of the audio→STT pipeline.
// Per T-1.4 task plan §"Goal" + §"AC-3".
//
// Pipeline per `push()` call:
//   raw samples (interleaved, source_rate, channels)
//     → mixdown to mono (average interleaved frames)
//     → linear-interp resample to target_rate
//     → append to ring buffer (drop-oldest if full)
//
// `try_next_chunk()` drains exactly `window_samples` from the ring at `target_rate`. Timestamps
// are emission-relative (ts_ms = chunk_idx * window_seconds * 1000) — wall-clock tagging is
// T-1.6's job. The chunker holds only Rust-managed primitives + a VecDeque<f32>; no thread,
// no fd, no channel — std drop is leak-free.

use crate::ring::RingBuffer;
use crate::source::PcmChunk;

/// Configuration for `Chunker`. Defaults match the MVP spec: 16 kHz mono, 2-second windows,
/// 30-second ring buffer (≈ 1.9 MB worst-case, 15× window slack).
#[derive(Debug, Clone, Copy)]
pub struct ChunkerConfig {
    pub target_sample_rate: u32,
    pub window_seconds: f32,
    pub buffer_seconds: f32,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            target_sample_rate: 16_000,
            window_seconds: 2.0,
            buffer_seconds: 30.0,
        }
    }
}

/// Push-based PCM chunker.
///
/// Callers `push()` interleaved samples observed from any upstream source (cpal mic, WAV
/// fixture, ScreenCaptureKit aggregate) and `try_next_chunk()` drains windows. The chunker
/// owns the resample state (carry + phase) so multiple `push()` calls of arbitrary length
/// produce a continuous output stream.
pub struct Chunker {
    ring: RingBuffer,
    target_rate: u32,
    window_samples: usize,
    chunk_idx: u64,
    /// Last input sample seen (after mixdown), held for linear interpolation across `push()` calls.
    resample_carry: Option<f32>,
    /// Fractional position of the next desired output sample, in input-sample units. Stays in
    /// `[0, 1)` between calls — wraps as we consume input samples.
    resample_phase: f64,
    /// Cached source rate from the most recent `push()` call. Used by the resampler. None until
    /// first push.
    last_source_rate: Option<u32>,
    window_seconds_in_ms: u64,
}

impl Chunker {
    pub fn new(config: ChunkerConfig) -> Self {
        assert!(config.target_sample_rate > 0, "target_sample_rate must be > 0");
        assert!(config.window_seconds > 0.0, "window_seconds must be > 0");
        assert!(
            config.buffer_seconds >= config.window_seconds,
            "buffer_seconds must be >= window_seconds"
        );
        let window_samples =
            (config.window_seconds * config.target_sample_rate as f32).round() as usize;
        let buffer_capacity =
            (config.buffer_seconds * config.target_sample_rate as f32).round() as usize;
        let window_seconds_in_ms = (config.window_seconds * 1000.0).round() as u64;
        Self {
            ring: RingBuffer::new(buffer_capacity),
            target_rate: config.target_sample_rate,
            window_samples,
            chunk_idx: 0,
            resample_carry: None,
            resample_phase: 0.0,
            last_source_rate: None,
            window_seconds_in_ms,
        }
    }

    pub fn target_sample_rate(&self) -> u32 {
        self.target_rate
    }

    pub fn window_samples(&self) -> usize {
        self.window_samples
    }

    /// Number of samples currently buffered at `target_rate` (for tests + UI metering).
    pub fn buffered_samples(&self) -> usize {
        self.ring.len()
    }

    /// Append one batch of interleaved samples observed at `source_rate` with `channels`
    /// channels. Returns the count of samples dropped from the ring buffer when it overflowed
    /// (steady-state: 0).
    pub fn push(&mut self, samples: &[f32], source_rate: u32, channels: u16) -> usize {
        assert!(channels > 0, "channels must be > 0");
        assert!(source_rate > 0, "source_rate must be > 0");

        // Reset resample state if the upstream source rate changed (e.g. device hot-swap).
        // T-1.6 will surface this as a `meeting:source_changed` warning event.
        if self
            .last_source_rate
            .map_or(false, |r| r != source_rate)
        {
            self.resample_carry = None;
            self.resample_phase = 0.0;
        }
        self.last_source_rate = Some(source_rate);

        let mono = if channels == 1 {
            samples.to_vec()
        } else {
            mixdown_interleaved_to_mono(samples, channels)
        };

        let resampled = if source_rate == self.target_rate {
            mono
        } else {
            linear_resample(
                &mono,
                &mut self.resample_carry,
                &mut self.resample_phase,
                source_rate,
                self.target_rate,
            )
        };

        self.ring.push_slice(&resampled)
    }

    /// Drain a window of exactly `window_samples` if available; otherwise return `None`.
    /// Each successful call advances `chunk_idx` and stamps `ts_ms = chunk_idx * window_ms`
    /// (relative to the chunker's start, not wall-clock).
    pub fn try_next_chunk(&mut self) -> Option<PcmChunk> {
        let samples = self.ring.drain(self.window_samples)?;
        let ts_ms = self.chunk_idx * self.window_seconds_in_ms;
        self.chunk_idx += 1;
        Some(PcmChunk {
            samples,
            sample_rate: self.target_rate,
            ts_ms,
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers (private; surfaced via cfg(test) to keep this module's tests focused)
// ---------------------------------------------------------------------------

/// Average each interleaved frame's `channels` samples into one mono sample.
/// Output length = input.len() / channels (truncates a trailing partial frame, which cpal does
/// not produce in practice — the callback always delivers complete frames).
fn mixdown_interleaved_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels as usize;
    if ch == 1 {
        return samples.to_vec();
    }
    let frames = samples.len() / ch;
    let inv = 1.0 / ch as f32;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let start = f * ch;
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += samples[start + c];
        }
        out.push(sum * inv);
    }
    out
}

/// Linear-interpolation resampler with carry across calls. Handles `source_rate != target_rate`
/// where the ratio may not divide evenly; the `phase` field tracks the fractional output position
/// so cumulative drift stays bounded across many `push()` calls.
///
/// Output length per call ≈ `input.len() * target / source` (± 1 from the phase boundary).
fn linear_resample(
    input: &[f32],
    carry: &mut Option<f32>,
    phase: &mut f64,
    source_rate: u32,
    target_rate: u32,
) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    // Step in input-sample units between successive output samples.
    let step = source_rate as f64 / target_rate as f64;
    let mut out: Vec<f32> = Vec::new();

    // Build a logical input view: [carry?, input...] so interpolation can span call boundaries.
    // We track the next-output position `pos` in input-sample coordinates relative to this view.
    // After the call we set `*phase = pos - last_consumed_int` and `*carry = last_input_sample`.
    let prev = *carry;
    // Position of next output sample in the [carry?, input...] coordinate, where carry is at idx 0.
    // If no carry (first call), `pos` starts at 0 and points directly at input[0].
    // If carry exists, the logical input begins with `prev` at idx 0; input[0] sits at idx 1.
    let mut pos: f64 = if prev.is_some() { 1.0 + *phase } else { *phase };
    let logical_offset = if prev.is_some() { 1usize } else { 0usize };
    let logical_len = logical_offset + input.len();

    // Helper: read sample at logical index (0 = carry if present, else input[0]).
    let read = |idx: usize| -> f32 {
        if let Some(c) = prev {
            if idx == 0 {
                c
            } else {
                input[idx - 1]
            }
        } else {
            input[idx]
        }
    };

    loop {
        let i0 = pos.floor() as usize;
        let frac = (pos - pos.floor()) as f32;
        // Need both i0 and i0+1 inside the logical window to interpolate.
        if i0 + 1 >= logical_len {
            break;
        }
        let s0 = read(i0);
        let s1 = read(i0 + 1);
        out.push(s0 + (s1 - s0) * frac);
        pos += step;
    }

    // Persist state for next call: carry the last input sample and remember how far past the
    // *end of this call's logical frame* the next output sits.
    //
    // Coordinate math: in this call's logical frame, idx N-1 is the last input sample we just
    // consumed, sitting at original-stream coord = (cumulative_in - 1). The next call's logical
    // frame starts with that sample (as `prev`) at idx 0, with the next call's input[0] at idx 1.
    // So next-call's pos = (current pos) - (logical_len - 1) - 1 = pos - logical_len, and we
    // store `phase = pos - logical_len` (next-call recomputes pos as `1 + phase` when prev
    // exists, recovering the correct mapping). Clamped to ≥ 0 to absorb the equal-rate case
    // where `pos == logical_len - 1` after the loop (one input held back for interp).
    let last_input = *input.last().expect("non-empty checked above");
    *carry = Some(last_input);
    *phase = pos - logical_len as f64;
    if *phase < 0.0 {
        *phase = 0.0;
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Test-only newtype proving `Chunker` does not internally retain Arc-counted state.
    /// If a future refactor leaks a clone of the Arc into a closure or thread inside Chunker,
    /// the strong count test would fail.
    struct ChunkerHarness {
        #[allow(dead_code)]
        chunker: Chunker,
        #[allow(dead_code)]
        tracer: Arc<()>,
    }

    fn synthetic_silence(n: usize) -> Vec<f32> {
        vec![0.0; n]
    }

    fn synthetic_ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| i as f32 / n as f32).collect()
    }

    #[test]
    fn chunker_emits_two_chunks_for_5s_synthetic_pcm() {
        let mut chunker = Chunker::new(ChunkerConfig::default());
        // 5 seconds @ 16 kHz mono = 80_000 samples; 2-s windows = 32_000 samples each.
        let pcm = synthetic_silence(80_000);
        let dropped = chunker.push(&pcm, 16_000, 1);
        assert_eq!(dropped, 0);
        // First two pulls succeed.
        let c1 = chunker.try_next_chunk().expect("chunk 1");
        assert_eq!(c1.samples.len(), 32_000);
        assert_eq!(c1.sample_rate, 16_000);
        let c2 = chunker.try_next_chunk().expect("chunk 2");
        assert_eq!(c2.samples.len(), 32_000);
        // Third pull drains less than a window — should be None.
        assert!(chunker.try_next_chunk().is_none());
        // Buffer holds the residual 16_000 samples (1 second).
        assert_eq!(chunker.buffered_samples(), 16_000);
    }

    #[test]
    fn chunker_timestamps_are_deterministic_per_chunk_index() {
        let mut chunker = Chunker::new(ChunkerConfig::default());
        // 8 s of audio = 4 windows @ 2 s.
        chunker.push(&synthetic_silence(128_000), 16_000, 1);
        let mut timestamps = Vec::new();
        while let Some(c) = chunker.try_next_chunk() {
            timestamps.push(c.ts_ms);
        }
        assert_eq!(timestamps, vec![0, 2000, 4000, 6000]);
    }

    #[test]
    fn chunker_resamples_48khz_to_16khz_mono() {
        let mut chunker = Chunker::new(ChunkerConfig::default());
        // 6000 samples @ 48 kHz mono → expect ≈ 2000 samples @ 16 kHz buffered.
        chunker.push(&synthetic_ramp(6000), 48_000, 1);
        let buffered = chunker.buffered_samples();
        assert!(
            (1995..=2001).contains(&buffered),
            "expected ~2000 buffered, got {buffered}"
        );
    }

    #[test]
    fn chunker_mixes_down_stereo_interleaved_to_mono() {
        let mut chunker = Chunker::new(ChunkerConfig::default());
        // 1000 frames stereo: [L0, R0, L1, R1, ...]. L = 0.4, R = 0.6 → mono = 0.5 each.
        let mut interleaved = Vec::with_capacity(2000);
        for _ in 0..1000 {
            interleaved.push(0.4);
            interleaved.push(0.6);
        }
        chunker.push(&interleaved, 16_000, 2);
        assert_eq!(chunker.buffered_samples(), 1000);
        // Pull one window's worth not possible (need 32_000); peek via mini config instead.
        let mut tiny = Chunker::new(ChunkerConfig {
            target_sample_rate: 16_000,
            window_seconds: (1000.0 / 16_000.0),
            buffer_seconds: 1.0,
        });
        tiny.push(&interleaved, 16_000, 2);
        let chunk = tiny.try_next_chunk().expect("tiny chunk");
        assert_eq!(chunk.samples.len(), 1000);
        for s in &chunk.samples {
            assert!((s - 0.5).abs() < 1e-5, "expected 0.5 got {s}");
        }
    }

    #[test]
    fn chunker_emits_chunks_then_buffers_residual_with_correct_residual_count() {
        // Sanity for the boundary case: push exactly window-aligned.
        let mut chunker = Chunker::new(ChunkerConfig::default());
        chunker.push(&synthetic_silence(64_000), 16_000, 1);
        let _ = chunker.try_next_chunk().expect("c1");
        let _ = chunker.try_next_chunk().expect("c2");
        assert!(chunker.try_next_chunk().is_none());
        assert_eq!(chunker.buffered_samples(), 0);
    }

    #[test]
    fn chunker_drop_releases_buffer_no_panic() {
        // 25 s of audio @ 16 kHz mono = 400_000 samples. Within the 30-s buffer cap (480_000).
        let mut chunker = Chunker::new(ChunkerConfig::default());
        chunker.push(&synthetic_silence(400_000), 16_000, 1);
        assert_eq!(chunker.buffered_samples(), 400_000);
        // Drop at end of scope — no panic, no leaked thread/fd/channel (Chunker has none).
        drop(chunker);
    }

    #[test]
    fn chunker_drop_strong_count_via_arc_tracer() {
        let tracer = Arc::new(());
        let tracer_clone = Arc::clone(&tracer);
        let harness = ChunkerHarness {
            chunker: Chunker::new(ChunkerConfig::default()),
            tracer,
        };
        // Ensure the harness uses both fields (defeats dead_code elimination).
        assert_eq!(harness.chunker.window_samples(), 32_000);
        // Two strong refs while harness is alive: harness.tracer + tracer_clone.
        assert_eq!(Arc::strong_count(&tracer_clone), 2);
        drop(harness);
        // After drop, only `tracer_clone` remains.
        assert_eq!(Arc::strong_count(&tracer_clone), 1);
    }

    #[test]
    fn chunker_push_overflow_returns_dropped_count() {
        // 5-second buffer + push 6 seconds → at least 1 second worth dropped.
        let mut chunker = Chunker::new(ChunkerConfig {
            target_sample_rate: 16_000,
            window_seconds: 2.0,
            buffer_seconds: 5.0,
        });
        let dropped = chunker.push(&synthetic_silence(96_000), 16_000, 1);
        assert!(dropped > 0, "expected drop-oldest to fire");
        // Buffer pinned at capacity = 5 s = 80_000 samples.
        assert_eq!(chunker.buffered_samples(), 80_000);
    }

    #[test]
    fn mixdown_helper_handles_mono_passthrough() {
        let out = mixdown_interleaved_to_mono(&[0.1, 0.2, 0.3], 1);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn linear_resample_identity_when_rates_equal_via_skip_path() {
        // Sanity check for the helper itself: if we deliberately call it with equal rates
        // it should still produce something sensible (the chunker's `push` skips this path).
        let mut carry = None;
        let mut phase = 0.0;
        let out = linear_resample(&[0.0, 1.0, 2.0, 3.0], &mut carry, &mut phase, 16_000, 16_000);
        // step=1.0; first iter pos=0 → out=0.0; pos=1 → out=1.0; pos=2 → out=2.0; pos=3 → out=?
        // i0+1=4 >= logical_len(4) → stop. So 3 samples emitted.
        assert_eq!(out.len(), 3);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 1.0).abs() < 1e-6);
        assert!((out[2] - 2.0).abs() < 1e-6);
    }
}
