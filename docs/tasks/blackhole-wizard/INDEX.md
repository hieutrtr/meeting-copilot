# BlackHole Setup Wizard — Post-v1.0 Patch — Task Index

> Reference: `docs/spike-memo.md` §"Unknown #1" caveat — `BlackHole-2ch is not installed (no input device matched 'BlackHole 2ch')` (line ~158 of `experiments/T-0.2/blackhole_capture.swift`); Phase 1 INDEX "Known Gaps" #1 (carried forward through Phase 2 / 3 / 4 sign-offs).
> Companion design doc: `docs/blackhole-wizard-design.md` (1-page; landed iter 1 with this INDEX).
> Reference impl: `experiments/T-0.2/blackhole_capture.swift` (CoreAudio device-enumeration scaffolding — used as the structural blueprint for the Rust detection module under `crates/audio-capture/src/blackhole/`).
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.
> Stack lock (carry-forward from Phase 1 + 2 + 3 + 4): **Tauri 2 + React + TypeScript + Rust helper daemon + cpal + MLX whisper + Deepgram + ElevenLabs + Claude Sonnet 4.6**. Wizard ADDS: `coreaudio-rs ^0.11` (Rust bindings to AudioHardware* API for Multi-Output Device creation), 1 new React component tree (`src/components/SetupWizard/*.tsx`, 5-step state machine), 1 new Tauri command surface (`src-tauri/src/lib.rs` `setup_*` invokes), no new npm deps on the TS side beyond what Phase 4 already pinned.

---

## Phase Goal

Eliminate the Phase 0 carry-forward blocker `brew install blackhole-2ch` + Audio MIDI Setup walkthrough by shipping an in-app onboarding wizard that **detects, installs, configures, and verifies** BlackHole 2ch + Multi-Output Device automatically on first launch — with a documented manual fallback for users without Homebrew.

## Phase Exit Criteria

A user with a fresh Mac (no BlackHole, no Multi-Output Device, no prior Meeting Copilot install) installs Meeting Copilot v1.0.1 from DMG, launches once, walks the wizard end-to-end (Welcome → Detect → Install → Configure → Verify), and leaves the wizard with: (a) BlackHole 2ch listed in CoreAudio device enumeration, (b) a Multi-Output Device named `MeetingCopilotMultiOut` containing built-in output + BlackHole, (c) a 5-second capture smoke test producing peak amplitude > 0.001 from the BlackHole device. Phase 1–4 audio capture path **unchanged** (zero regression on `bun test` + `cargo test`).

This loop's gate (mirrors Phase 1 / 2 / 3 / 4 sign-off shape):

1. `bun test` (vitest) + `cargo test --workspace` all green — zero Phase 1–4 regression.
2. T-W.9 E2E test (fresh-Mac simulation, all CoreAudio + brew calls mocked): wizard walks all 5 steps to "All set" green check in ≥ 3/3 deterministic runs.
3. `PHASE-COMPLETE.md` (under `docs/tasks/blackhole-wizard/`) sign-off committed with: detection layer table, install method tree, configure CFDictionary blueprint, wizard state-machine diagram, permission-prompt UX inventory, v1.0.1 release plan.
4. Local annotated tag `v1.0.1` (NOT pushed — operator pushes after sign-off).

---

## Inputs Carried Forward From Phase 0–4

These artifacts are **re-used** (NOT re-implemented); the wizard plugs into the same seams:

