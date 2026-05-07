# T-W.5 — Review (Verify capture FFI body)

> **Spec:** `docs/tasks/blackhole-wizard/T-W.5-verify.md`
> **Landed:** post-v1.0.1 fix loop, commit `d3071f1` (`feat(setup): T-W.5 verify capture FFI body + AudioInputProbe seam`).
> **Sign-off bump:** `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` task-tally row T-W.5 flipped from `Deferred to host` → landed (R-W.9, commit `1120024`).
> **Audit trail:** `docs/tasks/blackhole-wizard-fix/INDEX.md` step R-W.4.

## What changed

1. **NEW** `crates/audio-capture/src/verify.rs` (~470 LOC) — public surface per spec §"Public surface":
   - Constants: `VERIFY_PEAK_THRESHOLD = 0.001_f32`, `DEFAULT_VERIFY_DURATION_MS = 5_000`, `BLACKHOLE_NAME_HINT_LOWER`, `BLACKHOLE_UID_HINT`
   - Trait seam: `pub trait AudioInputProbe { fn capture_window(...) -> Result<CaptureWindow, VerifyError> }`
   - Production impl: `pub struct RealAudioInputProbe` (cpal `default_host().input_devices()` → `find_blackhole(hint)` → `build_input_stream::<f32>` → drain via `mpsc::sync_channel(1024)` → `AtomicU32` callback counter → `drop(stream)` snapshot)
   - Closed error set: `VerifyError::{ BlackHolePresentButSilent, TimedOutNoCallbacks, BuildInputStreamFailed(String), DeviceNotFound }` — `String` carrier (not `cpal::BuildStreamError`) to keep `Clone + PartialEq` for unit-test ergonomics
   - Pure dispatcher: `pub fn verify_capture<P: AudioInputProbe>(probe, hint, duration_ms) -> Result<VerifyReport, VerifyError>` — order-of-checks: callback_count==0 → TimedOut, then peak ≤ threshold → BlackHolePresentButSilent, then Ok(report)
2. **EDIT** `crates/audio-capture/src/lib.rs` — `pub mod verify;` re-export so downstream (`src-tauri/src/commands/setup.rs` from R-W.6) can call `audio_capture::verify::{verify_capture, RealAudioInputProbe, VerifyReport, VerifyError}`.
3. **NO new dependencies.** `cpal` and `thiserror` were already pinned in `crates/audio-capture/Cargo.toml` (T-1.3 / T-W.4 carry-forward).

## What tests cover it

9 unit tests under `crates/audio-capture/src/verify.rs::tests` — all exercise the pure dispatcher via `MockAudioInputProbe { result: Result<CaptureWindow, VerifyError> }`. Real cpal is **never** touched in `cargo test`; the operator's host-re-verify (`PHASE-MANUAL-VERIFY.md` steps 5/6/10) is the runtime gate.

| # | Test name | Asserts |
|---|---|---|
| 1 | `verify_passes_when_peak_above_threshold` | `Ok(VerifyReport { peak_amplitude: 0.5, callback_count: 80, sample_count: 6, duration_ms: 5_000 })` |
| 2 | `verify_fails_when_silent` | `Err(BlackHolePresentButSilent { peak_amplitude: 0.0, threshold: 0.001, sample_count: 80_000, callback_count: 320, duration_ms: 5_000 })` |
| 3 | `verify_times_out_when_zero_callbacks_in_5s` | `Err(TimedOutNoCallbacks { duration_ms: 5_000 })` (zero callbacks short-circuits BEFORE peak check) |
| 4 | `verify_returns_callback_count_for_telemetry` | report carries telemetry-grade `callback_count == 240` + `sample_count == 80_000` + `peak ≈ 0.5` |
| 5 | `verify_propagates_device_not_found_from_probe` | `DeviceNotFound { hint, available_count }` propagates unchanged (no remap to `TimedOut`) |
| 6 | `verify_propagates_build_input_stream_failed` | `BuildInputStreamFailed("device busy")` propagates unchanged with original message |
| 7 | `peak_threshold_is_0_001_per_design` | `assert_eq!(VERIFY_PEAK_THRESHOLD, 0.001_f32)` — BLOCKING constant guard against typo regression to `1e-4` |
| 8 | `verify_at_threshold_exactly_classifies_as_silent` | `peak == 0.001` is silent (the `<=` arm catches at-threshold) |
| 9 | `verify_is_pure_no_state_mutation_across_calls` | two calls with the same probe response return identical reports (wizard re-run / E2E-5 retry determinism) |

R-W.8 sweep (commit `5dfa228`):
- `cargo test -p audio-capture verify::` — **9 / 9 passed**
- `cargo test -p audio-capture` (full package) — **56 / 56 passed** (47 prior + 9 new)
- `cargo test --workspace` — **231 / 231 passed** on `aarch64-apple-darwin` (`cargo 1.95.0` / `rustc 1.95.0`)

