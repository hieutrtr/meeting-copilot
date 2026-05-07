// T-W.5 — BlackHole capture smoke-test ("Verify" wizard step). Phase-W BlackHole Setup Wizard.
//
// Locks down `docs/blackhole-wizard-design.md` §4 "Verify capture" — the final wizard
// gate before flipping `BlackHoleStatus::Configured` → `BlackHoleStatus::Verified`.
// The job: open a `cpal` input stream from the BlackHole 2ch device, watch for ≥ 5 s,
// classify the result via three signal-shape buckets (mirrors the Swift spike's exit
// codes verbatim — `experiments/T-0.2/blackhole_capture.swift:293-377`):
//
//   peak > 0.001  AND  callback_count > 0   →  Ok(VerifyReport { peak, callbacks, … })
//   peak ≤ 0.001  AND  callback_count > 0   →  Err(BlackHolePresentButSilent)   (Swift exit 8)
//   callback_count == 0                     →  Err(TimedOutNoCallbacks)         (Swift exit 6)
//   build_input_stream returned an error    →  Err(BuildInputStreamFailed(...))
//   no input device matched the UID hint    →  Err(DeviceNotFound { hint })
//
// Test seam — `AudioInputProbe` trait. Production `RealAudioInputProbe` opens a real
// cpal stream against the host's BlackHole device; tests use `MockAudioInputProbe`
// which returns a hand-crafted `CaptureWindow` and never touches the audio system.
// This is the same pattern as T-W.2 `CoreAudioProbe` and T-W.4 `AggregateDeviceCreator`
// — production impl behind a trait, all test paths flow through a mock.
//
// Permission UX caveat: on the host re-run, `cpal::build_input_stream` fires the
// macOS Microphone TCC prompt the *first* time the helper-daemon process touches an
// input device. The wizard's Verify-card pre-prompt blurb (`docs/SETUP.md` §5,
// `T-W.6` SetupWizard.tsx) sets the user's expectation. If the user picks
// "Don't Allow", cpal still builds the stream but no callbacks fire — that's the
// `TimedOutNoCallbacks` lane. The 5-second window is generous enough to absorb the
// modal-up-to-callback-fire latency on cold launch.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use thiserror::Error;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::blackhole::{BLACKHOLE_NAME_HINT_LOWER, BLACKHOLE_UID_HINT};

/// Verify threshold. Anything `> 0.001` (strict) classifies as Verified. The Swift
/// spike used `1e-4` for the "silent" floor; we pick `1e-3` for the wizard so a
/// stray 60 dB SPL room-tone bleed via mic crosstalk does NOT promote a misconfigured
/// loopback to "Verified". Pinned by `peak_threshold_is_0_001_per_design`.
pub const VERIFY_PEAK_THRESHOLD: f32 = 0.001;

/// Default capture-window length used by the wizard's Verify step. Mirrors the Swift
/// spike's 5 s window (`experiments/T-0.2/blackhole_capture.swift:18` `duration` arg
/// default in the `verify` sub-mode).
pub const DEFAULT_VERIFY_DURATION_MS: u64 = 5_000;