- **`experiments/T-0.2/blackhole_capture.swift`** — Swift CoreAudio device-enumeration scaffolding (`enumerateDevices()`, `cfStringForProperty`, `findBlackHole`, exit codes 5–10). T-W.2 ports this Swift logic into Rust via `coreaudio-rs::AudioObject*` calls — same shape, zero behavioral change. Five Swift exit codes (`blackhole_not_installed=7`, `tcc_not_authorized=6`, `engine_start_failed=4`, `current_device_set_failed=9`, `blackhole_present_but_silent=8`) become five Rust enum variants in `BlackHoleStatus`.
- **`crates/audio-capture/`** — already owns `cpal::default_input_device()` and the `AudioSource` trait (T-1.3). Wizard adds `crates/audio-capture/src/blackhole.rs` (NEW) reusing the same crate's `cpal` host enumeration where possible; falls back to raw `coreaudio-sys` calls only for Aggregate Device creation (cpal does not expose that API).
- **`src-tauri/src/lib.rs`** — gains 4 new `#[tauri::command]` wrappers: `setup_detect_blackhole`, `setup_install_blackhole`, `setup_configure_multi_output`, `setup_verify_capture`. Same dispatch pattern as the existing `commands::start_from_deeplink` from Phase 4.
- **`src-tauri/tauri.conf.json`** capabilities — already declares `core:default` (Phase 0/4); wizard requires NO new capability since all subprocess calls (`brew`, `osascript`) run from Rust-side via `std::process::Command`, never via the Tauri shell plugin.
- **`src/store/settingsStore.ts`** (carry-forward Phase 2/3/4) — gains 1 additive field: `setupCompleted: boolean` (default `false`; flips to `true` after T-W.5 Verify step succeeds). Same `coerceLoaded` zero-fill pattern as `telemetryEnabled` (Phase 3 T-3.9) and `mcpServerEnabled` (Phase 4 T-4.2).
- **`src/App.tsx`** — top-level integration in T-W.7: read `settingsStore.setupCompleted` on mount; if `false`, render `<SetupWizard />` modal overlay; otherwise render the existing main UI unchanged. Wizard mount is the only new conditional render.
- **`docs/tasks/phase-4/INDEX.md` rule structure** (`Process Rules`, `TDD per task`, `Acceptance Criteria Summary`, `Risk Register`) — reused verbatim, only the task-name prefix changes (`T-4.<N>` → `T-W.<N>`).

Three Phase-0 carry-forward blockers stay open after this wizard ships:

1. **`ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY`** — wizard does NOT touch API key flows; remains the user's responsibility per Phase 1 onboarding.
2. **`cargo` + `rustup` + `tauri-cli` not on loop sandbox** — same shape; T-W.2/T-W.4 ship as code-complete with structural Rust tests; cargo re-verify pending host (PHASE-MANUAL-VERIFY).
3. **DMG notarization for v1.0.1** — operator action (template already lives in `docs/release/DMG-INSTRUCTIONS.md` per Phase 4 T-4.12).

---

## Task Checklist (10 tasks)

- [x] **T-W.1** — Research the install + configure surface and lock the design. Pre-read `docs/spike-memo.md` §"Unknown #1", `experiments/T-0.{1,2,3}/`, `crates/audio-capture/src/`, `src/components/MeetingControls.tsx`. Survey: BlackHole install methods (brew cask vs `.pkg` direct download), `AudioHardwareCreateAggregateDevice` CFDictionary keys, Apple Silicon vs Intel Homebrew prefix split, `coreaudio-rs` crate API surface, Tauri 2 capabilities for subprocess spawn (decision: stay on `core:default`, run subprocesses Rust-side). Write `docs/blackhole-wizard-design.md` (1 page covering: detection layer ladder, install path tree, configure CFDictionary blueprint, wizard state machine, permission UX inventory). Write `docs/tasks/blackhole-wizard/T-W.1-design.md` + `T-W.1-review.md`. **AC:** four files committed (this INDEX, design doc, task spec, review); design doc cross-references spike-memo + experiments by line number; task list ×10 declared with one-line AC each; risk register with ≥ 5 entries; permission UX inventory enumerates ≥ 3 prompt sources (Microphone TCC, brew sudo, default-output change confirm). **Dep:** none. **Risk:** Apple changes the AudioHardware* API surface in a future macOS release — mitigated by pinning to public macOS 13+ APIs only and a fallback `osascript`-Audio MIDI Setup UI-script path documented for emergencies (NOT shipped). **Files touched:** `docs/tasks/blackhole-wizard/INDEX.md`, `docs/tasks/blackhole-wizard/T-W.1-design.md`, `docs/tasks/blackhole-wizard/T-W.1-review.md`, `docs/blackhole-wizard-design.md`. **Diff size:** ~600–900 LOC of markdown only.

