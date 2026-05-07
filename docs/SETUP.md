# Meeting Copilot — Setup Guide (BlackHole + System Audio)

> Audience: end users on macOS Apple Silicon / Intel installing Meeting Copilot v1.0.1+ for the first time.
> Companion docs: [`README.md`](../README.md) (Quickstart) · [`docs/PRD.md`](PRD.md) · [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §2 (Audio pipeline) · [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md) (engineering memo).
> Version: aligns with `package.json#version` v1.0.1 (BlackHole Setup Wizard ships in this release).

---

## Why this guide exists

Meeting Copilot listens to **two audio streams**: your microphone (you talking) and your **system audio** (other meeting participants speaking through your speakers / headphones). macOS does not expose system audio as a recordable input by default — you have to install a small audio loopback driver called **BlackHole 2ch** and route system audio through it.

The Setup Wizard built into Meeting Copilot does this for you on first launch. **You should not need to read this document** unless the wizard fails or you want to set things up manually before your first meeting.

If you skipped the wizard or it didn't work on your machine, this guide reproduces the wizard's outcome step-by-step.

---

## TL;DR — what the wizard does

| Wizard step | What happens | What you do |
|---|---|---|
| **Welcome** | Explains why we need BlackHole. | Click **Continue** (or **Skip** if you already have a custom audio routing). |
| **Detect** | Probes whether BlackHole is installed and a Multi-Output Device exists. | Wait ~1 second; the wizard auto-decides the next step. |
| **Install** | Runs `brew install --cask blackhole-2ch` if Homebrew is on your Mac, otherwise opens the official `.pkg` download page. | If brew is found, you'll see a macOS password prompt — type your login password. If brew is not found, click the manual link, run the `.pkg`, then click **I've installed, retry**. |
| **Configure** | Creates a *Multi-Output Device* named **Meeting Copilot Multi-Output** that fans audio to your speakers AND BlackHole. | Click **Create Multi-Output**. No password needed. |
| **Verify** | Runs a 5-second silent capture from BlackHole, checks the peak amplitude is non-zero. | Click **Test capture**. macOS will ask for microphone access — click **Allow**. |
| **Done** | Setup complete. The wizard records `setupCompleted=true` and won't show again. | Click **Start using Meeting Copilot**. |

If every step succeeded you can stop reading. If any step failed, jump to [§Troubleshooting](#troubleshooting).

---

## §1 Why BlackHole

### The problem macOS gives us

macOS treats your speakers as an *output* device. Meeting Copilot needs to record what your meeting participants are saying, but macOS does **not** let you record from an output device — that would let any app eavesdrop on every sound your Mac plays.

The standard workaround on macOS is a **virtual audio driver** that exposes itself as both an output (to receive sound) and an input (to record from). BlackHole 2ch is the de-facto open-source choice — it's free, signed, GPLv3, ~1 MB, and ships as a normal `.pkg` you can uninstall any time.

### How Meeting Copilot uses it

```
                      ┌─────────────────────────────┐
   Your meeting       │    Meeting Copilot          │
   participants  ──▶  │  Multi-Output Device        │  ──▶  Your speakers / headphones
   (system audio)     │  (created by the wizard)    │  ──▶  BlackHole 2ch  ──▶  Meeting Copilot
                      └─────────────────────────────┘                              transcription
```

The Multi-Output Device is the trick: macOS sends every sound to **both** your real speakers (so you still hear the meeting) **and** to BlackHole (which Meeting Copilot reads as if it were a microphone). Your microphone goes through a separate channel; the two streams are mixed at transcription time.

### What gets installed on disk

| Path | Purpose | Reversible? |
|---|---|---|
| `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/` | The HAL plug-in (kernel-adjacent audio driver). | Yes — `sudo rm -rf` the directory + reboot, or run the BlackHole uninstaller. |
| (Aggregate device entry in CoreAudio) | An in-memory record describing the **Meeting Copilot Multi-Output** device. | Yes — gone on reboot (transient by design); the wizard re-creates on next launch. |
| `~/Library/Application Support/com.meeting-copilot/settings.json#setupCompleted` | Records that the wizard ran. | Yes — delete the file or toggle from the in-app settings. |

No system files are modified outside `/Library/Audio/Plug-Ins/HAL/`. No daemons or login items are added. The BlackHole project URL is `https://existential.audio/blackhole/`.

---

## §2 Auto-install via the wizard (recommended)

This is what happens when you launch Meeting Copilot for the first time. You don't need to pre-install anything.

### Walkthrough

1. **Open Meeting Copilot.app** (drag from the DMG into `/Applications`, then right-click → Open the first time so Gatekeeper accepts the signed DMG).
2. The wizard auto-mounts as a modal overlay. The main UI is hidden until the wizard finishes.
3. **Welcome** screen — click **Continue**.
   - *Screenshot placeholder:* `docs/screenshots/setup-wizard-welcome.png` — Welcome card with title, 1-paragraph "why" copy, **Continue** primary button, **Skip** link.
4. **Detect** screen — a 3-row checklist auto-fills as the probes complete:
   - `[ ] BlackHole 2ch driver present at /Library/Audio/Plug-Ins/HAL/`
   - `[ ] BlackHole 2ch listed in CoreAudio device enumeration`
   - `[ ] Multi-Output Device routing audio to BlackHole`
   - *Screenshot placeholder:* `docs/screenshots/setup-wizard-detect.png` — 3-row checklist, "Detecting…" spinner.
5. The wizard branches based on what it found:
   - **None present** → advances to **Install** (Step 6).
   - **Driver present, no Multi-Output** → skips Install, advances to **Configure** (Step 7).
   - **Both present** → skips Install AND Configure, advances to **Verify** (Step 8).
6. **Install** screen — the wizard probes Homebrew at `/opt/homebrew/bin/brew` (Apple Silicon) and `/usr/local/bin/brew` (Intel), then `which brew` for non-standard PATHs:
   - **Homebrew found** → click **Install via Homebrew**. A live log streams `brew install --cask blackhole-2ch` output. macOS will pop a **Homebrew wants to make changes** dialog — type your login password.
     - *Screenshot placeholder:* `docs/screenshots/setup-wizard-install-brew.png` — Streaming log `<pre>` with brew progress lines, password dialog overlay.
   - **Homebrew not found** → click the **Download manually** link to open `https://existential.audio/blackhole/` in your default browser, run the `.pkg`, then click **I've installed, retry**.
     - *Screenshot placeholder:* `docs/screenshots/setup-wizard-install-manual.png` — Manual fallback panel with link + retry button.
     - *Screenshot placeholder:* `docs/screenshots/blackhole-pkg-installer.png` — macOS Installer.app showing the BlackHole 2ch `.pkg` welcome screen.
7. **Configure** screen — click **Create Multi-Output**. The wizard calls `AudioHardwareCreateAggregateDevice` under the hood; no password prompt is needed because this is a user-space CoreAudio call.
   - *Screenshot placeholder:* `docs/screenshots/setup-wizard-configure.png` — Configure card with **Create Multi-Output** button, status text "Creating device…".
   - On success the wizard advances to Verify. On idempotent re-run (a device with the same UID already exists) the wizard reuses it silently.
8. **Verify** screen — click **Test capture**. macOS will pop a **Meeting Copilot would like access to the microphone** dialog the very first time — click **Allow**.
   - *Screenshot placeholder:* `docs/screenshots/setup-wizard-verify.png` — Verify card with **Test capture** button, peak meter (greyed until capture runs).
   - *Screenshot placeholder:* `docs/screenshots/macos-microphone-tcc-prompt.png` — Standard macOS TCC permission modal for Microphone access.
   - The wizard records a 5-second silent capture from the BlackHole input, measures peak amplitude, and asserts `peak > 0.001`. If your Mac is muted or no audio is playing during this window, the wizard intentionally still passes — what matters is that the audio path *exists*, not that there's signal at this moment.
   - If the peak is 0 (BlackHole is loaded but routing nothing), the wizard surfaces a typed `BlackHolePresentButSilent` error with a **Try again** button. See [§Troubleshooting #2](#2-multi-output-device-exists-but-transcript-is-silent).
9. **Done** screen — the wizard records `setupCompleted=true` to your settings. Click **Start using Meeting Copilot** to enter the main UI.

### What the wizard does NOT do

- Does **not** change your default system output device. Your speakers / headphones remain the default; you only route audio through the Multi-Output Device when you start a meeting.
- Does **not** auto-elevate or store your login password. The macOS sudo dialog is shown by Homebrew itself; we never see or capture the password.
- Does **not** uninstall BlackHole on quit. If you want to remove BlackHole entirely, run the official uninstaller from `https://existential.audio/blackhole/` or use `brew uninstall --cask blackhole-2ch`.

---

## §3 Manual install (when the wizard fails)

If the wizard's Install step failed and you want to install BlackHole yourself, you have two paths.

### §3.1 Homebrew (Terminal)

Open Terminal.app and run:

```bash
# Apple Silicon (M1/M2/M3/M4 Macs):
/opt/homebrew/bin/brew install --cask blackhole-2ch

# Intel Macs:
/usr/local/bin/brew install --cask blackhole-2ch

# If you don't know which prefix to use, just run:
brew install --cask blackhole-2ch
```

Homebrew will pop a macOS password dialog — type your login password when prompted. After the install completes, **return to Meeting Copilot** and click **Retry** in the wizard. The wizard will re-probe, find BlackHole, and advance.

If you don't have Homebrew installed, see §3.2 below or install Homebrew first from `https://brew.sh`.

### §3.2 Direct `.pkg` download (no Terminal)

1. Open `https://existential.audio/blackhole/` in your browser.
2. Submit your email — Existential Audio will send you a download link (their installer ships behind an email gate to discourage abuse; the project itself is GPLv3 open source, mirror at `https://github.com/ExistentialAudio/BlackHole`).
3. Open the `BlackHole2ch.<version>.pkg` from your Downloads folder.
4. macOS Installer.app launches:
   - *Screenshot placeholder:* `docs/screenshots/blackhole-pkg-installer-welcome.png` — Welcome page.
   - *Screenshot placeholder:* `docs/screenshots/blackhole-pkg-installer-license.png` — License agreement (GPLv3).
   - *Screenshot placeholder:* `docs/screenshots/blackhole-pkg-installer-destination.png` — Destination (Macintosh HD).
   - *Screenshot placeholder:* `docs/screenshots/blackhole-pkg-installer-password.png` — macOS admin password prompt.
5. Click **Continue** → **Continue** → **Agree** → **Install**. Type your login password when prompted.
6. Wait ~5 seconds. The installer reports "The installation was successful."
7. **Return to Meeting Copilot** and click **Retry** in the wizard. The wizard re-probes the HAL plug-in path, finds the driver, and advances to Configure.

### §3.3 Verify the install (optional sanity check)

```bash
# The HAL plug-in must exist:
ls /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/

# Expected output: directory with Contents/Info.plist + Contents/MacOS/BlackHole2ch

# CoreAudio should enumerate it as a device:
system_profiler SPAudioDataType | grep -A 3 "BlackHole 2ch"

# Expected: a stanza with "BlackHole 2ch" name + UID prefix containing "BlackHole2ch"
```

If both checks pass and the wizard still won't advance, see [§Troubleshooting #1](#1-blackhole-2ch-not-found-in-coreaudio-device-list).

---

## §4 Manual Multi-Output Device creation in Audio MIDI Setup

If the wizard's Configure step failed (e.g. CoreAudio API surface drift on a future macOS release — see R-W.6 in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md)), here is how to create the Multi-Output Device by hand using Apple's built-in **Audio MIDI Setup** utility.

### Steps

1. Open **Audio MIDI Setup** (in Finder, navigate to `Applications → Utilities → Audio MIDI Setup.app`, or press ⌘+Space and type "audio midi").
   - *Screenshot placeholder:* `docs/screenshots/audio-midi-setup-launch.png` — Audio MIDI Setup main window with the device list pane on the left.
2. In the bottom-left of the device list pane, click the **+** button → **Create Multi-Output Device**.
   - *Screenshot placeholder:* `docs/screenshots/audio-midi-setup-add-multi-output.png` — Plus-button menu with "Create Multi-Output Device" highlighted.
3. A new entry **Multi-Output Device** appears in the list. Click on it to select.
4. In the right-side pane, you'll see a list of audio devices with **Use** checkboxes. Tick:
   - **Built-in Output** (or your normal output — speakers, headphones, etc.) — set this as the **Master Device** via the dropdown above the list.
   - **BlackHole 2ch** — tick the **Use** box but do NOT make it master.
   - *Screenshot placeholder:* `docs/screenshots/audio-midi-setup-multi-output-config.png` — Multi-Output Device pane with both checkboxes ticked, Master = Built-in Output.
5. **Drift Correction**: tick the **Drift Correction** box on the **BlackHole 2ch** row only. (Not on the master.) This corrects for clock drift between BlackHole's virtual clock and your real audio device.
6. **Rename** the device: double-click on **Multi-Output Device** in the list and rename it to **Meeting Copilot Multi-Output** so the wizard's idempotent detect path recognises it on next launch.
   - *Screenshot placeholder:* `docs/screenshots/audio-midi-setup-rename.png` — Rename inline edit on the device entry.
7. Close Audio MIDI Setup. The device is now registered with CoreAudio.

### Verify

- Re-launch Meeting Copilot. The wizard will re-mount, run Detect, find the existing Multi-Output Device, and **skip Install + Configure** (short-circuit branch — see [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md) §4).
- Or, if you've already passed setupCompleted=true, the main app will use the Multi-Output Device automatically when you start a meeting.

### Note on transience

Aggregate / Multi-Output devices created in Audio MIDI Setup are **persistent across reboots**. Devices created via `AudioHardwareCreateAggregateDevice` (the wizard's path) are **transient** — gone after reboot. The wizard re-creates on every cold-start. If you create the device manually in Audio MIDI Setup, it survives reboots; the wizard's detect probe will still find it because the UID match works either way.

---

## §5 Verifying audio routing (after setup)

Whether the wizard or the manual flow ran, here is how to confirm system audio is actually flowing through BlackHole into Meeting Copilot.

### §5.1 Per-meeting routing

Meeting Copilot does **not** change your default system output device on its own. When you click **Start Recording** in the main UI:

1. The app asks macOS to use the **Meeting Copilot Multi-Output** device for system audio capture *for the duration of the meeting*. Your speakers continue to work because the Multi-Output fans audio to both.
2. When you click **Stop Recording**, the app reverts (it never persisted any default-output change).

If you'd rather route system audio through BlackHole all the time (e.g. for a long-running monitoring meeting):

1. Open **System Settings → Sound → Output**.
2. Click **Meeting Copilot Multi-Output** in the device list.
   - *Screenshot placeholder:* `docs/screenshots/system-settings-sound-output.png` — System Settings Sound pane with Multi-Output Device selected.
3. Verify the volume slider still works and audio still plays through your speakers (it should — Multi-Output fans to both).
4. To revert, click your normal device (Built-in Output, AirPods, etc.) in the same pane.

### §5.2 Confirm transcript captures system audio

The fastest end-to-end check:

1. Start a new meeting in Meeting Copilot (any context you want).
2. Click **Start Recording**.
3. Play a short YouTube video or any clip with clear speech for ~10 seconds.
4. Pause the video.
5. Look at the Meeting Copilot transcript panel. You should see the speech transcribed.
6. Stop the meeting.

If your voice (mic) appears in the transcript but the YouTube speech does NOT, system audio is not flowing. See [§Troubleshooting #2](#2-multi-output-device-exists-but-transcript-is-silent).

### §5.3 Confirm peak amplitude programmatically (advanced)

The wizard's Verify step internally measures peak amplitude and stores the report; you can re-trigger it from the in-app **Settings → Audio → Re-run Setup Wizard** menu (added in v1.0.1).

---

## §6 Troubleshooting

Five common failure modes, mapped to the spike-memo Risk register and the wizard's typed error variants.

### #1 BlackHole 2ch not found in CoreAudio device list

**Symptom:** Wizard's Detect step shows row 1 ticked (HAL plug-in path exists) but row 2 unticked (CoreAudio enumeration doesn't include the device). The wizard advances to Install but Install reports "BlackHole 2ch is already installed."

**Why it happens:** The HAL plug-in is loaded by `coreaudiod` on demand; if `coreaudiod` was running when the `.pkg` installed, it may not have picked up the new plug-in.

**Fix:**

```bash
# Restart coreaudiod to force HAL plug-in reload:
sudo pkill coreaudiod
# coreaudiod restarts itself within ~1 second.

# Alternatively, restart your Mac.
```

Then re-launch Meeting Copilot. Mirrors Swift exit code `7 (blackhole_not_installed)` in `experiments/T-0.2/blackhole_capture.swift:162`.

### #2 Multi-Output Device exists but transcript is silent

**Symptom:** Wizard's Verify step reports `BlackHolePresentButSilent` (peak ≤ 0.001 over 5 seconds even though audio is playing). Or in production: your voice transcribes but other meeting participants don't.

**Why it happens:** Two root causes:

1. **The Multi-Output Device's `IsStacked` bit is `0` not `1`.** A Multi-Output Device fans output to all sub-devices (what we want); an Aggregate Device combines input streams (silent on the output side). The wizard's T-W.4 logic always sets `IsStacked=1`, but a manually-created device in Audio MIDI Setup can end up either way depending on which `+` menu item you chose.
2. **BlackHole is not in the Multi-Output's sub-device list.** You created a Multi-Output but only ticked Built-in Output, missing the BlackHole row.

**Fix:**

- Open Audio MIDI Setup → click **Meeting Copilot Multi-Output** (or your custom name).
- Confirm BOTH **Built-in Output** AND **BlackHole 2ch** have **Use** checkboxes ticked.
- Confirm **Drift Correction** is ticked on the BlackHole row.
- If the issue persists, **delete the device** (right-click → Delete Device) and re-run the Meeting Copilot wizard. The wizard's CFDictionary path always sets `IsStacked=1`.

This mirrors Swift exit code `8 (blackhole_present_but_silent)` in `experiments/T-0.2/blackhole_capture.swift:421` and is risk **R-W.3** in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md).

### #3 Microphone permission denied / TCC prompt didn't appear

**Symptom:** Wizard's Verify step hangs at "Starting capture…" with no peak meter movement, or returns immediately with "Microphone permission denied."

**Why it happens:** macOS gates microphone access via TCC (Transparency, Consent, and Control). On macOS 14+ both microphones and system-audio loopback inputs use the same Microphone bucket. If you previously denied permission for Meeting Copilot, the OS won't re-prompt — it just blocks silently.

**Fix:**

1. Open **System Settings → Privacy & Security → Microphone**.
2. Find **Meeting Copilot** in the list.
3. Toggle the switch ON. (If Meeting Copilot is not in the list, the wizard hasn't yet triggered a TCC prompt — re-run the Verify step from inside the wizard.)
   - *Screenshot placeholder:* `docs/screenshots/system-settings-privacy-microphone.png` — Privacy & Security pane with Microphone permissions list.
4. Re-launch Meeting Copilot and re-run the wizard's Verify step. macOS will now allow the capture.

This mirrors Swift exit code `6 (tcc_not_authorized)` in `experiments/T-0.2/blackhole_capture.swift:195` and is risk **R-W.4** in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md).

### #4 Brew install fails or sudo dialog was cancelled

**Symptom:** Wizard's Install step shows brew log output ending with `Error: ...` or `Installation cancelled by user`. The wizard surfaces the error and shows the manual URL fallback within the same step.

**Why it happens:**

- You clicked **Cancel** on the sudo password prompt instead of typing your password.
- Homebrew is on a non-standard prefix and our probe didn't find it (e.g. you symlinked `/opt/homebrew → /custom/path`).
- Network / GitHub rate limit (rare) — Homebrew downloads casks from GitHub Releases.

**Fix:**

- Click **Download manually** in the wizard's Install step → install the `.pkg` directly per [§3.2](#32-direct-pkg-download-no-terminal). The manual path bypasses Homebrew entirely.
- Or run brew yourself from Terminal per [§3.1](#31-homebrew-terminal), then click **I've installed, retry** in the wizard.

This is risk **R-W.5** in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md).

### #5 Multi-Output Device disappears after reboot

**Symptom:** Wizard ran successfully yesterday; today after a reboot, the wizard re-mounts and Detect shows row 3 unticked (no Multi-Output found) even though row 2 is ticked (BlackHole still present).

**Why it happens:** This is **expected behaviour**, not a bug. The Multi-Output Device created via `AudioHardwareCreateAggregateDevice` is **transient** — CoreAudio does not persist it across reboots. (Manually-created devices in Audio MIDI Setup ARE persistent; ours is not because the API doesn't expose a "persist" flag.)

**Fix:**

- Just walk through the wizard again. The Configure step is idempotent (UID match → reuse) and the whole flow takes ~10 seconds when BlackHole is already installed.
- Or, do the Audio MIDI Setup manual flow ([§4](#4-manual-multi-output-device-creation-in-audio-midi-setup)) — devices created there persist across reboots.

This is risk **R-W.1** in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md). Future versions may add an "auto-recreate on launch" option that hides the wizard when only Configure (not Install) needs to re-run.

### #6 Apple Silicon vs Intel brew prefix mismatch (bonus)

**Symptom:** Wizard's Install step's "Install via Homebrew" button is greyed out / unavailable, even though `brew` works fine in Terminal.

**Why it happens:** The wizard probes `/opt/homebrew/bin/brew` (Apple Silicon) and `/usr/local/bin/brew` (Intel) and falls back to `which brew`. If you have Homebrew on a custom prefix and the `which` fallback can't find it (e.g. your shell PATH differs from the wizard's spawned environment), the probe fails.

**Fix:**

- Symlink your custom brew to a standard prefix: `sudo ln -s /custom/path/bin/brew /opt/homebrew/bin/brew` (Apple Silicon) or `/usr/local/bin/brew` (Intel).
- Or use the manual `.pkg` path per [§3.2](#32-direct-pkg-download-no-terminal).

This is risk **R-W.2** in [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md).

---

## §7 FAQ

**Q: Will BlackHole change anything on my Mac when I'm not using Meeting Copilot?**
No. BlackHole is a passive audio driver — it does nothing unless an app actively reads from it. Your speakers / headphones / AirPods continue working exactly as before. The Multi-Output Device only routes audio through BlackHole when you explicitly select it as the system output (or when Meeting Copilot does so during a meeting).

**Q: Can I uninstall BlackHole later?**
Yes. Run `brew uninstall --cask blackhole-2ch` or use the official uninstaller at `https://existential.audio/blackhole/`. Meeting Copilot's wizard will re-mount on next launch and offer to re-install.

**Q: Does Meeting Copilot work without BlackHole?**
Microphone-only mode works (your voice is captured; the meeting participants are not). System audio capture *requires* BlackHole or a similar loopback driver (e.g. paid alternatives like Loopback.app, Soundflower-fork, or Rogue Amoeba's tools). The wizard's manual fallback page explains how to skip BlackHole entirely if you have one of these alternatives.

**Q: Is BlackHole safe? Does it record everything I do?**
BlackHole is open-source (GPLv3 — `https://github.com/ExistentialAudio/BlackHole`), signed by Existential Audio, and ships as a `.pkg` reviewed by Apple's notarization service. It's a *passive* virtual audio device — it has no network access, no telemetry, no persistence beyond the `.driver` bundle on disk. Apps still need TCC microphone permission to read from it.

**Q: Can the wizard run again after I've completed it?**
Yes. Open **Settings → Audio → Re-run Setup Wizard** from inside Meeting Copilot. The wizard's idempotent path will re-detect, re-create the Multi-Output if missing, and re-verify. No state is lost.

**Q: Why does the wizard ask for microphone permission when it's only verifying system audio?**
On macOS 14+ both your physical microphone and any virtual audio input device (BlackHole counts as one) live in the **Microphone** TCC bucket. There's no separate "system audio loopback" permission — Apple's privacy model groups them.

**Q: What happens if I click "Skip / Quit wizard"?**
The wizard records `setupCompleted=true` immediately and unmounts. The main app loads. If you start a meeting without BlackHole installed, you'll see a soft warning ("System audio not captured — only your microphone") and transcription will work for your voice only. You can re-run the wizard any time from settings.

---

## §8 References

- [`docs/blackhole-wizard-design.md`](blackhole-wizard-design.md) — Engineering design memo (4 contracts: detect / install / configure / FSM, plus permission UX inventory and risk register).
- [`docs/spike-memo.md`](spike-memo.md) lines 81–88 — Phase 0 Risks #1 + #3 (Whisper runaway-decode; BlackHole present-but-silent) — the original observations that motivated this wizard.
- [`docs/tasks/blackhole-wizard/INDEX.md`](tasks/blackhole-wizard/INDEX.md) — Phase-W task index (T-W.1..T-W.10).
- `experiments/T-0.2/blackhole_capture.swift` — Original Swift CoreAudio scaffolding (exit codes 5–10 mapped to wizard error variants).
- BlackHole project — `https://github.com/ExistentialAudio/BlackHole` · `https://existential.audio/blackhole/`.
- Apple — *Core Audio Hardware Abstraction Layer Programming Guide* (`AudioHardwareCreateAggregateDevice`, `kAudioAggregateDeviceIsStackedKey` semantics — public macOS 13+ API).

---

## §9 Screenshot inventory (operator action — capture deferred to host)

The 14 screenshot stubs declared above are filename-anchored to the wizard's `data-testid` IDs (`setup-wizard-step-{welcome,detect,install,configure,verify,done}` and the macOS dialog names) so the operator can capture them on a fresh Mac and drop them into `docs/screenshots/` post-release. Screenshot capture is **not** in scope for the loop sandbox (per CONSTRAINT #3 in the loop prompt — agent does not install BlackHole on dev machine). The doc renders complete without the images; the placeholder lines are the contract.

| # | Filename | Source step / dialog |
|---|---|---|
| 1 | `setup-wizard-welcome.png` | Wizard step `welcome` |
| 2 | `setup-wizard-detect.png` | Wizard step `detect` (3-row checklist) |
| 3 | `setup-wizard-install-brew.png` | Wizard step `install` (Homebrew streaming log) |
| 4 | `setup-wizard-install-manual.png` | Wizard step `install` (manual fallback panel) |
| 5 | `setup-wizard-configure.png` | Wizard step `configure` |
| 6 | `setup-wizard-verify.png` | Wizard step `verify` |
| 7 | `blackhole-pkg-installer.png` | macOS Installer.app — BlackHole `.pkg` welcome |
| 8 | `blackhole-pkg-installer-welcome.png` | macOS Installer.app — Welcome |
| 9 | `blackhole-pkg-installer-license.png` | macOS Installer.app — License (GPLv3) |
| 10 | `blackhole-pkg-installer-destination.png` | macOS Installer.app — Destination |
| 11 | `blackhole-pkg-installer-password.png` | macOS Installer.app — Admin password prompt |
| 12 | `audio-midi-setup-launch.png` | Audio MIDI Setup main window |
| 13 | `audio-midi-setup-add-multi-output.png` | + button → Create Multi-Output Device menu |
| 14 | `audio-midi-setup-multi-output-config.png` | Multi-Output Device pane with checkboxes ticked |
| 15 | `audio-midi-setup-rename.png` | Inline rename edit |
| 16 | `macos-microphone-tcc-prompt.png` | macOS TCC modal — "would like access to the microphone" |
| 17 | `system-settings-sound-output.png` | System Settings → Sound → Output |
| 18 | `system-settings-privacy-microphone.png` | System Settings → Privacy & Security → Microphone |

---

*Document version: aligns with v1.0.1 release. Last updated 2026-05-07. Word count: ~3 500.*
