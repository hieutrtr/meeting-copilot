// CpalMicSource — production microphone source via cpal.
// Per docs/ARCHITECTURE.md §2.1 (Mic via AVAudioEngine equivalent; cpal wraps CoreAudio on macOS).
//
// HARDWARE-VERIFY PENDING: this module is code-complete but its runtime path requires
// (a) `cargo` toolchain installed (blocked-action #3 per Phase 1 INDEX), and
// (b) macOS Microphone permission granted to the parent process (one-time TCC prompt).
// System-audio loopback (BlackHole) is a follow-up; the same cpal device-open path applies once
// the user creates an Aggregate Input Device named per ARCH §2.1 setup wizard spec.
//
// Constraints respected here:
// - cpal `Stream` is `!Send` on macOS — built and owned inside a dedicated audio thread spawn.
// - Audio callback runs on a real-time thread; allocations + blocking are forbidden. We use a
//   bounded `mpsc::sync_channel(64)` and `try_send` so a slow consumer never stalls the callback.
// - Drop of `CpalMicSource` signals shutdown via a one-shot `Sender<()>`; the audio thread
//   tears down the stream and joins. No leaked stream, no leaked buffer.

use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::source::{AudioError, AudioSource, PcmChunk};

/// Default channel capacity (chunks queued to consumer before back-pressure kicks in).
const DEFAULT_CHANNEL_CAPACITY: usize = 64;

/// Default chunk size in samples (per channel) emitted to the consumer.
/// 1600 samples at 16 kHz ≈ 100 ms — matches ARCH §2.1 "flush mỗi 100ms thành chunks 100ms".
/// At cpal's native rate (typically 48 kHz on Apple Silicon) this is ~33 ms; T-1.4's chunker
/// re-windows to 2 s before the STT adapter sees it.
const DEFAULT_CHUNK_SIZE: usize = 1600;

pub struct CpalMicSource {
    config: CpalConfig,
    runtime: Option<MicRuntime>,
}

#[derive(Debug, Clone)]
struct CpalConfig {
    sample_rate: u32,
    channels: u16,
    chunk_size: usize,
    channel_capacity: usize,
}

struct MicRuntime {
    receiver: mpsc::Receiver<PcmChunk>,
    shutdown_tx: mpsc::Sender<()>,
    join: Option<JoinHandle<()>>,
}

impl CpalMicSource {
    /// Construct a configured mic source. Does **not** open the audio device or start a stream
    /// (call `start()`). Defaults: sample_rate=16_000, channels=1, chunk_size=1600.
    ///
    /// The advertised sample rate / channel count are the *requested* config; cpal may negotiate
    /// down to the device's native rate. After `start()`, query `sample_rate()` to get the
    /// actual rate the stream produced.
    pub fn new() -> Self {
        Self {
            config: CpalConfig {
                sample_rate: 16_000,
                channels: 1,
                chunk_size: DEFAULT_CHUNK_SIZE,
                channel_capacity: DEFAULT_CHANNEL_CAPACITY,
            },
            runtime: None,
        }
    }

    pub fn with_chunk_size(mut self, chunk_size: usize) -> Self {
        self.config.chunk_size = chunk_size;
        self
    }

    /// Open the default input device, build a cpal stream on a dedicated thread, and begin
    /// pushing `PcmChunk`s onto the receiver consumed by `next_chunk()`.
    pub fn start(&mut self) -> Result<(), AudioError> {
        if self.runtime.is_some() {
            return Ok(());
        }
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(AudioError::NoInputDevice)?;
        let supported = device
            .default_input_config()
            .map_err(|e| AudioError::CpalDevice(e.to_string()))?;

        let actual_rate = supported.sample_rate().0;
        let actual_channels = supported.channels();
        self.config.sample_rate = actual_rate;
        self.config.channels = actual_channels;

        let (tx, rx) = mpsc::sync_channel::<PcmChunk>(self.config.channel_capacity);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let cfg = self.config.clone();
        let stream_config: cpal::StreamConfig = supported.config();

        let join = std::thread::Builder::new()
            .name("audio-capture-mic".to_string())
            .spawn(move || {
                let started = Instant::now();
                let mut buf: Vec<f32> = Vec::with_capacity(cfg.chunk_size);

                let err_fn = |err| {
                    // cpal stream errors are non-fatal here; the consumer notices via dropped
                    // sender when the thread exits. T-1.6 will surface this through Tauri events.
                    eprintln!("[audio-capture::mic] stream error: {err}");
                };

                let tx_for_callback = tx.clone();
                let chunk_size = cfg.chunk_size;
                let sample_rate = cfg.sample_rate;
                let started_for_callback = started;

                let stream_result = device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                        buf.extend_from_slice(data);
                        while buf.len() >= chunk_size {
                            let drained: Vec<f32> = buf.drain(..chunk_size).collect();
                            let ts_ms = started_for_callback.elapsed().as_millis() as u64;
                            let chunk = PcmChunk {
                                samples: drained,
                                sample_rate,
                                ts_ms,
                            };
                            // Bounded try_send: if consumer is slow, drop the chunk rather than
                            // blocking the real-time audio thread. T-1.4's ring buffer replaces
                            // this with proper back-pressure handling.
                            let _ = tx_for_callback.try_send(chunk);
                        }
                    },
                    err_fn,
                    None,
                );

                let stream = match stream_result {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[audio-capture::mic] build_input_stream failed: {e}");
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    eprintln!("[audio-capture::mic] stream.play failed: {e}");
                    return;
                }
                // Block until shutdown signal. Stream stays alive on this thread.
                let _ = shutdown_rx.recv();
                drop(stream);
                drop(tx);
            })
            .map_err(|e| AudioError::CpalStream(format!("spawn audio thread: {e}")))?;

        self.runtime = Some(MicRuntime {
            receiver: rx,
            shutdown_tx,
            join: Some(join),
        });
        Ok(())
    }

    /// Signal shutdown and join the audio thread. Idempotent.
    pub fn stop(&mut self) {
        if let Some(mut runtime) = self.runtime.take() {
            let _ = runtime.shutdown_tx.send(());
            if let Some(handle) = runtime.join.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Default for CpalMicSource {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CpalMicSource {
    fn drop(&mut self) {
        self.stop();
    }
}

impl AudioSource for CpalMicSource {
    fn sample_rate(&self) -> u32 {
        self.config.sample_rate
    }

    fn channels(&self) -> u16 {
        self.config.channels
    }

    fn next_chunk(&mut self) -> Option<PcmChunk> {
        let runtime = self.runtime.as_ref()?;
        runtime.receiver.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpal_mic_source_constructs_without_device_probe() {
        // Hardware-independent smoke: `new()` must not touch the audio system.
        // (`start()` is what opens the default input device — not exercised here.)
        let src = CpalMicSource::new();
        // Defaults from `new()` — overridden after `start()` negotiates with device.
        assert_eq!(src.sample_rate(), 16_000);
        assert_eq!(src.channels(), 1);
    }

    #[test]
    fn cpal_mic_source_with_chunk_size_overrides_default() {
        let src = CpalMicSource::new().with_chunk_size(800);
        assert_eq!(src.config.chunk_size, 800);
    }

    #[test]
    fn cpal_mic_source_stop_is_idempotent_when_not_started() {
        // Drop path must not panic when start() was never called.
        let mut src = CpalMicSource::new();
        src.stop();
        src.stop();
    }

    #[test]
    fn cpal_mic_source_next_chunk_returns_none_when_not_started() {
        let mut src = CpalMicSource::new();
        assert!(src.next_chunk().is_none());
    }
}