## Sign-off checklist (per `docs/tasks/blackhole-wizard-fix/INDEX.md` §Process Rules)

- [x] **No regression vitest ≥ 934** (wizard v1.0.1 baseline). R-W.8 sweep landed at **952 / 952** vitest across 62 files. T-W.5 changes are Rust-only, so vitest delta is **0** at this task; the +18 vs baseline arrives in R-W.5 / R-W.7.
- [x] **`cargo test --workspace` ALL GREEN** — **231 / 231 passed** (audio-capture 56 + helper-daemon 87 + meeting-copilot-lib 16 + stt-mlx 72). Discovery 12 carry-forward Phase-3 compile errors closed in `0241167` (R-W.2 + R-W.3); 6 pre-existing Phase-3 runtime failures (backoff, URL classification, SSE order) folded into R-W.8 commit `5dfa228`.
- [x] **No `git push` performed.** Local commits only on `main` (`d3071f1` for T-W.5; `5dfa228` for sweep; `1120024` for R-W.9 verdict bump). Tag `v1.0.1` exists locally only — operator owns the push per Phase-W constraint.
- [x] **Idempotent re-run** — `verify_is_pure_no_state_mutation_across_calls` (test #9) asserts two consecutive `verify_capture` calls with the same probe response return identical `VerifyReport`s. The wizard's E2E-5 retry case (`tests/e2e/blackhole-wizard.e2e.test.ts`) already exercises the retry path via the `setupInvoker` mock; this test #9 is the unit-level guard.
- [x] **`setupCompleted` field migration safe** — N/A for T-W.5 (T-W.7 owns the settings field). T-W.5 is invoked downstream by `setup_verify_capture` (R-W.6); the wizard reaches Verify only after Detect/Configure complete, so even a returning user with `setupCompleted=false` post-upgrade short-circuits to Done in ≤ 2 s when BlackHole is already configured (T-W.6 FSM `nextStepForDetect("configured") === "verify"`).

## Why this approach

- **Trait seam over inline cpal.** `AudioInputProbe` mirrors T-W.2 `CoreAudioProbe` and T-W.4 `AggregateDeviceCreator` — the same pattern lets us unit-test the dispatcher without TCC microphone permission in the cargo-test process. Hard-wiring cpal would force a `#[cfg(target_os = "macos")]` gate on the tests AND would block on the TCC modal forever in the operator's terminal-launched `cargo test`.
- **`String` not `cpal::BuildStreamError`.** `cpal::BuildStreamError` is `Send + Sync` but not `Clone + PartialEq`. The closed `VerifyError` set needs both for unit-test `assert_eq!` ergonomics and for serde round-trip via the Tauri command DTO (R-W.6). Preserving the original message via `.to_string()` keeps the wizard troubleshooting card surface lossless.
- **Order-of-checks: callback_count==0 BEFORE peak.** A zero-callback empty window has `peak == 0`, which would mis-classify as `BlackHolePresentButSilent` if peak were checked first — that wording would mislead the user toward "Output not routed" when the actual cause is TCC permission denial. Checking `callback_count == 0` first surfaces `TimedOutNoCallbacks` and triggers the wizard's TCC re-prompt copy.
- **Threshold 0.001 (strict `>`), at-threshold is silent.** Mirrors Swift spike `experiments/T-0.2/blackhole_capture.swift:340` exit-code-8 lane. Test #8 is the regression guard if anyone "fixes" the comparator to `>=`.
- **Stream lifecycle: drop(stream) BEFORE counter snapshot.** cpal's `Stream` Drop impl synchronously stops the audio thread on macOS, so the `AtomicU32::load()` after drop is guaranteed to see no further increments. Documented in `verify.rs` lifecycle comment.

## Risks & follow-ups

- **Real cpal path is not unit-tested.** By design — TCC permission propagation and audio-thread liveness are runtime properties. The host-re-verify procedure (`PHASE-MANUAL-VERIFY.md` steps 5/6/10) is the runtime gate, run by the operator on a Mac with BlackHole installed. cargo-test never touches real CoreAudio.
- **Cross-platform compile.** cpal is portable, so `RealAudioInputProbe` compiles on Linux/Windows. The hint matcher (`BLACKHOLE_NAME_HINT_LOWER`) is BlackHole-specific; on non-Mac the device enumeration would surface `DeviceNotFound`, which is the correct error.
- **No `cpal::BuildStreamError` source preservation.** If the wizard wants structured cpal-error introspection later, `BuildInputStreamFailed(String)` must be widened to a new variant (or `source: Option<Box<dyn Error>>`). Not blocking for v1.0.1 — the user-facing message is opaque cpal text either way.
- **No telemetry sink.** `VerifyReport` carries `peak_amplitude / callback_count / sample_count / duration_ms` for the wizard to display; if Phase-W follow-up adds a telemetry pipeline, those fields are already wire-format-compatible.