/// Closed `VerifyError` set, frozen at v1.0.1 (`PHASE-COMPLETE.md` line 66).
///
/// Wire format: variants are returned by `verify_capture` and surfaced through the
/// Tauri command `setup_verify_capture` (lands in R-W.6) as a `serde_json` tagged
/// enum. The wizard's `useSetupWizard` reducer matches on the variant tag.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum VerifyError {
    /// Stream fired callbacks (BlackHole device is open + producing frames) but the
    /// peak amplitude over the capture window stayed at-or-below the verify
    /// threshold. The user has built the Multi-Output Device but is NOT routing
    /// system audio through it (System Settings → Sound → Output not set, or the
    /// meeting app is bound to a specific device that bypasses the Multi-Output).
    /// Wizard surfaces this as a typed retry hint pointing at `docs/SETUP.md` §5.
    #[error("BlackHole present but silent — peak {peak_amplitude:e} ≤ threshold {threshold:e} ({sample_count} samples / {callback_count} callbacks in {duration_ms}ms)")]
    BlackHolePresentButSilent {
        peak_amplitude: f32,
        threshold: f32,
        sample_count: usize,
        callback_count: u32,
        duration_ms: u64,
    },

    /// Zero audio callbacks fired in the entire capture window. Either the input
    /// stream never started (cpal returned a stream but the OS never woke the audio
    /// thread — most commonly because TCC microphone permission was DENIED) or the
    /// device disappeared mid-capture. Mirrors Swift exit code 6 (`.notDetermined`).
    #[error("timed out — zero audio callbacks fired in {duration_ms}ms (TCC microphone permission denied?)")]
    TimedOutNoCallbacks { duration_ms: u64 },

    /// `cpal::Device::build_input_stream` returned an error. Wrapped as `String` to
    /// keep the variant `Clone + PartialEq` (cpal's `BuildStreamError` is neither);
    /// the wizard surfaces the message verbatim in the troubleshooting card.
    #[error("build_input_stream failed: {0}")]
    BuildInputStreamFailed(String),

    /// No input device on the host matched the UID-or-name hint. Either BlackHole
    /// is genuinely uninstalled (caller should have caught it earlier in the
    /// `BlackHoleStatus::NotInstalled` branch) or the device list hasn't refreshed
    /// since install. Wizard prompts the user to "Detect again".
    #[error("input device matching hint '{hint}' not found among {available_count} input devices")]
    DeviceNotFound { hint: String, available_count: usize },
}

/// Outcome of a successful verify run. Carried into `BlackHoleStatus::Verified`
/// by the helper-daemon caller. Telemetry — `callback_count` + `sample_count` —
/// helps a remote operator distinguish a thin stream (drop-outs from a busy CPU)
/// from a thick one (steady throughput).
#[derive(Debug, Clone, PartialEq)]
pub struct VerifyReport {
    pub peak_amplitude: f32,
    pub callback_count: u32,
    pub sample_count: usize,
    pub duration_ms: u64,
}

/// Snapshot returned by an `AudioInputProbe` — the raw capture-window the verify
/// classifier consumes. Production `RealAudioInputProbe` builds this from a live
/// cpal stream; mock probes hand back a synthesized buffer + callback count.
#[derive(Debug, Clone)]
pub struct CaptureWindow {
    pub samples: Vec<f32>,
    pub callback_count: u32,
}

/// Test seam. The single entry-point to the audio system; the only thing that
/// changes between production and mock is who supplies the `CaptureWindow`.
pub trait AudioInputProbe {
    /// Open the input device matching `device_hint` (case-insensitive substring on
    /// `Device::name()`; production also matches `BlackHole2ch_UID` in the same
    /// pattern as `find_blackhole`), build a 32-bit-float input stream, accumulate
    /// `duration_ms` worth of frames, return the buffer + callback-fire count.
    ///
    /// Empty `device_hint` ⇒ default-search for "blackhole 2ch".
    fn capture_window(
        &self,
        device_hint: &str,
        duration_ms: u64,
    ) -> Result<CaptureWindow, VerifyError>;
}

/// Verify a capture window classifies into the right `VerifyReport` / `VerifyError`
/// bucket. Pure function modulo `probe.capture_window(...)`; all branches are unit-
/// tested below.
pub fn verify_capture<P: AudioInputProbe>(
    probe: &P,
    device_hint: &str,
    duration_ms: u64,
) -> Result<VerifyReport, VerifyError> {
    let window = probe.capture_window(device_hint, duration_ms)?;
    if window.callback_count == 0 {
        return Err(VerifyError::TimedOutNoCallbacks { duration_ms });
    }
    let peak_amplitude = window
        .samples
        .iter()
        .copied()
        .fold(0.0_f32, |acc, s| acc.max(s.abs()));
    if peak_amplitude <= VERIFY_PEAK_THRESHOLD {
        return Err(VerifyError::BlackHolePresentButSilent {
            peak_amplitude,
            threshold: VERIFY_PEAK_THRESHOLD,
            sample_count: window.samples.len(),
            callback_count: window.callback_count,
            duration_ms,
        });
    }
    Ok(VerifyReport {
        peak_amplitude,
        callback_count: window.callback_count,
        sample_count: window.samples.len(),
        duration_ms,
    })
}

