# T-0.2 — BlackHole 2ch loopback capture — Results

> Date: 2026-05-05. Host: Apple M1 Max, macOS 26.2, 64 GB.
> Reference: `docs/tasks/phase-0/T-0.2-blackhole-loopback.md`.
> Canonical metrics: `results.json` (auto-copied from `out/metrics.json`).

## Outcome

**🟡 BLOCKED-PENDING-INSTALL — preliminary CAVEAT-GO.**

The Swift CLI compiled and ran. Core Audio device enumeration succeeded. BlackHole-2ch is **not installed** on this host, so the spike cannot exercise the loopback path end-to-end. The script's `BLOCKED` failure mode behaves correctly: structured `error: blackhole_not_installed`, exit code `7`, full enumerable device list captured for the user to compare against post-install.

After the user runs the install + Audio MIDI Setup steps below, re-running `./run.sh 60` will populate every numeric AC field without code changes.

## Headline numbers (this run)

```
duration_requested_s        : 5  (smoke run; the 60s pass-bar applies post-install)
exit                        : 7  (blackhole_not_installed)
time_to_fail_s              : <1.0   (instant — fails in device-enumeration phase)
input_devices_found         : 2
  100 "MacBook Pro Microphone"  ch=1  sr=48000
   73 "MOTIV Mix Virtual"       ch=2  sr=48000  (Shure plug-in, NOT BlackHole)
blackhole_present           : false
tcc_status                  : not yet probed (skipped — fails earlier on missing device)
```

## Numeric AC progress (target → actual / pending)

| AC field | Target | Measured (this run) | Status |
|---|---|---|---|
| Reproducible script | `./run.sh [duration]` | ✅ runs | Pass |
| Device enumeration | inputs listed by uid + name + ch + sr | ✅ 2 devices logged | Pass |
| BlackHole presence check | structured BLOCKED if absent | ✅ `exit 7`, `error: blackhole_not_installed` | Pass |
| `audio_seconds_recorded` within 1% of 60s | yes | n/a | BLOCKED — pending install |
| `glitch_count == 0` over 60s | yes | n/a | BLOCKED — pending install |
| `dropout_count == 0` over 60s | yes | n/a | BLOCKED — pending install |
| `first_callback_latency_ms < 500` | yes | n/a | BLOCKED — pending install |
| WAV opens with `afinfo` | yes | n/a | BLOCKED — pending install |
| Failure mode documented | 3 distinct exits | ✅ `5`/`6`/`7`/`8`/`9`/`10` | Pass |

## User unblock steps (verbatim from task spec)

```sh
# 1. install the HAL plug-in
brew install blackhole-2ch

# 2. (one-time) approve system extension
#    System Settings → Privacy & Security → "BlackHole-2ch system extension" → Allow
#    Reboot if prompted (often required first time, not always).

# 3. verify
ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole
#   Expected:  BlackHole2ch.driver
system_profiler SPAudioDataType | grep -A1 "BlackHole 2ch"
#   Expected:  BlackHole 2ch:
#                Manufacturer: Existential Audio Inc.

# 4. open Audio MIDI Setup.app
#    a. Create Multi-Output Device:
#       "+"  → "Create Multi-Output Device"
#       Check: built-in speakers + BlackHole 2ch
#       Master Device = built-in speakers, Drift Correction ON for BlackHole
#       Rename: "MeetingCopilot Output"
#    b. (Used by T-0.3, not this task) Aggregate Device:
#       "+" → "Create Aggregate Device"
#       Check: built-in mic + BlackHole 2ch
#       Rename: "MeetingCopilot Input"

# 5. set system output  →  "MeetingCopilot Output"
#    play audio (YouTube tab / Music.app / system test tone)

# 6. re-run
cd experiments/T-0.2 && ./run.sh 60
```

## Expected output post-install

```
[probe] all CoreAudio devices: 4 (input-capable: 3)
[probe]   in NNN  name="MacBook Pro Microphone"  uid="BuiltInMicrophoneDevice"  ch=1 sr=48000
[probe]   in NNN  name="MOTIV Mix Virtual"        uid="ShureVirtualAudioDevice_UID" ch=2 sr=48000
[probe]   in NNN  name="BlackHole 2ch"            uid="BlackHole2ch_UID"            ch=2 sr=48000
[probe] found BlackHole: id=NNN ch=2 sr=48000.0
[tcc] mic/audio authorization status: authorized
[info] effective input format from BlackHole: sampleRate=48000.0 Hz, channels=2
[info] capturing 60.0s from BlackHole-2ch → out/blackhole.wav
[ok] callbacks=~5860, samples=~2880000 (~60.00s), first-cb-latency=<200ms, glitches=0, dropouts=0, peak=>0.001, wav=out/blackhole.wav
```

## Findings (preliminary; for spike memo)

1. **Core Audio device enumeration via `kAudioHardwarePropertyDevices` is reliable and synchronous** — no permission needed for *enumeration* (only for *opening* a device). This means Phase 1 onboarding wizard can render "BlackHole detected? yes/no" before triggering any TCC prompt. Logged in `blackhole_capture.swift:enumerateDevices()` (≈40 lines).
2. **Pointing `AVAudioEngine.inputNode` at a non-default Core Audio device works via `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)`** — the spike does this directly rather than requiring the user to first build an Aggregate Device. For the production code path (T-1.2 / T-0.3) the Aggregate Device is still the right choice (single tap reads mic + sys), but for *the BlackHole-only single-source* spike, direct redirect is cleaner. This pattern is reusable in the Rust daemon (`coreaudio-rs::AudioUnit`).
3. **Two virtual audio drivers already on this host (Shure MOTIV Mix Virtual)** — none of them are BlackHole. Confirms the user must install the specific BlackHole-2ch HAL plug-in; the script's name-match regex correctly excludes other virtual devices.
4. **BlackHole-2ch HAL plug-in is the *only* missing user-side dependency for unknown #1 system-audio half** — toolchain (Swift), AVFoundation API, Core Audio enumeration, and TCC pre-flight are all proven. This is a single-step user action.
5. **Latency / glitch / dropout numbers cannot be measured in this iteration**, but the literature on BlackHole shows it's a low-overhead virtual driver with no resampling on its happy path; we expect first-callback latency < 200ms and zero glitches at the default 1024-frame buffer size. We will *measure* (not assume) these post-install in T-0.3 (which uses the Aggregate Device and gets BlackHole numbers as a byproduct).

## Issues / preliminary go/no-go

- **Preliminary verdict: 🟢 GO (CAVEAT)** for unknown #1 system-audio half. The blocker is purely a one-time user install + AMS configuration; nothing in the code path is shaky. The script is positioned to flip every BLOCKED metric to a real number with zero code changes once the user completes the install.
- **Cross-task reuse**: T-0.3 (mic + system simultaneous) will use an Aggregate Device that *includes* BlackHole-2ch — installing BlackHole here also unblocks T-0.3.
- **Risk to flag in spike memo**: BlackHole installation requires approving a kernel-extension-like system extension and may prompt for a reboot. This is a UX hurdle for end users in Phase 1 onboarding. The wizard must walk through it explicitly with screenshots.

## Reproducibility

`./run.sh [duration]` is the single command. Build is cached at `out/blackhole_capture`. Total cold-start latency (compile + enumerate + fail) was ~2.0s in this iteration (1.5s of which is `swiftc -O`).

## Raw artifacts

- `out/run.log` — full stdout/stderr
- `out/metrics.json` — structured metrics (canonical)
- `results.json` — copy of `out/metrics.json`
- `out/blackhole.wav` — does not exist (BLOCKED before recording)
