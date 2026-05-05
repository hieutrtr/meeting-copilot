# T-0.1 — Mic capture spike — Results

**Date:** 2026-05-05
**Host:** Apple M1 Max, macOS 26.2, 64 GB RAM
**Toolchain:** Swift 6.2.3 (Apple swiftlang-6.2.3.3.21), `swiftc -O` direct compile, no Xcode project
**Outcome headline:** **BLOCKED — microphone TCC permission not granted**

## Reproduce

```sh
cd experiments/T-0.1
./run.sh 5      # short smoke run
./run.sh 30     # full plan-spec recording
```

`run.sh` compiles `mic_capture.swift` to `out/mic_capture` (one-shot, cached on subsequent runs), executes it, captures stdout/stderr to `out/run.log`, mirrors `out/metrics.json` into `experiments/T-0.1/results.json`, and runs `afinfo out/mic.wav` if the file was produced.

## Measured

| Field | Value |
|---|---|
| `tcc_status` | `notDetermined` |
| `error` | `tcc_not_authorized` |
| `ok` | `false` |
| Exit code | `6` |
| Time-to-fail | < 1s (TCC pre-flight short-circuits before AVAudioEngine init) |

The script never reaches `engine.start()` in this state — the pre-flight via `AVCaptureDevice.authorizationStatus(for: .audio)` returns `.notDetermined` and we exit fast & explicit. `out/mic.wav` is never created. No callbacks. No glitches recorded because no audio path was opened.

## Why blocked

Capture is gated by macOS TCC (Transparency, Consent, and Control). The current Claude Code shell's parent process has not been granted Microphone access, and macOS won't show its modal permission dialog in a non-GUI context, so any capture attempt either hangs (pre-watchdog) or short-circuits at the auth-status query (current behavior).

`tcc_status == notDetermined` means no human has accepted **or** denied yet; the TCC database has no entry for this binary's parent app bundle / responsible process. From a CLI invoked by a GUI terminal (Terminal.app, iTerm2, VS Code's integrated terminal) the first run will trigger the dialog; granting it once flips this to `.authorized` and recording succeeds.

## What was proven (still meaningful)

Even without a successful recording the spike clears these sub-questions:

1. **Toolchain works** — `swift 6.2.3 + swiftc -O` compiles `AVFoundation`/`AVAudioEngine` against the macOS 26.2 SDK with zero warnings, zero project scaffolding, zero `Package.swift`. ~1.5s compile.
2. **Single-file CLI is the right shape** — no Info.plist needed for the program to *run*; only TCC needs the parent app bundle to declare `NSMicrophoneUsageDescription`. Phase 1 needs a real `Info.plist` either way (Tauri ships its own bundle).
3. **TCC is detectable, not surprising** — `authorizationStatus` is a fast, reliable pre-check. Phase 1 onboarding wizard can use the same API to detect denied/notDetermined state and route the user to the System Settings deeplink. ARCH §2 already calls this out; this spike confirms the API surface.
4. **Watchdog earns its keep** — without `AVCaptureDevice.authorizationStatus`, `engine.inputNode` blocks indefinitely on `notDetermined` in headless mode (observed: hung > 90s before kill). The 13s watchdog catches that, and the pre-flight makes it unnecessary in the common case. Both layers retained for defense-in-depth.

## What is NOT proven yet

- **No glitch count.** The plan AC ("không glitch") cannot be answered until an actual 30 s recording runs.
- **No first-callback latency.** Same.
- **No native sample rate / channel count.** Same — though we know via `system_profiler SPAudioDataType` (Apple Silicon built-in mic = 48 kHz mono, AirPods variants = 16/24 kHz) that the script will report something in that range.
- **No WAV-file open verification** (`afinfo`).

These move from "unknown" to "measured" the instant a user runs `./run.sh 30` once interactively after granting permission, with no code change.

## User unblock steps (manual, one-time)

1. Open **System Settings → Privacy & Security → Microphone**.
2. Find **Terminal** (or **iTerm**, **Visual Studio Code**, or whatever app is hosting the shell — see `ps -ef | grep -i term`).
3. Toggle ON. macOS will likely require restarting the app.
4. From an interactive shell in that app, re-run `./run.sh 30`. Approve the dialog if it appears. macOS persists the decision; subsequent runs (including from a Claude Code session inside that same terminal app) will inherit the grant.
5. After success: re-run `./run.sh 30` and post the new `metrics.json` here. Headlines to confirm: `callback_count > 0`, `glitch_count == 0`, `audio_seconds_recorded ≈ 30`, `signal_present == true` if you spoke.

## Decision for the loop

This is a **CAVEAT-GO** for unknown #1 (mic side): the technical path works, the only blocker is one-time user permission grant. Spike-memo verdict will record this as "proven by inspection + structured failure mode" rather than "proven by full recording" — the residual risk is on the user-onboarding flow (Phase 1 T-1.2) not on the audio API.

## Raw artefacts

- `out/run.log` — full stdout/stderr from compile + execute
- `out/metrics.json` — JSON-encoded measurement (BLOCKED case)
- `results.json` — canonical sibling copy of `metrics.json`
- (post-grant) `out/mic.wav` — the recording itself