- [x] **T-W.2** — _Landed: 8 unit tests defined (6 INDEX-mandated + 2 idempotency/boundary sentinels); FFI body in `RealCoreAudioProbe::enumerate_devices/_aggregates` deferred to T-W.4 per design §3 (shared `cfStringForProperty` helper); macOS-gated CoreAudio FFI deps added to `Cargo.toml`; cross-platform `cargo check` compatibility preserved._  Detection module: `crates/audio-capture/src/blackhole.rs` (NEW) exporting `pub fn detect_blackhole() -> BlackHoleStatus` returning a 4-variant enum: `NotInstalled` (no HAL plug-in + no CoreAudio device), `InstalledNotConfigured` (device present, no Multi-Output containing it), `Configured` (Multi-Output exists, includes BlackHole UID), `Verified` (capture smoke test peak > 0.001). Helpers: `enumerate_devices() -> Vec<DeviceInfo>`, `find_blackhole(devices) -> Option<DeviceInfo>`, `find_multi_output_with_blackhole(devices, bh_uid) -> Option<DeviceInfo>`. Mirror the Swift logic in `experiments/T-0.2/blackhole_capture.swift` lines 98–154 verbatim. **AC:** 6 unit tests (`#[test]` in the same file): `not_installed_when_neither_hal_nor_device`, `installed_when_hal_present_but_not_in_device_list` (transient HAL load), `configured_when_multi_output_includes_bh_uid`, `find_blackhole_matches_name_case_insensitive`, `find_blackhole_matches_uid_prefix`, `find_multi_output_rejects_aggregate_without_bh`. All tests use a `MockCoreAudio` trait (4-method seam: `device_ids`, `device_uid`, `device_name`, `aggregate_subdevice_uids`) so no real CoreAudio calls fire under `cargo test`. **Dep:** T-W.1. **Risk:** `kAudioAggregateDeviceSubDeviceListKey` returns `CFArray<CFDictionary>`, not `CFArray<CFString>` — each dict has a `kAudioSubDeviceUIDKey`. Test `find_multi_output_with_blackhole` covers the dict-unwrap. **Files touched:** `crates/audio-capture/src/blackhole.rs` (NEW), `crates/audio-capture/src/lib.rs` (`pub mod blackhole;`), `crates/audio-capture/Cargo.toml` (+`coreaudio-rs ^0.11` + `core-foundation ^0.9`). **Diff size:** ~300–450 LOC.

- [ ] **T-W.3** — Auto-install helper: `crates/helper-daemon/src/setup_install.rs` (NEW) exposing `pub fn install_via_brew() -> Result<InstallReport, InstallError>` and `pub fn build_manual_install_url() -> &'static str`. Brew path: shell out to `which brew` → if `/opt/homebrew/bin/brew` (Apple Silicon) or `/usr/local/bin/brew` (Intel) found, run `brew install --cask blackhole-2ch` via `std::process::Command`. Stream stdout / stderr to a `tokio::sync::mpsc` channel for the UI. Manual path: returns `https://existential.audio/blackhole/` (the official .pkg landing page; coupon is permanent). **AC:** 5 unit tests using a `BrewProbe` trait seam: `brew_detected_apple_silicon_prefix`, `brew_detected_intel_prefix`, `brew_not_found_returns_manual_url`, `install_command_argv_array_form_no_shell` (assert `["brew", "install", "--cask", "blackhole-2ch"]` array passed to `Command`, not a shell string), `install_aborted_when_brew_exit_nonzero_surfaces_stderr`. **Dep:** T-W.2 (install caller polls detect to know when to stop). **Risk:** Homebrew prompts for sudo via `osascript` admin dialog; the dialog appears outside Tauri's window. Documented in T-W.1 design §"Permission UX" inventory; wizard step renders `"You may see a macOS password prompt — that's Homebrew installing the .pkg."`. **Files touched:** `crates/helper-daemon/src/setup_install.rs` (NEW), `crates/helper-daemon/src/lib.rs` (re-export), `crates/helper-daemon/Cargo.toml` (+`tokio` mpsc feature already present). **Diff size:** ~250–400 LOC.

