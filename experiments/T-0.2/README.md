# T-0.2 — BlackHole 2ch loopback capture spike

> Throwaway experimental code. See `docs/tasks/phase-0/T-0.2-blackhole-loopback.md`.

## What this measures

60-second loopback recording from BlackHole-2ch (system audio loopback HAL plug-in). Numeric checks:

- **glitch_count** — gaps between consecutive `installTap` callbacks (sampleTime continuity).
- **dropout_count** — silent spans (peak < 1e-4) lasting ≥50 ms after a 1s warm-up window.
- **first_callback_latency_ms** — time from `engine.start()` to the first audio buffer.
- **audio_seconds_recorded** — must be within 1% of the requested duration.

## Reproduce

```sh
./run.sh 60        # 60 seconds (default for the spike)
# or:
./run.sh 5         # quick smoke (BlackHole must be present even for short runs)
```

The driver caches the `swiftc -O` build under `out/blackhole_capture` so subsequent runs skip compile (~1.5s saved). Outputs land in `out/`:

- `out/run.log` — full stdout/stderr
- `out/metrics.json` — structured metrics
- `out/blackhole.wav` — recording (only when BlackHole is present + audio is playing through the Multi-Output Device)
- `results.json` — canonical copy refreshed each run
- `results.md` — human summary

## First-time setup (BlackHole + Audio MIDI Setup)

If `./run.sh 5` exits with `7` and `error: blackhole_not_installed`:

```sh
# 1. install
brew install blackhole-2ch

# 2. macOS may require approving the system extension
#    System Settings → Privacy & Security → scroll to bottom →
#    "BlackHole-2ch system extension"  → Allow → reboot if prompted

# 3. verify
ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole
#   Expected:  BlackHole2ch.driver

system_profiler SPAudioDataType | grep -A1 "BlackHole 2ch"
#   Expected:  BlackHole 2ch:
#                Manufacturer: Existential Audio Inc.

# 4. open Audio MIDI Setup.app
#    a. Create Multi-Output Device:
#       "+" → "Create Multi-Output Device"
#       Check: built-in speakers + BlackHole 2ch
#       Master Device = built-in speakers, Drift Correction ON for BlackHole
#       Rename: "MeetingCopilot Output"
#    b. (For T-0.3 — not this task) Aggregate Device:
#       "+" → "Create Aggregate Device"
#       Check: built-in mic + BlackHole 2ch
#       Rename: "MeetingCopilot Input"

# 5. set system audio output → "MeetingCopilot Output"
#    play audio (YouTube tab / Music.app / system test tone)

# 6. re-run
./run.sh 60
```

## TCC permission

Virtual audio inputs (BlackHole, Loopback, …) share the **Microphone** TCC bucket on macOS 14+. If `./run.sh` exits with `6` and `error: tcc_not_authorized`:

- System Settings → Privacy & Security → Microphone → enable for the parent terminal (Terminal.app, iTerm2, …)
- Re-run.

The script does a non-blocking pre-flight (`AVCaptureDevice.authorizationStatus(for: .audio)`) so it never hangs on TCC — see T-0.1 review file for the deadlock backstory.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Pass — 60s captured, all checks green, signal present |
| `5` | Watchdog (engine never returned audio) |
| `6` | Microphone TCC not authorized |
| `7` | BlackHole-2ch not installed (most common first-run failure) |
| `8` | Captured but recorded silence — system output not routed through BlackHole |
| `9` | `kAudioOutputUnitProperty_CurrentDevice` redirect failed (rare; HAL plug-in failed to load) |
| `10` | Captured signal but failed quality bar (glitch / dropout / latency / duration) |
| Other | Other internal error — see `out/metrics.json.error` and `hint` |

## Verify by hand

```sh
afinfo out/blackhole.wav             # sane: ~60s, 48000 Hz, 2 ch
jq '{ok, glitch_count, dropout_count, max_sample_peak, signal_present}' results.json
# expected when fully unblocked:
# { "ok": true, "glitch_count": 0, "dropout_count": 0, "max_sample_peak": ..., "signal_present": true }
```

`// experimental, not for prod` — single-source-of-truth audio capture lives in T-1.2 (Rust daemon) per `docs/IMPLEMENTATION-PLAN.md`.
