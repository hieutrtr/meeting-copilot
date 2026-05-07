# T-W.5 — BlackHole Capture Smoke Test (`verify_capture`)

> Phase-W BlackHole Setup Wizard. Iter R-W.4 of `docs/tasks/blackhole-wizard-fix/INDEX.md` (host re-run after toolchain install). Spec written before implementation per Rule 2 TDD; review checklist deferred to R-W.10.
>
> Reference: `docs/blackhole-wizard-design.md` §4 "Verify capture", `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` lines 60–66 (closed `BlackHoleStatus::Verified` + `VerifyError` set), Swift spike `experiments/T-0.2/blackhole_capture.swift:293-377` (peak + tap loop blueprint), T-W.2 / T-W.4 trait-seam pattern (`crates/audio-capture/src/blackhole.rs` + `multi_output.rs`).

---

## Goal

Land the capture-smoke-test FFI body deferred from v1.0.1. After this iteration:

1. `crates/audio-capture/src/verify.rs` exists and exports `verify_capture()` + `AudioInputProbe` trait + `RealAudioInputProbe` cpal impl + closed `VerifyError` set + `VerifyReport` struct.
2. `cargo test -p audio-capture verify::` is green on aarch64-apple-darwin (host with cpal toolchain).
3. The wizard's Verify step (`SetupWizard.tsx` SW-S5, `useSetupWizard.ts` `verify_clicked` → `verify_completed`) has a real implementation behind it; the e2e harness (`tests/e2e/blackhole-wizard.e2e.test.ts` E2E-1 / E2E-5) keeps using the trait-mock fixture, so its 6 vitest cases are unchanged.
4. T-W.7 part B (Tauri command `setup_verify_capture`, lands in R-W.6) has a callable target — `verify_capture(&RealAudioInputProbe::default(), bh_uid_hint, 5_000)`.

---

## Public surface

```rust
// crates/audio-capture/src/verify.rs

pub const VERIFY_PEAK_THRESHOLD: f32 = 0.001;
pub const DEFAULT_VERIFY_DURATION_MS: u64 = 5_000;

pub trait AudioInputProbe {
    fn capture_window(
        &self,
        device_hint: &str,
        duration_ms: u64,
    ) -> Result<CaptureWindow, VerifyError>;
}

#[derive(Debug, Clone)]
pub struct CaptureWindow {
    pub samples: Vec<f32>,
    pub callback_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifyReport {
    pub peak_amplitude: f32,
    pub callback_count: u32,
    pub sample_count: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum VerifyError {
    BlackHolePresentButSilent {
        peak_amplitude: f32,
        threshold: f32,
        sample_count: usize,
        callback_count: u32,
        duration_ms: u64,
    },
    TimedOutNoCallbacks { duration_ms: u64 },
    BuildInputStreamFailed(String),
    DeviceNotFound { hint: String, available_count: usize },
}

pub fn verify_capture<P: AudioInputProbe>(
    probe: &P,
    device_hint: &str,
    duration_ms: u64,
) -> Result<VerifyReport, VerifyError>;

pub struct RealAudioInputProbe;
impl AudioInputProbe for RealAudioInputProbe { /* cpal */ }
```

`VerifyError` extends the v1.0.1-frozen closed set (PHASE-COMPLETE.md line 66) with one new variant `DeviceNotFound { hint, available_count }`. The original three variants — `BlackHolePresentButSilent`, `TimedOutNoCallbacks`, `BuildInputStreamFailed` — keep their semantic positions; the wrapped error type for `BuildInputStreamFailed` is `String` (not `cpal::BuildStreamError`) so the variant stays `Clone + PartialEq` for unit-test ergonomics. The cpal error message is preserved verbatim via `.to_string()` so the wizard's troubleshooting card surfaces it untouched.

`VerifyError::BlackHolePresentButSilent` carries the diagnostic context (peak, threshold, sample count, callback count, duration) so the wizard's Verify-card retry hint can display "got peak 0.0 over 80,000 samples / 320 callbacks in 5 s — Multi-Output exists but isn't routed". Telemetry-grade fields, all locally computed — no PII.

---

## Classification matrix