- [ ] **T-W.4** — CoreAudio Multi-Output configurator: `crates/audio-capture/src/multi_output.rs` (NEW) exposing `pub fn create_multi_output(name: &str, sub_device_uids: &[&str]) -> Result<AudioDeviceID, ConfigureError>`. Build a CFDictionary with keys `kAudioAggregateDeviceUIDKey="MeetingCopilotMultiOut"`, `kAudioAggregateDeviceNameKey=name`, `kAudioAggregateDeviceMasterSubDeviceKey=<built-in-output-uid>`, `kAudioAggregateDeviceSubDeviceListKey=[{uid: bh}, {uid: built-in}]`, `kAudioAggregateDeviceIsStackedKey=1` (1 = Multi-Output, 0 = Aggregate). Call `AudioHardwareCreateAggregateDevice(dict, &mut id)`. Idempotent: if a device with the same UID already exists, return its ID (no recreate). **AC:** 5 unit tests: `creates_multi_output_with_correct_keys` (mock `AudioHardwareCreateAggregateDevice` records the dict and asserts key set), `idempotent_returns_existing_device_id_when_uid_match`, `rejects_when_blackhole_uid_missing_from_sub_devices`, `is_stacked_key_is_1_for_multi_output_not_0` (regression guard — 0 creates a regular Aggregate which routes input not output), `master_sub_device_defaults_to_built_in_output`. **Dep:** T-W.2. **Risk:** Aggregate Device is *transient* — gone after reboot. Mitigation: T-W.7 (startup integration) re-runs detect → recreate if missing. Documented in T-W.8 SETUP.md "FAQ" section. Plus: `kAudioAggregateDeviceIsStackedKey` literal `1` vs `0` is the difference between Multi-Output and Aggregate; mistake = silence. Test #4 is BLOCKING. **Files touched:** `crates/audio-capture/src/multi_output.rs` (NEW), `crates/audio-capture/src/lib.rs` (`pub mod multi_output;`), no new crate deps (`coreaudio-rs` from T-W.2 already covers CFDictionary). **Diff size:** ~300–500 LOC.

- [ ] **T-W.5** — Verify capture smoke test: `crates/audio-capture/src/verify.rs` (NEW) exposing `pub fn verify_capture(device_id: AudioDeviceID, duration_ms: u64) -> Result<VerifyReport, VerifyError>`. Open a 5s capture from the supplied device using the existing `cpal` plumbing (`build_input_stream` with the BlackHole device), measure peak amplitude, return `{peak_amplitude, signal_present: peak > 0.001, duration_ms_actual, callback_count}`. Mirrors `experiments/T-0.2/blackhole_capture.swift` lines 293–377 (peak + tap loop). **AC:** 4 unit tests with `MockAudioStream` seam (returns synthesized PCM): `verify_passes_when_peak_above_threshold`, `verify_fails_when_silent` (peak ≤ 1e-4 → `signal_present=false`, error path = `BlackHolePresentButSilent` mirrored from spike exit code 8), `verify_times_out_when_zero_callbacks_in_5s` (TCC `.notDetermined` shape), `verify_returns_callback_count_for_telemetry`. **Dep:** T-W.4. **Risk:** TCC microphone permission propagates per-process; the verify call from helper-daemon may fire the modal a second time even after the user granted earlier. Documented in T-W.1 design §"Permission UX". **Files touched:** `crates/audio-capture/src/verify.rs` (NEW), `crates/audio-capture/src/lib.rs` (`pub mod verify;`), reuses `cpal` already in Cargo.toml. **Diff size:** ~300–450 LOC.

