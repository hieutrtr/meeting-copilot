# BlackHole Setup Wizard — Manual Re-Verification (host with Apple Silicon Mac, fresh state)

> Companion to `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` (v1.0.1 sign-off). Mirrors the Phase 4 `PHASE-BROWSER-TEST.md` structure — twelve numbered steps, each with: setup, action, expected, evidence to capture, fail-action. Operator owns this run; the loop sandbox cannot execute it (no Rust toolchain, no CoreAudio, no real Homebrew).

## Pre-conditions

- macOS 13+ (matches the design doc API floor — `kAudioAggregateDeviceIsStackedKey` and friends are public ≥ Ventura).
- Apple Silicon **or** Intel Mac. The brew probe ladder asserts both prefixes (`/opt/homebrew/bin/brew`, `/usr/local/bin/brew`); flag the verifier's CPU here so the prefix branch is recorded.
- Rust toolchain installed: `rustup default stable` + `cargo --version` ≥ 1.77 (matches the workspace `rust-version` floor). Carry-forward C-C from Phase 0; same shape as Phase 4 P-1.
- Homebrew available **OR** explicit decision to walk the manual `.pkg` fallback (step 4 branches accordingly). Neither is required to run steps 1–3 + 7–12.
- BlackHole **NOT** installed at session start. If you've installed it before, run `brew uninstall --cask blackhole-2ch` and remove any `MeetingCopilotMultiOut` entry in **Audio MIDI Setup → Multi-Output Device** before starting. Aggregate Devices vanish at reboot per design doc §"Configure CFDictionary blueprint" Risk row, so a clean reboot is the simplest reset.
- `~/Library/Application Support/Meeting Copilot/settings.json` either does not exist or has `setupCompleted` absent / `false`. Delete the file to force a wizard cold-start.
- Notarized v1.0.1 `.dmg` per the carry-forward `docs/release/DMG-INSTRUCTIONS.md` checklist (Phase 4 T-4.12). If the operator runs the wizard from a `bun tauri dev` build instead, document that in the run log — DMG signing UX (right-click → Open on first run) is part of step 1's evidence pack.

## P-1 — `cargo test --workspace` deferred green-bar (carry-forward C-C)

**Setup:** Repo at the v1.0.1 tag; `rustup default stable`; cwd = repo root.

**Action:**

```bash
cargo test --workspace 2>&1 | tee /tmp/v1.0.1-cargo-test.log
```

**Expected:** All structural tests across `src-tauri`, `helper-daemon`, `audio-capture`, `stt-mlx` pass. Net new for the wizard: `crates/audio-capture/src/blackhole.rs` 8 unit tests (T-W.2), `crates/audio-capture/src/multi_output.rs` 9 unit tests (T-W.4), `crates/helper-daemon/src/setup_install.rs` 7 unit tests (T-W.3). All `MockCoreAudio` / `BrewProbe` / mock-`AggregateDeviceCreator` seam-only — no real CoreAudio or brew calls fire.

**Evidence:** Last 30 lines of `/tmp/v1.0.1-cargo-test.log` showing `test result: ok. N passed; 0 failed; 0 ignored` for each of the four crates.

**Fail-action:** File a `v1.0.1.x` ticket; do **not** sign off until structural cargo regression is fixed. The vitest baseline (934 / 934 across 60 files) already lives in `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` §"Test tally"; mismatched expectations land here.

## P-2 — Vitest re-run snapshot (host parity)

**Setup:** Same as P-1.

**Action:**

```bash
bun install --frozen-lockfile
bun run test 2>&1 | tee /tmp/v1.0.1-bun-test.log
bun run typecheck
```

**Expected:** `Test Files 60 passed (60) / Tests 934 passed (934)` (matches the loop-sandbox tally captured at PHASE-COMPLETE sign-off time). `tsc --noEmit` exits 0.

**Evidence:** Tail of `/tmp/v1.0.1-bun-test.log`; `echo $?` after `bun run typecheck`.

**Fail-action:** Reproduce on a second host before filing — `vitest` setup-file paths are absolute on the loop sandbox, may differ on the operator host. If a real regression, file `v1.0.1.x` and do not sign off.

## 1 — Cold install + first launch (DMG path)

**Setup:** Mount `Meeting Copilot-1.0.1.dmg` from the notarized artifact bundle; drag to `/Applications`. First launch via right-click → **Open** to clear quarantine.

**Action:** Double-click `/Applications/Meeting Copilot.app`. Observe the first window.