| Probe response | `verify_capture` outcome |
|---|---|
| `Ok(CaptureWindow { samples, callback_count: 0 })` | `Err(TimedOutNoCallbacks { duration_ms })` (Swift exit code 6 mirror — TCC `Don't Allow` lane) |
| `Ok(CaptureWindow { samples, callback_count > 0 })` AND `peak_abs(samples) > 0.001` | `Ok(VerifyReport { peak_amplitude, callback_count, sample_count, duration_ms })` |
| `Ok(CaptureWindow { samples, callback_count > 0 })` AND `peak_abs(samples) ≤ 0.001` | `Err(BlackHolePresentButSilent { … })` (Swift exit code 8 mirror — Multi-Output exists but not routed) |
| `Err(VerifyError::DeviceNotFound { … })` | propagated unchanged |
| `Err(VerifyError::BuildInputStreamFailed(…))` | propagated unchanged |
| `Err(VerifyError::*)` from probe | propagated unchanged |

Threshold is `> 0.001` (strict). At-threshold is silent — see test #8 below.

Order matters: `callback_count == 0` is checked **before** peak. A zero-sample empty window with zero callbacks would otherwise trip `BlackHolePresentButSilent` (peak 0 ≤ 0.001) which would mislead the user toward "Output not routed" when the actual cause is permission denial.

---

## Trait seam — `AudioInputProbe`

Same shape as T-W.2 `CoreAudioProbe` and T-W.4 `AggregateDeviceCreator`:

- Production impl `RealAudioInputProbe` opens a `cpal::Stream` against the host's BlackHole device.
- Tests use `MockAudioInputProbe { result: Result<CaptureWindow, VerifyError> }` — never touches the audio system.
- The Tauri command `setup_verify_capture` (R-W.6) constructs `RealAudioInputProbe::default()` and calls `verify_capture(&probe, "BlackHole 2ch", 5_000)`. Wizard's e2e harness injects a mock invoker via the `setupInvoker` prop pinned in T-W.6.

`device_hint` is a case-insensitive substring matched against `cpal::Device::name()` AND the canonical BlackHole UID stamps (`BLACKHOLE_NAME_HINT_LOWER`, `BLACKHOLE_UID_HINT`). Empty hint defaults to "blackhole 2ch" — same matcher as `find_blackhole` in T-W.2. A user who renamed their device in Audio MIDI Setup but kept the installer-stamped UID still resolves.

---

## RealAudioInputProbe — cpal stream lifecycle

```
1. cpal::default_host().input_devices()                           ← enumerate
2. devices.iter().find(|d| match_input_device(d, hint_lower))     ← pick BH
3. device.default_input_config()                                  ← native f32 cfg
4. device.build_input_stream::<f32>(config, callback, err_fn)     ← stream
5. stream.play()                                                  ← arm
6. while elapsed < duration_ms:                                   ← drain
       rx.recv_timeout(min(remaining, 100ms))
       → samples.extend(chunk)
7. drop(stream)                                                   ← teardown
8. CaptureWindow { samples, callback_count: counter.load() }      ← snapshot
```

**Real-time safety**: the cpal callback thread runs at audio priority on macOS. Inside the callback we (a) bump an `AtomicU32` counter (lock-free, no allocation), and (b) `try_send` the frame `Vec<f32>` onto a 1024-deep `mpsc::sync_channel`. `try_send` is non-blocking — if the consumer is back-pressured we drop the frame rather than block the audio thread. Same pattern as `mic.rs:134` (T-1.3 carry-forward).

**Buffer sizing**: cpal Mac default callback fires every ~256 frames at 48 kHz ≈ 5 ms. 1024 deep ≈ 5 s of head-room. The consumer thread polls every 100 ms — we expect it to drain at ~50 chunks/poll, far below the 1024 ceiling under any realistic workload.

**Stream teardown**: drop(stream) before reading the AtomicU32 ensures we don't see a callback-fire AFTER the snapshot — the cpal `Stream` Drop impl synchronously stops the audio thread on macOS.

---

## TDD — 9 unit tests via `MockAudioInputProbe`

