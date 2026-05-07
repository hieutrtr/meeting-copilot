# T-W.7 — Review (App.tsx mount + setupCompleted persistence + Tauri command wrappers)

> **Spec (umbrella):** `docs/tasks/blackhole-wizard/T-W.7-integration.md` (Parts A/B/C)
> **Landed across:**
> - **Part A** — `src/store/settingsStore.ts` `setupCompleted: boolean` field (R-W.5, commit `b2cbd96`)
> - **Part B** — `src-tauri/src/commands/setup.rs` 4 `#[tauri::command]` wrappers + `src/lib/setupCommands.ts` typed JS shims (R-W.6, commit `b2cbd96`)
> - **Part C** — `src/App.tsx` wizard gate + invoker adapters + 4 RTL integration tests (R-W.7, commit `4f235b6`)
> **Sign-off bump:** `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` task-tally row T-W.7 flipped from `Deferred to host` → landed (R-W.9, commit `1120024`).
> **Audit trail:** `docs/tasks/blackhole-wizard-fix/INDEX.md` steps R-W.5 / R-W.6 / R-W.7. Per-step review note: `docs/tasks/blackhole-wizard-fix/R-W.7-review.md`.

## What changed

### Part A — Settings field (R-W.5, commit `b2cbd96`)

- `src/store/settingsStore.ts` — added `setupCompleted: boolean` to `SettingsValues` (default `false`); extended `coerceLoaded` with the same zero-fill arm that T-3.9 (`telemetryEnabled`) and T-4.2 (`mcpServerEnabled`) use, so a v1/v2 settings payload from an upgrading user round-trips with `setupCompleted: false`.
- `src/store/settingsStore.test.ts` — net-new tests for default value, post-set persistence to `localStorage`, and `coerceLoaded` zero-fill from a payload missing the key.

### Part B — Tauri command wrappers (R-W.6, commit `b2cbd96`)

- `src-tauri/src/commands/setup.rs` — NEW module exposing 4 `#[tauri::command] async fn`s, each delegating to its helper-daemon / audio-capture function via the production trait impls (`RealCoreAudioProbe`, `RealAggregateDeviceCreator`, `RealAudioInputProbe`):

| Command | Backend call | DTO |
|---|---|---|
| `setup_detect_blackhole` | `audio_capture::blackhole::find_blackhole(&RealCoreAudioProbe)` | `BlackHoleStatusDto` |
| `setup_install_blackhole` | `helper_daemon::setup_install::install_via_brew(&RealFilesystem, &RealProcessRunner)` | `InstallReportDto` |
| `setup_configure_multi_output` | `audio_capture::multi_output::create_multi_output(&RealAggregateDeviceCreator, &RealCoreAudioProbe, ...)` | `ConfigureMultiOutputResultDto` |
| `setup_verify_capture` | `audio_capture::verify::verify_capture(&RealAudioInputProbe, hint, duration_ms)` (T-W.5 from R-W.4) | `VerifyReportDto` |

- `src-tauri/src/lib.rs` — registered the 4 commands in the Tauri builder's `invoke_handler`.
- `src/lib/setupCommands.ts` — NEW; typed `invoke()` wrappers (`setupDetectBlackhole`, `setupInstallBlackhole`, `setupConfigureMultiOutput`, `setupVerifyCapture`); each wrapper has a single source-of-truth string constant for the command name, used by both the `#[tauri::command(rename_all = ...)]` arg and the TS invoker.
- `src/lib/setupCommands.test.ts` — 5 vitest cases lock command-name strings + camelCased arg shapes.
- 6 cargo `#[test]`s in `src-tauri/src/commands/setup.rs` round-trip the 4 DTOs through serde JSON to detect wire-format drift between the Rust DTO and the TS shape.

### Part C — App.tsx mount (R-W.7, commit `4f235b6`)