**Expected:** Wizard's **Welcome** card renders within ≤ 1.5 s (matches T-W.6 "App-startup integration" R-W.1 timing budget). Title reads "Set up audio routing"; body explains BlackHole + Multi-Output in one paragraph; primary button says **Continue**; secondary link says **Skip / Quit wizard** (escape hatch — SW-U11 / SW-U11b regression coverage).

**Evidence:** Screenshot `01-welcome-card.png`. Place under `docs/screenshots/setup/` (the inventory in `docs/SETUP.md` §9 already names this stub).

**Fail-action:** If the main UI renders instead of the wizard, `setupCompleted` is leaking from a prior run — wipe `~/Library/Application Support/Meeting Copilot/settings.json` and relaunch. If the wizard still doesn't fire, T-W.7 `App.tsx` conditional-render is broken — file a Sev-1 against this gate.

## 2 — Detect step (fresh state → "not_installed")

**Setup:** Continuing from step 1.

**Action:** Click **Continue**. Observe the **Detect** card.

**Expected:** Spinner ≤ 800 ms; result card shows the four-variant `BlackHoleStatus` rendering with the **NotInstalled** branch highlighted. Body copy explains: "BlackHole 2-channel virtual audio device is not installed yet." Primary button says **Install BlackHole**; secondary link **Skip / Quit wizard** still visible.

**Evidence:** Screenshot `02-detect-not-installed.png`. Optional: `console.log` from devtools (Cmd-Option-I) capturing the `setup_detect_blackhole` Tauri command response payload — should be `{status: "NotInstalled"}`.