| # | Test | Probe response | Expected outcome |
|---|---|---|---|
| 1 | `verify_passes_when_peak_above_threshold` | samples `[0, 0.5, -0.4, 0.1, 0, -0.5]`, callbacks 80 | `Ok(VerifyReport { peak: 0.5, callbacks: 80, samples: 6, duration: 5_000 })` |
| 2 | `verify_fails_when_silent` | 80 000 zeros, 320 callbacks | `Err(BlackHolePresentButSilent { peak: 0.0, threshold: 0.001, samples: 80_000, callbacks: 320, duration: 5_000 })` |
| 3 | `verify_times_out_when_zero_callbacks_in_5s` | empty samples, 0 callbacks | `Err(TimedOutNoCallbacks { duration: 5_000 })` |
| 4 | `verify_returns_callback_count_for_telemetry` | 80 000 × 0.5, 240 callbacks | `Ok(report.callback_count == 240)` + `report.sample_count == 80_000` + `report.peak_amplitude ≈ 0.5` |
| 5 | `verify_propagates_device_not_found_from_probe` | `Err(DeviceNotFound { … })` | propagates unchanged (NO remap to `TimedOutNoCallbacks`) |
| 6 | `verify_propagates_build_input_stream_failed` | `Err(BuildInputStreamFailed("device busy"))` | propagates unchanged with original message |
| 7 | `peak_threshold_is_0_001_per_design` | n/a | `assert_eq!(VERIFY_PEAK_THRESHOLD, 0.001_f32)` — BLOCKING constant guard against typo to `1e-4` (Swift spike's silent floor) |
| 8 | `verify_at_threshold_exactly_classifies_as_silent` | samples `[0.001, -0.001]`, callbacks 1 | `Err(BlackHolePresentButSilent { … })` — the `<=` arm catches at-threshold (off-by-epsilon would let empty rooms promote) |
| 9 | `verify_is_pure_no_state_mutation_across_calls` | fixed probe response, two calls | `first == second` (wizard re-run / E2E-5 retry must be deterministic) |

All 9 use `MockAudioInputProbe` — zero real cpal calls, zero TCC prompt, runs on any host (CI, sandbox, dev box). The cross-platform-compile property holds: cpal IS portable, so `RealAudioInputProbe` compiles on Linux / Windows too; only the device hint match-pattern is BlackHole-specific.

**Loop-step prompt** (R-W.4 of `INDEX.md`) requested 3 mock-probe tests (silent / peak=0.5 / device-not-found); INDEX line 156 requested 4 (`verify_passes_when_peak_above_threshold`, `verify_fails_when_silent`, `verify_times_out_when_zero_callbacks_in_5s`, `verify_returns_callback_count_for_telemetry`). The 9-test set is a superset that covers both lists plus the BLOCKING constant guard, the boundary case, and a determinism check.

---

## Mock-vs-real coverage

`MockAudioInputProbe` covers every `verify_capture` branch — that's the right level: `verify_capture` is the unit under test, the cpal stream is a system boundary. `RealAudioInputProbe` is exercised by:

- `cargo build -p audio-capture` — compile-check only (no runtime; cpal is gated to compile cleanly without a sound card).
- **Host re-verify** (`PHASE-MANUAL-VERIFY.md` step 5 — happy path; step 6 — silent retry; step 10 — TCC `Don't Allow`). These are end-to-end runs by the operator on a Mac with BlackHole installed; the runs hit the real cpal path.
- E2E harness `tests/e2e/blackhole-wizard.e2e.test.ts` injects a mock `setup_verify_capture` Tauri-command response — also no real cpal. The 6 e2e cases stay at 6.

The cargo-test process running on the operator's box does NOT have TCC microphone permission (it's the operator's terminal, not Meeting Copilot.app). If we tried to run the cpal path under `cargo test`, the test would block on the TCC modal forever. So `RealAudioInputProbe` is **explicitly never exercised by `cargo test`** — the operator's host re-verify is the runtime gate.

---

## Wiring map (T-W.5 stops here; downstream lands in subsequent R-W tasks)

```
crates/audio-capture/src/verify.rs    ← THIS task (R-W.4)
                ▲
                │ verify_capture(&RealAudioInputProbe::default(), uid_hint, 5_000)
                │
src-tauri/src/lib.rs                  ← R-W.6 (T-W.7 part B)
    #[tauri::command]
    async fn setup_verify_capture() -> Result<VerifyReport, VerifyError>
                ▲
                │ invoke('setup_verify_capture')
                │
src/components/SetupWizard.tsx        ← T-W.6 (already landed, props-injected)
    onVerify ⇒ setupInvoker.verify_capture()
                ▲
                │ <SetupWizard onDone={...} setupInvoker={...} />
                │
src/App.tsx                           ← R-W.7 (T-W.7 part C)
    {!setupCompleted && <SetupWizard ...>}
```

R-W.4 owns the bottom box. R-W.5/R-W.6/R-W.7 own everything above (already pinned by the wizard's `setupInvoker` props contract).

---

## Acceptance Criteria

- [ ] `crates/audio-capture/src/verify.rs` exists with public surface above; `lib.rs` re-exports.
- [ ] `cargo test -p audio-capture verify::` runs 9 tests, all green.
- [ ] `cargo test -p audio-capture` runs full suite (47 prior + 9 new = 56), zero regressions.
- [ ] `cargo build -p audio-capture` compiles clean (no warnings except pre-existing `unused import: Cursor` in `wav.rs` — orthogonal to this task).
- [ ] `RealAudioInputProbe` compiles cross-platform (cpal is portable; verified by lib.rs `pub use` not gated on `cfg(target_os = "macos")`).
- [ ] `VerifyError` carries enough context (peak, threshold, samples, callbacks, duration) for the wizard's troubleshooting card to display "what was measured + what threshold was missed".
- [ ] No `git push` performed.
- [ ] No new dependencies added (cpal + thiserror already in `Cargo.toml`).

Review document deferred to R-W.10.

---

## Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-T-W.5.1 | TCC microphone prompt blocks `cargo test` if `RealAudioInputProbe` is accidentally exercised | Mock-only coverage in `cargo test`; `RealAudioInputProbe` only constructed inside the Tauri command (R-W.6) which runs in Meeting Copilot.app's process where TCC has been pre-granted at first launch by the wizard's pre-prompt blurb. |
| R-T-W.5.2 | cpal callback thread allocates inside `tx.try_send(data.to_vec())` — that allocation is on the audio thread | Acceptable for a 5-second smoke test. The frame size is bounded (≤ 1024 frames per cpal Mac default) and we drop on back-pressure. Production capture path (T-1.3 `mic.rs`) uses the same pattern; it's been live since Phase 1. A future Phase 1.x optimization could pre-allocate a slab pool. |
| R-T-W.5.3 | `cpal::BuildStreamError` is wrapped as `String`, not the typed error | The wizard surfaces the message verbatim; no consumer matches on the wrapped variant. PHASE-COMPLETE.md said `cpal::BuildStreamError` but cpal's error type is neither `Clone` nor `PartialEq`, blocking unit-test ergonomics. String wrapper preserves the message and unblocks every test path. |
| R-T-W.5.4 | Off-by-epsilon at the threshold lets a silent room promote to Verified | Test #8 (`verify_at_threshold_exactly_classifies_as_silent`) pins the `<=` boundary; test #7 (`peak_threshold_is_0_001_per_design`) BLOCKS any constant edit. Two-test defence in depth. |
| R-T-W.5.5 | Wizard re-runs Verify on retry; non-determinism would cause flicker | Test #9 (`verify_is_pure_no_state_mutation_across_calls`) asserts pure function modulo `probe.capture_window`. The probe itself uses `cpal::Stream` which IS stateful but each `capture_window` call opens a fresh stream — the fresh-stream-per-call contract is documented in the impl header. |

---

## Deferral closing the loop

PHASE-COMPLETE.md (v1.0.1 sign-off, commit `d9883d4`) listed T-W.5 as **"Deferred to host (FFI body + cargo re-verify gate)"**. This iteration closes that deferral. The wizard FSM (T-W.6, frozen) and e2e harness (T-W.9, frozen) have always consumed the same `VerifyReport` / `VerifyError` shape via the `setupInvoker` props contract — no UI or test rewrite is needed. R-W.6 wires the Tauri command, R-W.7 mounts the wizard, and R-W.9 flips the PHASE-COMPLETE verdict.