- [ ] **T-W.6** — Onboarding wizard UI: `src/components/SetupWizard/SetupWizard.tsx` (5-step React FSM) + `src/components/SetupWizard/{Welcome,Detect,Install,Configure,Verify}.tsx` + 1 hook `src/components/SetupWizard/useSetupWizard.ts`. State machine: `welcome → detect → (skip if all-green) → install → configure → verify → done`. Each step renders a card with: title, body copy, primary action button, "Skip / Quit wizard" link, error pane. The Tauri commands (T-W.7 wires them) are called via a single `invoke<>(...)` per step. **AC:** 12 RTL component tests (3 per step minimum): welcome renders + Continue advances state, detect shows pending → success transitions, detect found-everything jumps to verify, install brew-progress streams stdout lines, install brew-not-found shows manual URL link with `target="_blank" rel="noopener"`, configure shows 1 button + click invokes correct Tauri command name, verify shows peak meter (mocked), verify silent → retry button, retry returns to detect step, full happy path mock advances 5 → done state, quit-wizard sets `setupCompleted=true` regardless (escape hatch), error in any step renders error pane without crashing the FSM. State machine modeled with `useReducer` (not `useState`) — the test asserts the reducer's state transitions in isolation. **Dep:** T-W.5 (verify step needs the verify Tauri command's response shape). **Risk:** Modal overlay accidentally captures keyboard from the main app — mitigated by `aria-modal="true"` + focus-trap pattern from existing `SettingsSheet.tsx` Phase 2. **Files touched:** `src/components/SetupWizard/{SetupWizard,Welcome,Detect,Install,Configure,Verify}.tsx` (NEW × 6), `src/components/SetupWizard/useSetupWizard.ts` (NEW), `src/components/SetupWizard/*.test.tsx` (NEW × 6). **Diff size:** ~700–1000 LOC.

- [ ] **T-W.7** — App-startup integration: `src/App.tsx` reads `settingsStore.setupCompleted`; if `false`, mount `<SetupWizard onDone={() => setSetupCompleted(true)} />` as a modal overlay before rendering the existing main UI. `src-tauri/src/lib.rs` adds 4 `#[tauri::command]`: `setup_detect_blackhole`, `setup_install_blackhole`, `setup_configure_multi_output`, `setup_verify_capture` — each delegates to the matching Rust function from T-W.2/T-W.3/T-W.4/T-W.5. **AC:** 4 RTL integration tests: `app_renders_wizard_when_setup_incomplete`, `app_skips_wizard_when_setup_completed_true`, `app_persists_setup_completed_to_settings_store_after_done`, `re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui` (idempotent re-run). Plus 4 cargo unit tests for the Tauri-command wrappers (each just delegates — assert dispatch shape). **Dep:** T-W.6. **Risk:** Wizard fires on every cold-start until `setupCompleted=true` is persisted; if persist fails (disk full, permission), wizard re-prompts forever — mitigated by surfacing the persist error to the user in the verify step's "Done" panel. **Files touched:** `src/App.tsx` (+conditional render), `src/store/settingsStore.ts` (+`setupCompleted` field with `coerceLoaded` zero-fill), `src-tauri/src/lib.rs` (+4 commands), `src/App.test.tsx` (+4 tests), `src-tauri/src/lib.rs` (+4 `#[test]`). **Diff size:** ~400–600 LOC.

- [ ] **T-W.8** — End-user docs: `docs/SETUP.md` (NEW) with screenshot stubs (filenames declared; image capture deferred to operator-side host) + step-by-step manual fallback (when wizard fails). Sections: 1) Why BlackHole, 2) Auto-install via wizard, 3) Manual install (Homebrew + .pkg), 4) Manual Multi-Output Device creation in Audio MIDI Setup, 5) Verifying audio routing, 6) Troubleshooting (5 common failures from spike-memo §"Risks #3"). Cross-link from `README.md` "Quickstart" line 27 (currently `brew install blackhole-2ch`) to point at `docs/SETUP.md`. **AC:** doc renders valid markdown (no broken anchors); README updated to link to SETUP; troubleshooting section enumerates ≥ 5 failure modes; manual-fallback steps reproduce the wizard's outcome (verified by hand-trace against T-W.2 + T-W.4 logic). **Dep:** T-W.7 (docs reflect tested behavior, not aspirations). **Risk:** Doc drift if T-W.<N> review docs differ from final landed code — mitigated by writing T-W.8 LATE in the sequence. **Files touched:** `docs/SETUP.md` (NEW), `README.md` (+1 link). **Diff size:** ~250–400 LOC of markdown.