**Fail-action:** If the response shape differs (e.g. `installed_not_configured` even though the device isn't there), the `MockCoreAudio` → `RealCoreAudioProbe` swap in T-W.7 is broken. File against T-W.7 cargo command wrappers.

## 3 — Install step — Homebrew happy path

**Setup:** Continuing from step 2; verifier has Homebrew.

**Action:** Click **Install BlackHole**. Watch the streaming stdout pane.

**Expected:** Within ≤ 2 s, a macOS **password prompt** appears (Homebrew's `osascript` admin dialog — design doc §"Permission UX" inventory row 2 — wizard's pre-prompt blurb above the live log says: _"You may see a macOS password prompt — that's Homebrew installing the .pkg."_). Type your sudo password. Live log streams `==> Downloading https://github.com/ExistentialAudio/BlackHole/...`, `==> Installing Cask blackhole-2ch`, `==> Running installer for blackhole-2ch...`, `🍺 blackhole-2ch was successfully installed!` lines. On exit-0, primary button flips from **Installing…** (disabled) to **Configure Multi-Output Device** (enabled).

**Evidence:** Screenshot `03a-brew-prompt.png` (modal sudo dialog), `03b-install-streaming-log.png` (mid-install with `==> Downloading` visible), `03c-install-complete.png` (post-success with green check + new primary button). Save `~/.bash_history` or shell history excerpt if you want a separate audit trail.

**Fail-action:** If Homebrew exits non-zero (sudo cancelled, network down), the wizard should surface stderr in-place AND show a **manual download link** to `https://existential.audio/blackhole/` — same step, no restart. Verify the link has `target="_blank" rel="noopener noreferrer"` (SW-U6 regression). If brew exits 0 but the device doesn't appear in the next step's enumeration (race), reboot and retry — known design-doc transient.

### 3-alt — Install step — manual `.pkg` fallback (Homebrew absent)

**Setup:** On a Mac without Homebrew (or simulate by `which brew` returning empty in a fresh shell). Re-launch the app.

**Action:** Click **Install BlackHole**.

**Expected:** No streaming log. Card shows **"Homebrew was not found on this Mac."** + a button **Open download page** that opens `https://existential.audio/blackhole/` in the default browser. After manual `.pkg` install + relaunch (the `.pkg` requires admin and sometimes triggers a logout), step 2 (Detect) re-runs and reports **InstalledNotConfigured**.

**Evidence:** Screenshot `03d-brew-not-found.png`; archived `Pkg installer log` from `/var/log/install.log` if you want to thread the operator-side audit.

**Fail-action:** If the **Open download page** anchor doesn't open in the system browser, the `target="_blank"` fallback regressed — file against T-W.6 SW-U6.

## 4 — Configure step — `MeetingCopilotMultiOut` creation

**Setup:** Continuing from step 3 (or 3-alt); BlackHole is now installed; Detect re-confirms **InstalledNotConfigured**.

**Action:** Click **Configure Multi-Output Device**. Wait ≤ 2 s.

**Expected:** The wizard's `setup_configure_multi_output` command calls `AudioHardwareCreateAggregateDevice` with the CFDictionary from design doc §"Configure CFDictionary blueprint" — the `kAudioAggregateDeviceIsStackedKey = 1` row is the BLOCKING regression-guard from T-W.4 unit test #4. Card flips to a green check + body **"Multi-Output Device created"**. Primary button shifts to **Verify capture**.

**Evidence:** Screenshot `04a-configure-success.png`. Open **Audio MIDI Setup** (`/Applications/Utilities/Audio MIDI Setup.app`) in a separate window — confirm a new device named `MeetingCopilotMultiOut` exists in the left sidebar with `Drift Correction` ticked next to **BlackHole 2ch** and the right pane shows "Use This Device For Sound Output" checked. Screenshot this as `04b-audio-midi-setup-multi-out.png`.

**Fail-action:** If the device exists but `IsStacked = 0` (regular Aggregate, not Multi-Output), the FFI deferred body in `RealAggregateDeviceCreator::create` (per `multi_output.rs:153` deferred-FFI note) was finished incorrectly. File a Sev-1 — silent audio is the failure mode.

## 5 — Verify step — happy path (peak > 0.001)

**Setup:** Continuing from step 4. Open Spotify or any system-audio source and start playback at moderate volume.

**Action:** Click **Verify capture**. Wait 5 s (matches the spike's tap loop window).

**Expected:** Live peak meter rises with the audio. After 5 s, card flips to **"All set"** with `peak_amplitude` displayed (e.g. 0.18) and `signal_present: true`. Primary button: **Done**.

**Evidence:** Screenshot `05a-verify-running.png` (mid-meter), `05b-verify-success.png` (final). Optional: paste the `setup_verify_capture` JSON return into a file `/tmp/verify-report.json` for the audit pack.

**Fail-action:** If `signal_present: false` despite audio playing, you're hitting the `BlackHolePresentButSilent` shape (Swift exit code 8 mirrored). Common cause: Multi-Output is not the system Output — go to **System Settings → Sound → Output** and select `MeetingCopilotMultiOut`. If still silent after that, file against T-W.5 verify path.

## 6 — Verify step — silent path → retry

**Setup:** Re-trigger the wizard (open **Settings** or delete `setupCompleted` and relaunch). Walk steps 1–4. Before step 5: **mute** all system audio sources (or unplug speakers).

**Action:** Click **Verify capture**.

**Expected:** After 5 s, card shows **"No signal detected."** + body explaining "Make sure audio is playing through the Multi-Output Device." + primary button **Try again**, secondary link **Skip / Quit**. Click **Try again** with audio re-enabled — verify-success shape from step 5 reappears.

**Evidence:** Screenshot `06a-verify-silent.png`, `06b-verify-retry-success.png`.

**Fail-action:** If **Try again** lands on a different step (e.g. Configure), the FSM's retry transition is broken — file against T-W.6 SW-U10.

## 7 — Skip / Quit escape hatch

**Setup:** Re-trigger the wizard with a fresh state.

**Action:** From the **Welcome** card, click **Skip / Quit wizard**. Confirm any modal that appears.

**Expected:** Wizard dismisses; main UI renders; `setupCompleted` flips to `true` (one-time flip, even though the user skipped) — re-launching the app does **not** re-show the wizard. This matches the SW-U11 regression coverage.

**Evidence:** Screenshot `07-main-ui-after-skip.png`. Inspect `~/Library/Application Support/Meeting Copilot/settings.json` and confirm `"setupCompleted": true`.

**Fail-action:** If the wizard re-fires on the next launch, the `coerceLoaded` zero-fill in `settingsStore.ts` regressed (Phase 2 carry-forward) or the `onDone` plumbing in T-W.7 is not flipping `setupCompleted`. File against T-W.7.

## 8 — Re-run wizard from Settings (idempotent)

**Setup:** With `setupCompleted: true`, BlackHole installed, and `MeetingCopilotMultiOut` already configured.

**Action:** Open **Settings → Audio routing → Re-run setup wizard**. Walk all 5 steps.

**Expected:** **Detect** step short-circuits to **Configured** (already-configured branch, per `SetupWizard.tsx` `nextStepForDetect` short-circuit logic — SW-U7). The wizard jumps directly from Detect → Verify (skipping Install + Configure). Verify still requires a live capture and ends on **All set**. Idempotent: no second `MeetingCopilotMultiOut` created (T-W.4 unit test `idempotent_returns_existing_device_id_when_uid_match`).

**Evidence:** Screenshot `08a-detect-configured-shortcircuit.png`. Re-open **Audio MIDI Setup** and confirm exactly **one** `MeetingCopilotMultiOut` device exists (no `MeetingCopilotMultiOut 2`).

**Fail-action:** If a second device was created, the idempotency check in `multi_output.rs` regressed. File a Sev-1 — every re-run leaks a device otherwise.

## 9 — Reboot transient — Aggregate Device gone, wizard re-creates

**Setup:** Walk through to **All set** once. **Reboot** the Mac.

**Action:** Re-launch Meeting Copilot.

**Expected:** App detects `MeetingCopilotMultiOut` is missing (Aggregate Devices are transient — design doc §"Configure CFDictionary blueprint" Risk row + T-W.4 review). The wizard either (a) silently re-creates the Multi-Output behind the scenes on first detect, or (b) re-renders the Configure step alone (skipping Welcome / Detect). Either UX is acceptable — document which one your build does in the run log.

**Evidence:** Screenshot `09-post-reboot.png`. Confirm `MeetingCopilotMultiOut` is back in **Audio MIDI Setup** without you touching it.

**Fail-action:** If the device is **not** re-created and the user has to walk Install + Configure again, T-W.7's startup integration didn't wire the post-reboot detect → configure path. File against T-W.7.

## 10 — TCC microphone permission re-prompt

**Setup:** Use a Mac that has **never granted Microphone access** to Meeting Copilot. (On a host that already granted, revoke via **System Settings → Privacy & Security → Microphone** and toggle off, then quit + relaunch.)

**Action:** Walk to step 5 (Verify) and click **Verify capture**.

**Expected:** macOS modal **"Meeting Copilot would like to access the Microphone"** fires once. Click **Allow**. Verify proceeds normally. Note: the modal may fire a **second** time even after granting earlier (per design doc §"Permission UX" Risk row R-W.6 — TCC permission propagates per-process, and the helper daemon is a different process from the UI).

**Evidence:** Screenshot `10-tcc-modal.png`.

**Fail-action:** If **Verify capture** fails with `verify_times_out_when_zero_callbacks_in_5s` (Swift exit code 6 mirrored — `tcc_not_authorized`), the user clicked **Don't Allow**. The wizard should surface a typed error explaining how to re-enable in System Settings. If it crashes instead, file against T-W.5.

## 11 — Cross-build smoke (Apple Silicon ↔ Intel parity)

**Setup:** Run steps 1–8 on **both** an Apple Silicon Mac and an Intel Mac (or at minimum: confirm a colleague has run on the other arch and recorded results).

**Expected:** Brew probe ladder picks `/opt/homebrew/bin/brew` on Apple Silicon and `/usr/local/bin/brew` on Intel. Both arms ship per T-W.3 unit tests `brew_detected_apple_silicon_prefix` / `brew_detected_intel_prefix`.

**Evidence:** Two run logs; cross-link in the v1.0.1 release ticket. If only one arch is available, document the other as **deferred** and roll a v1.0.1.1 patch after the second-arch verifier signs off.

**Fail-action:** If the Intel arm fails (most likely — MAS-only loop developers are usually on Apple Silicon), file a v1.0.1.x with logs.

## 12 — Phase 1–4 regression sweep — main UI unchanged

**Setup:** With `setupCompleted: true`, walk a full meeting end-to-end: pick a context folder, click **Start meeting**, speak / play audio for ≥ 30 s, click **Stop meeting**, and request a summary via the existing flow.

**Expected:** Zero regression versus Phase 4. Transcript chunks land in real time; **Ask Claude** answers; `bridge_meeting_export` from a separate `claude-bridge dispatch` produces valid markdown. The wizard mount is fully removed from the render tree (no wasted memoization).

**Evidence:** Reuse the relevant subset of `docs/tasks/phase-4/PHASE-BROWSER-TEST.md` items 4–12 as your evidence pack — the wizard delta is **additive only**.

**Fail-action:** Any Phase 1–4 break is an automatic Sev-1 — the wizard is a v1.0.1 add, not a refactor. Roll back the v1.0.1 tag, file against the offending T-W.<N>, fix, retag.

---

## Sign-off

When all 12 steps + P-1 + P-2 are green:

```bash
echo "Operator: <name>" >> docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY-RUNS.md
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY-RUNS.md
echo "Host arch: <apple-silicon|intel>" >> docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY-RUNS.md
echo "Result: PASS" >> docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY-RUNS.md
echo "" >> docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY-RUNS.md
```

The runs file does **not** exist at sign-off — the operator creates it on first verified host. Each verifier appends one block. v1.0.1 ships as **CODE-COMPLETE-PENDING-HOST-VERIFY** until the first PASS lands.