/// Production probe. Wraps a real `cpal::Stream` against the host's BlackHole
/// device. Cross-platform compile (`cpal` is portable) — the device-name match
/// happens to find BlackHole only on macOS, but a Linux / Windows host that
/// re-uses the trait for a different loopback device works without changes.
///
/// Run path:
///   1. `cpal::default_host().input_devices()` → enumerate all input-capable devices
///   2. `find` the first device whose `name()` matches the hint (case-insensitive
///      substring) OR contains the canonical BlackHole UID stamp
///   3. `default_input_config()` → device's native f32 stream config
///   4. `build_input_stream::<f32>` with a callback that:
///      - bumps an `AtomicU32` counter (RT-safe, no allocation, no syscalls)
///      - `try_send`s the frame buffer onto a `sync_channel(1024)` (non-blocking;
///        if the consumer can't keep up, drop the frame rather than block the
///        real-time audio thread — same back-pressure pattern as `mic.rs:134`)
///   5. Caller-thread `recv_timeout(100ms)` loop accumulates samples until the
///      `duration_ms` window elapses, then drops the stream. The dropped stream
///      tears down the cpal callback registration cleanly.
#[derive(Debug, Default)]
pub struct RealAudioInputProbe;

impl AudioInputProbe for RealAudioInputProbe {
    fn capture_window(
        &self,
        device_hint: &str,
        duration_ms: u64,
    ) -> Result<CaptureWindow, VerifyError> {
        let host = cpal::default_host();
        let devices_iter = host
            .input_devices()
            .map_err(|e| VerifyError::BuildInputStreamFailed(format!("input_devices: {e}")))?;
        // Materialize so we can both pick a match AND report `available_count` on
        // not-found. Input-device lists on a typical Mac are < 20 entries.
        let devices: Vec<cpal::Device> = devices_iter.collect();

        let hint_lower = device_hint.to_lowercase();
        let device = devices
            .iter()
            .find(|d| match_input_device(d, &hint_lower))
            .ok_or_else(|| VerifyError::DeviceNotFound {
                hint: device_hint.to_string(),
                available_count: devices.len(),
            })?
            .clone();

        let supported = device.default_input_config().map_err(|e| {
            VerifyError::BuildInputStreamFailed(format!("default_input_config: {e}"))
        })?;
        let stream_config: cpal::StreamConfig = supported.config();

        // 1024-deep frame queue: cpal Mac default callback ≈ 256 frames @ 48 kHz =
        // ~5 ms per fire; 1024 fires ≈ 5 s of head-room — plenty for a non-realtime
        // consumer thread that polls every 100 ms.
        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(1024);
        let counter = Arc::new(AtomicU32::new(0));
        let counter_cb = Arc::clone(&counter);

        let err_fn = |err| {
            // Stream errors are surfaced via dropped sender; we only log here so
            // the `cpal` callback never panics across an FFI boundary.
            eprintln!("[audio-capture::verify] stream error: {err}");
        };

        let stream = device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                    counter_cb.fetch_add(1, Ordering::Relaxed);
                    let _ = tx.try_send(data.to_vec());
                },
                err_fn,
                None,
            )
            .map_err(|e| VerifyError::BuildInputStreamFailed(e.to_string()))?;
        stream
            .play()
            .map_err(|e| VerifyError::BuildInputStreamFailed(e.to_string()))?;

        let started = Instant::now();
        let window = Duration::from_millis(duration_ms);
        let mut samples: Vec<f32> = Vec::new();
        while started.elapsed() < window {
            let remaining = window.saturating_sub(started.elapsed());
            let poll = remaining.min(Duration::from_millis(100));
            match rx.recv_timeout(poll) {
                Ok(chunk) => samples.extend_from_slice(&chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        // Stream lives until the end of this fn; explicit drop here documents that
        // we tear down BEFORE returning so the AtomicU32 read is final.
        drop(stream);

        Ok(CaptureWindow {
            samples,
            callback_count: counter.load(Ordering::Relaxed),
        })
    }
}

/// Device-name matcher used by `RealAudioInputProbe::capture_window`. Empty hint
/// ⇒ default to BlackHole. Non-empty ⇒ accept either the user's hint OR the
/// canonical BlackHole stamps (lets the caller pass a UID and still match a
/// renamed device).
fn match_input_device(device: &cpal::Device, hint_lower: &str) -> bool {
    let name_lower = device
        .name()
        .map(|n| n.to_lowercase())
        .unwrap_or_default();
    if hint_lower.is_empty() {
        name_lower.contains(BLACKHOLE_NAME_HINT_LOWER) || name_lower.contains("blackhole2ch")
    } else {
        name_lower.contains(hint_lower)
            || name_lower.contains(BLACKHOLE_NAME_HINT_LOWER)
            || name_lower.contains(&BLACKHOLE_UID_HINT.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory `AudioInputProbe` mock. Constructed with a `Result<CaptureWindow, VerifyError>`
    /// the test wants `verify_capture` to fold over.
    struct MockAudioInputProbe {
        result: Result<CaptureWindow, VerifyError>,
    }

    impl AudioInputProbe for MockAudioInputProbe {
        fn capture_window(
            &self,
            _device_hint: &str,
            _duration_ms: u64,
        ) -> Result<CaptureWindow, VerifyError> {
            self.result.clone()
        }
    }

    // ── Test 1 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_passes_when_peak_above_threshold() {
        // Loop-step AC #1: peak=0.5 ⇒ Verified.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                samples: vec![0.0, 0.5, -0.4, 0.1, 0.0, -0.5],
                callback_count: 80,
            }),
        };
        let report = verify_capture(&probe, "BlackHole 2ch", 5_000).expect("verify must pass");
        assert!((report.peak_amplitude - 0.5).abs() < f32::EPSILON);
        assert_eq!(report.callback_count, 80);
        assert_eq!(report.sample_count, 6);
        assert_eq!(report.duration_ms, 5_000);
    }

    // ── Test 2 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_fails_when_silent() {
        // Loop-step AC #2: silent device ⇒ BlackHolePresentButSilent (Swift exit 8).
        // 5 s @ 16 kHz of zeros — realistic empty-window from a Multi-Output that
        // exists but is NOT the system audio output.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                samples: vec![0.0; 16_000 * 5],
                callback_count: 320,
            }),
        };
        let err = verify_capture(&probe, "BlackHole 2ch", 5_000).expect_err("must classify silent");
        match err {
            VerifyError::BlackHolePresentButSilent {
                peak_amplitude,
                threshold,
                sample_count,
                callback_count,
                duration_ms,
            } => {
                assert_eq!(peak_amplitude, 0.0);
                assert_eq!(threshold, VERIFY_PEAK_THRESHOLD);
                assert_eq!(sample_count, 80_000);
                assert_eq!(callback_count, 320);
                assert_eq!(duration_ms, 5_000);
            }
            other => panic!("expected BlackHolePresentButSilent, got {other:?}"),
        }
    }

    // ── Test 3 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_times_out_when_zero_callbacks_in_5s() {
        // INDEX line 156 AC #3: stream built but ZERO callbacks ⇒ TimedOutNoCallbacks.
        // This is the TCC `Don't Allow` lane — Swift exit code 6 mirror.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                samples: vec![],
                callback_count: 0,
            }),
        };
        let err = verify_capture(&probe, "BlackHole 2ch", 5_000).expect_err("must time out");
        assert_eq!(err, VerifyError::TimedOutNoCallbacks { duration_ms: 5_000 });
    }

    // ── Test 4 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_returns_callback_count_for_telemetry() {
        // INDEX line 156 AC #4: `VerifyReport.callback_count` is preserved end-to-end.
        // Wizard surfaces it (e.g., "got 240 callbacks in 5 s ≈ 48 fires/sec") in the
        // Done-card debug expander. A thin stream (callback_count < 50 in 5 s) is a
        // signal to the user that something else is competing for the audio thread.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                // 5 s @ 16 kHz of constant 0.5 — peak 0.5, 80k samples.
                samples: vec![0.5; 16_000 * 5],
                callback_count: 240,
            }),
        };
        let report = verify_capture(&probe, "BlackHole 2ch", 5_000).expect("must pass");
        assert_eq!(report.callback_count, 240);
        assert_eq!(report.sample_count, 80_000);
        assert!((report.peak_amplitude - 0.5).abs() < f32::EPSILON);
    }

    // ── Test 5 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_propagates_device_not_found_from_probe() {
        // Loop-step AC #3 (alternate phrasing): probe can't find BlackHole ⇒
        // DeviceNotFound bubbles up unchanged. `verify_capture` must not silently
        // remap to TimedOutNoCallbacks (which would mislead the wizard into a
        // "TCC permission?" prompt instead of "Detect again").
        let probe = MockAudioInputProbe {
            result: Err(VerifyError::DeviceNotFound {
                hint: "BlackHole 2ch".to_string(),
                available_count: 3,
            }),
        };
        let err = verify_capture(&probe, "BlackHole 2ch", 5_000).expect_err("must propagate");
        match err {
            VerifyError::DeviceNotFound { hint, available_count } => {
                assert_eq!(hint, "BlackHole 2ch");
                assert_eq!(available_count, 3);
            }
            other => panic!("expected DeviceNotFound, got {other:?}"),
        }
    }

    // ── Test 6 ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn verify_propagates_build_input_stream_failed() {
        // PHASE-COMPLETE.md frozen `VerifyError` set: BuildInputStreamFailed must
        // pass through unchanged. Wizard surfaces the cpal error message verbatim.
        let probe = MockAudioInputProbe {
            result: Err(VerifyError::BuildInputStreamFailed("device busy".into())),
        };
        let err = verify_capture(&probe, "BlackHole 2ch", 5_000).expect_err("must propagate");
        match err {
            VerifyError::BuildInputStreamFailed(msg) => assert_eq!(msg, "device busy"),
            other => panic!("expected BuildInputStreamFailed, got {other:?}"),
        }
    }

    // ── BLOCKING constant guard ─────────────────────────────────────────────────────────
    #[test]
    fn peak_threshold_is_0_001_per_design() {
        // BLOCKING: design memo §4 + PHASE-COMPLETE.md "Closed VerifyError set" pins
        // the threshold at 1e-3. A typo to 1e-4 would re-promote the Swift spike's
        // silent-floor to "verified" — silently breaking the wizard for users whose
        // BlackHole is mounted but not routed.
        assert_eq!(VERIFY_PEAK_THRESHOLD, 0.001_f32);
    }

    // ── Boundary: peak == threshold classifies as silent (>, not ≥) ─────────────────────
    #[test]
    fn verify_at_threshold_exactly_classifies_as_silent() {
        // The `<= threshold` branch must catch peak == 0.001 exactly. Otherwise an
        // off-by-epsilon would let a barely-audible empty room promote.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                samples: vec![VERIFY_PEAK_THRESHOLD, -VERIFY_PEAK_THRESHOLD],
                callback_count: 1,
            }),
        };
        let err =
            verify_capture(&probe, "BlackHole 2ch", 5_000).expect_err("threshold-exact is silent");
        assert!(matches!(err, VerifyError::BlackHolePresentButSilent { .. }));
    }

    // ── Determinism: re-running verify with the same probe yields the same report ──────
    #[test]
    fn verify_is_pure_no_state_mutation_across_calls() {
        // Wizard re-runs verify on retry (SW-U11 / e2e E2E-5). Result must be
        // function of the probe response, not of probe call-count.
        let probe = MockAudioInputProbe {
            result: Ok(CaptureWindow {
                samples: vec![0.42, -0.13, 0.07],
                callback_count: 50,
            }),
        };
        let first = verify_capture(&probe, "BlackHole 2ch", 5_000).expect("pass 1");
        let second = verify_capture(&probe, "BlackHole 2ch", 5_000).expect("pass 2");
        assert_eq!(first, second);
    }
}