- [ ] **T-W.9** — Fresh-Mac E2E simulation: `tests/e2e/blackhole-wizard.e2e.test.ts` mocks all 4 Tauri commands (detect / install / configure / verify) + a fixture sequence simulating fresh Mac → installed → configured → verified. Assert wizard reaches "All set" panel after walking the 5 steps with deterministic mock responses; assert 3/3 deterministic runs (no flake budget). Plus 2 error paths: brew-not-found → manual URL link rendered, verify-silent → retry loop bounded to 3 attempts then surfaces error. **AC:** test passes 3/3 consecutive runs; mocks adhere to the Tauri-command response Zod schemas defined in T-W.7; no real CoreAudio / brew calls fire (verified by spy assertions). **Dep:** T-W.7. **Risk:** Wall-clock flake (real timers in retry loop) — mitigated by `vi.useFakeTimers()` per existing Phase 4 e2e pattern. **Files touched:** `tests/e2e/blackhole-wizard.e2e.test.ts` (NEW), `tests/e2e/__fixtures__/wizard-states.ts` (NEW). **Diff size:** ~350–500 LOC.

- [ ] **T-W.10** — Phase test + sign-off + v1.0.1 tag: full `bun test` + `cargo test --workspace` regression sweep; write `docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY.md` (12-step host re-verify procedure parallel to Phase 4's PHASE-BROWSER-TEST.md); write `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` sign-off table. Bump `package.json#version` 1.0.0 → 1.0.1, `Cargo.toml` workspace where versioned, `src-tauri/tauri.conf.json` `version`. Create local annotated tag `v1.0.1` referencing PHASE-COMPLETE by relative path. Append a Phase-W block to `docs/RELEASE-NOTES-v1.0.0.md` OR create new `docs/RELEASE-NOTES-v1.0.1.md`. **NO `git push`**. **AC:** tag `git tag -l v1.0.1` non-empty; sign-off doc has all 10 checkboxes ticked; PHASE-MANUAL-VERIFY enumerates 12 steps; release notes render valid markdown. **Dep:** T-W.9. **Risk:** Premature tag — same as Phase 4 R-4.12-1; mitigation = sign-off MUST land before tag. **Files touched:** `package.json`, `src-tauri/Cargo.toml`, `crates/*/Cargo.toml` (where bumped), `src-tauri/tauri.conf.json`, `docs/RELEASE-NOTES-v1.0.1.md` (NEW), `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` (NEW), `docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY.md` (NEW). **Diff size:** ~250–400 LOC of markdown + version bumps.

---

## Dependency Graph (ASCII)

```
       ┌────────────────────────────────────────────────────────────────┐
       │  Phase 0–4 carry-forward (NOT re-implemented):                 │
       │   experiments/T-0.2/blackhole_capture.swift (Swift blueprint)  │
       │   crates/audio-capture/* (cpal mic source — REUSED at T-W.5)   │
       │   crates/helper-daemon/* (Tauri command pattern — T-W.3/W.7)   │
       │   src/store/settingsStore (coerceLoaded zero-fill — T-W.7)     │
       │   src/components/SettingsSheet (focus-trap pattern — T-W.6)    │
       └──────┬─────────────────────────────────────────────────────────┘
              ▼
        ┌──────────┐
        │  T-W.1   │  Research + design + INDEX (this loop step)
        └────┬─────┘
             ▼
        ┌──────────┐
        │  T-W.2   │  Detection module (4-variant BlackHoleStatus enum)
        └────┬─────┘
             ▼
        ┌──────────┐  ┌──────────┐
        │  T-W.3   │  │  T-W.4   │  Configure (CFDictionary +
        │          │  │          │   AudioHardwareCreateAggregateDevice)
        │  Install │  └────┬─────┘
        │  helper  │       │
        └────┬─────┘       │
             └─────┬───────┘
                   ▼
              ┌──────────┐
              │  T-W.5   │  Verify capture smoke test
              └────┬─────┘
                   ▼
              ┌──────────┐
              │  T-W.6   │  Wizard UI (5-step FSM, useReducer)
              └────┬─────┘
                   ▼
              ┌──────────┐
              │  T-W.7   │  App-startup integration + Tauri commands
              └────┬─────┘
                   ▼
              ┌──────────┐
              │  T-W.8   │  docs/SETUP.md end-user guide
              └────┬─────┘
                   ▼
              ┌──────────┐
              │  T-W.9   │  Fresh-Mac E2E simulation
              └────┬─────┘
                   ▼
              ┌──────────┐
              │  T-W.10  │  Phase test + sign-off + v1.0.1 tag
              └──────────┘
```

Critical path: **T-W.1 → T-W.2 → T-W.3/T-W.4 (parallel after T-W.2) → T-W.5 → T-W.6 → T-W.7 → T-W.8 → T-W.9 → T-W.10** (10 hops). T-W.3 and T-W.4 are independent post-T-W.2 (install vs configure are separate Rust modules + tests).

Cross-phase explicit dependencies:

| New work | Depends on prior phase |
|---|---|
| T-W.2 detection enum mirroring | Phase 0 T-0.2 spike (`experiments/T-0.2/blackhole_capture.swift` exit codes) |
| T-W.5 verify capture | Phase 1 T-1.3 `cpal` mic source (re-uses `build_input_stream`) |
| T-W.6 wizard FSM | Phase 2 `SettingsSheet.tsx` focus-trap + modal pattern |
| T-W.7 Tauri command surface | Phase 4 T-4.4 `commands::start_from_deeplink` dispatch shape |
| T-W.10 release notes + tag | Phase 4 T-4.12 `RELEASE-NOTES-v1.0.0.md` + `DMG-INSTRUCTIONS.md` template |

---

## TDD per task

| Task | Harness | Notes |
|---|---|---|
| T-W.1 | Doc-only review (markdown manual cross-ref against spike-memo + experiments) | No code; AC = design doc + INDEX accurate cross-references |
| T-W.2 | `cargo test` with `MockCoreAudio` trait seam (4 methods) | Zero real CoreAudio calls under test |
| T-W.3 | `cargo test` with `BrewProbe` trait + `MockProcess` | Argv array form asserted (no shell string) |
| T-W.4 | `cargo test` mock `AudioHardwareCreateAggregateDevice` | `is_stacked=1` regression guard test BLOCKING |
| T-W.5 | `cargo test` `MockAudioStream` returning synthesized PCM | TCC timeout case covered |
| T-W.6 | Vitest + RTL on each step component + reducer-isolation tests | 12 cases; modal escape-hatch covered |
| T-W.7 | Vitest RTL App-level + cargo `#[test]` for command wrappers | Integration; persist-fail surfaces to user |
| T-W.8 | Doc-only review + markdown link audit | No code; AC = docs match landed behavior |
| T-W.9 | Vitest e2e mocking all 4 Tauri commands + fake timers for retry loop | 3/3 deterministic; no flake |
| T-W.10 | Manual verify (`git tag -l v1.0.1`) + markdown link audit + full bun + cargo regression sweep | No code beyond version bumps |

---

## Acceptance Criteria Summary

| Task | Numeric AC |
|---|---|
| T-W.1 | 4 doc files committed (INDEX + design + T-W.1 spec + review); spike-memo + experiments cross-refs by line number; ≥ 5 risk register entries; ≥ 3 permission-prompt sources enumerated |
| T-W.2 | 6 unit tests green; mock trait covers all 4 CoreAudio call shapes; no real `AudioObject*` invocations |
| T-W.3 | 5 unit tests green; argv array-form assertion; brew-not-found returns documented manual URL |
| T-W.4 | 5 unit tests green; idempotent re-run returns existing device ID; `kAudioAggregateDeviceIsStackedKey=1` regression guard |
| T-W.5 | 4 unit tests green; silent-capture path returns typed `BlackHolePresentButSilent` mirroring Swift exit 8 |
| T-W.6 | 12 RTL tests green; useReducer state transitions tested in isolation; quit-wizard escape hatch sets `setupCompleted=true` |
| T-W.7 | 4 RTL App-level tests + 4 cargo `#[test]` green; idempotent re-run does not break main UI |
| T-W.8 | Markdown valid; ≥ 5 troubleshooting modes; README link added to SETUP.md |
| T-W.9 | 3/3 deterministic runs of e2e; happy path + 2 error paths green; spy assertions confirm no real CoreAudio / brew calls |
| T-W.10 | `git tag -l v1.0.1` non-empty; PHASE-COMPLETE all checkboxes ticked; full vitest + cargo regression green |

---

## Risk Register (Wizard-specific — top 6)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-W.1 | **CoreAudio Aggregate Device transience** — `AudioHardwareCreateAggregateDevice` creates a non-persistent device; gone after reboot. User boots fresh Mac, walks wizard, reboots, system audio stops working. | High | Medium | T-W.7 startup integration re-runs `detect_blackhole` on every cold-start. If `Configured` regresses to `InstalledNotConfigured`, recreate the Multi-Output silently (idempotent T-W.4 path). T-W.8 SETUP.md FAQ documents the behavior. |
| R-W.2 | **Apple Silicon vs Intel Homebrew prefix split** — `/opt/homebrew/bin/brew` vs `/usr/local/bin/brew`. T-W.3 hardcodes one path → install fails silently on the other architecture. | Medium | High | `BrewProbe` trait in T-W.3 checks both paths AND falls back to `which brew` shell-out; 2 unit tests cover each prefix explicitly. |
| R-W.3 | **`kAudioAggregateDeviceIsStackedKey` Multi-Output vs Aggregate confusion** — `1` = Multi-Output Device (output, what we want); `0` = Aggregate Device (input). Setting wrong value → user hears nothing, transcription gets nothing. CRITICAL silent failure. | Medium | **CRITICAL** | T-W.4 unit test #4 (`is_stacked_key_is_1_for_multi_output_not_0`) is BLOCKING. Doc-comment on `create_multi_output()` enumerates the bit semantics. T-W.5 verify step catches the failure post-creation by detecting silent capture. |
| R-W.4 | **TCC microphone permission re-prompt after every Tauri-command relaunch** — helper-daemon re-spawn loses the in-process TCC token; OS treats each invocation as new request. User sees the modal multiple times. | Medium | Low | Tauri main process owns AVCaptureDevice authorization; helper-daemon delegates capture to the in-process Rust code on the main thread, NOT a fresh subprocess. Documented in T-W.1 design §"Permission UX". |
| R-W.5 | **Brew sudo prompt timing race** — Homebrew shells out to `osascript` admin dialog; if the user clicks "Cancel" instead of typing a password, brew exits non-zero with confusing stderr. Wizard install step appears "frozen" then errors. | High | Medium | T-W.3 streams stderr to the wizard UI in real time; on non-zero exit, surface the manual URL fallback within the same step (no need to restart wizard). |
| R-W.6 | **macOS API drift** — `AudioHardwareCreateAggregateDevice` stays public but `kAudioAggregateDeviceIsStackedKey` could be deprecated in macOS 14+ for a `kAudioMultiOutputDevice*` family. | Low | Medium | T-W.4 pins to macOS 13+ public API only; T-W.10 release notes document tested macOS range; emergency fallback via UI-script of Audio MIDI Setup documented in T-W.1 design but NOT shipped (would require Accessibility TCC which is heavier than Microphone). |

---

## Process Rules (loop-binding — same shape as Phase 4)

1. **Task file per task** — `docs/tasks/blackhole-wizard/T-W.<N>-*.md`. One spec doc + one review doc per task.
2. **TDD strict** — detect/install/configure/verify Rust unit tests with mocked CoreAudio + brew + AVCaptureDevice; UI vitest-RTL component + reducer tests; e2e mocks all Tauri commands.
3. **Code review per task** — `T-W.<N>-review.md` with explicit checkboxes:
   - [ ] No regression Phase 1 / 2 / 3 / 4 (audio capture path unchanged; settings schema additive only)
   - [ ] Permission prompt UX: rationale string visible to user in wizard
   - [ ] Idempotent (re-running wizard after completion does not break existing config)
   - [ ] Rollback if user cancels mid-flow (no half-installed state visible to main app)
   - [ ] No `git push`
4. **Per-task commit** — type `feat(setup)` / `feat(ui)` / `docs` / `test` / `chore`. **No `git push`.**
5. **Phase test + sign-off** — `bun test` + `cargo test --workspace` (no regression); T-W.9 e2e 3/3 pass; `PHASE-COMPLETE.md` + `PHASE-MANUAL-VERIFY.md`; local annotated tag `v1.0.1` (NOT pushed).

Every commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's headline outcome (test count + AC verdict) appears next to the title. Final state must show all 10 boxes ticked before `PHASE-COMPLETE.md` is written and `v1.0.1` tag is cut.