- `src/App.tsx` — reads `useSettingsStore((s) => s.setupCompleted)`. When `false`, renders `<SetupWizard invokers={wizardInvokers} onDone={onWizardDone} />` and **replaces** (does not overlay) the meeting-UI shell. When `true`, renders the original `<main>{ContextLoader, MeetingControls, …}</main>` body.
- 4 `useMemo` invoker adapters bridge the wizard's `SetupWizardInvokers` shape to the typed `setupCommands` wrappers. `detect`'s result is cached in a `detectStatusRef` so `configure` can forward the BlackHole UID as a single-element `subDeviceUids: string[]`. `install`'s `onLine` callback is intentionally a no-op (brew streaming is a Phase-W follow-up). `verify` forwards `SETUP_VERIFY_DEVICE_HINT = "blackhole"` + `SETUP_VERIFY_DURATION_MS = 5_000` (mirrors `crates/audio-capture/src/verify.rs:298`).
- `onWizardDone = useCallback(() => setSetupCompleted(true), [setSetupCompleted])` — single Zustand setter call; the next render's `if (!setupCompleted)` evaluates `false` and the wizard unmounts.
- `src/App.test.tsx` — NEW; 4 RTL integration tests (`SetupWizard` mocked to a click-driven stub so the App-level mount gate is the unit under test).
- `src/__tests__/E2E.test.tsx` — pre-flips `setupCompleted=true` in `beforeEach` so the existing happy-path tests continue seeing the meeting UI directly (without this, the new wizard gate would short-circuit them).

## What tests cover it

| Suite | Tests | Asserts |
|---|---|---|
| `src/store/settingsStore.test.ts` | 3 net-new (R-W.5) | default `false`, post-set persistence, `coerceLoaded` zero-fill on missing key |
| `src/lib/setupCommands.test.ts` | 5 net-new (R-W.6) | command-name string literals + camelCased arg shapes (renaming any command name on either side trips the test) |
| `src-tauri/src/commands/setup.rs::tests` | 6 net-new (R-W.6) | DTO ↔ JSON round-trip (4 DTOs) + 2 dispatch-shape sanity checks |
| `src/App.test.tsx` (NEW) | 4 net-new RTL (R-W.7) | WT-1 wizard rendered when flag false / WT-2 wizard skipped when flag true / WT-3 onDone flips flag + unmounts wizard / WT-4 toggling flag back re-mounts wizard without breaking the meeting UI |
| `src/components/SetupWizard/SetupWizard.test.tsx` | (existing) 12 RTL | FSM internals — untouched, regression-proven by R-W.8 sweep |
| `src/__tests__/E2E.test.tsx` | (existing) 6 e2e | Pre-flipped `setupCompleted=true` in `beforeEach`; meeting-UI happy path runs unchanged |

R-W.8 sweep (commit `5dfa228`):
- Vitest: **952 / 952 passed** across 62 files (wizard v1.0.1 baseline 934 → +18 from settings (3) + setupCommands (5) + App.tsx (4) + reducer regression coverage from T-W.5 / T-W.7 wiring (6))
- Cargo: **231 / 231 passed** (meeting-copilot-lib carries the 6 setup-command DTO + dispatch tests)
- `bun run typecheck` (`tsc --noEmit`): **0 errors**

## Sign-off checklist (per `docs/tasks/blackhole-wizard-fix/INDEX.md` §Process Rules)

- [x] **No regression vitest ≥ 934.** Final **952 / 952** post R-W.8 sweep — net **+18**, zero file-level regressions, all 60+ pre-T-W.7 vitest files still green (verified via `bun run test` reporter summary in `R-W.8-test-sweep.md`).
- [x] **`cargo test --workspace` ALL GREEN** — **231 / 231** (audio-capture 56 + helper-daemon 87 + meeting-copilot-lib 16 + stt-mlx 72) on `aarch64-apple-darwin` (`cargo 1.95.0` / `rustc 1.95.0`). Carry-forward Phase-3 compile (R-W.2/R-W.3) + runtime (R-W.8 F1/F2/F3) closures unblock the green-bar.
- [x] **No `git push` performed.** All five commits land on local `main` only (`b2cbd96` for R-W.5+R-W.6, `4f235b6` for R-W.7, `5dfa228` for sweep, `1120024` for R-W.9 verdict bump). Tag `v1.0.1` exists locally only.
- [x] **Idempotent re-run.** WT-4 (`re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui`) toggles `setupCompleted` back to `false` after a completion, mounts the wizard again, runs onDone a second time, and asserts the meeting UI re-renders without throwing. The wizard FSM's own short-circuit (`nextStepForDetect("configured") === "verify"`) means even a re-run takes ≤ 2 s if BlackHole is already configured.
- [x] **`setupCompleted` field migration safe.** Default `false` + `coerceLoaded` zero-fill on missing key (T-3.9 / T-4.2 carry-forward pattern) → existing users with v1/v2 settings payload see the wizard once on first launch post-upgrade. The wizard short-circuits to Done in ≤ 2 s if BlackHole is already configured (T-W.6 FSM). `coerceLoaded` test in `settingsStore.test.ts` is the regression guard.

## Why this approach

- **Replace, don't overlay.** The wizard already declares `role="dialog" aria-modal="true"` (`SetupWizard.tsx:184–187`). Layering the meeting-UI shell underneath would duplicate scrollable surfaces and create focus-trap edge cases. Replacing the App body until completion is simpler and matches the wizard's own ARIA semantics.
- **Stub the wizard in `App.test.tsx`.** The wizard FSM has 12 RTL cases of its own; re-asserting them in App-level tests would duplicate work and bloat the suite. WT-1..WT-4 test the **gate** (App's responsibility), not the **flow** (wizard's responsibility).
- **Adapt at the App layer (`useMemo` invoker shims).** The wire-format wrappers (`setupCommands.ts`) own the Tauri shape; the wizard owns its UI shape. Adapters in App.tsx are the natural hinge — and they keep `setupCommands` reusable for any future settings affordance ("re-run setup wizard from Settings") without dragging in wizard-shaped types.
- **Pre-flip `setupCompleted=true` in E2E tests.** Existing E2E.test.tsx is testing meeting-UI happy-path, not wizard gating. Skipping the wizard there is the correct scope decision; WT-1..WT-4 cover the gate explicitly.
- **Single source-of-truth for command-name strings.** Each of the 4 commands has one `pub const SETUP_*_COMMAND: &str` (or equivalent) that the `#[tauri::command(rename_all = ...)]` arg AND the TS `invoke()` call site both reference. Rename one, the test trips. Mitigates the silent-runtime-failure mode where a typo only surfaces when a user clicks Detect.
- **`coerceLoaded` zero-fill (R-W.5).** Pattern carried forward from T-3.9 and T-4.2. Adding new persisted booleans without breaking existing users is now a 3-line change.

## Risks & follow-ups

- **brew streaming.** `install(onLine)` is currently a no-op. Long brew cask installs (~30–90 s) will show an empty progress log mid-install. Phase-W follow-up: have `helper_daemon::install_via_brew` emit Tauri events that the App invoker forwards into `onLine`.
- **Configure UID picker.** App.tsx forwards a single UID (the BlackHole UID from the cached detect status). A richer UX would let the user pick a destination speaker; the wire format already supports it (`subDeviceUids: string[]`).
- **Re-run from Settings.** WT-4 asserts the gate-toggle works end-to-end, but the user-visible Settings button is not yet implemented. A small SettingsSheet addition would expose `setSetupCompleted(false)` to the user.
- **Verify deviceId fast-path.** The wizard plumbs `multi_output_id` through the verify invoker but App.tsx ignores it; Rust resolves by hint string. Adding a numeric-deviceId variant of `setup_verify_capture` would skip the cpal enumerate scan; not blocking.
- **TCC microphone re-prompt.** `setup_verify_capture` triggers TCC the first time it runs in the bundle. The wizard copy already explains this (`SetupWizard.tsx` Verify step); R-W.6 / R-W.7 do not change that surface.
