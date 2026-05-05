# T-0.3 — Simultaneous mic + system audio capture spike

> experimental, not for prod. See `docs/tasks/phase-0/T-0.3-mic-system-simultaneous.md` for spec, AC, and pivot path.

Records mic + system audio simultaneously and emits per-stream + cross-stream metrics that prove (or disprove) UNKNOWN #1 — "macOS can capture both at once without a kernel extension".

## One-command reproduction

```sh
./run.sh                              # default: 60s, parallel mode (production target)
./run.sh 30                           # short run, parallel mode
./run.sh 60 aggregate "MeetingCopilot Input"   # alternative: single AVAudioEngine on Aggregate Device
```

Outputs (under `out/`):
- `mic.wav`, `system.wav` — per-stream PCM float32 WAVs at native sample rate (mono if from default mic / split-from-aggregate; 2ch if from BlackHole direct).
- `metrics.json` — canonical structured cross-stream metrics. Mirrored to `../results.json`.
- `timeseries.jsonl` — `{t_s, mic_audio_s, sys_audio_s, drift_ms, cpu_pct}` snapshot every 5s.
- `run.log` — full stdout/stderr.

`results.json` next to the README is the canonical sibling copy, auto-overwritten on every successful run.

## Verify-by-hand (post-install)

```sh
afinfo out/mic.wav      # ~60s, 48kHz, 32-bit float, 1ch
afinfo out/system.wav   # ~60s, 48kHz, 32-bit float, 2ch (parallel) or 1ch (aggregate)
jq '.verdict, .cross, .checks' out/metrics.json
jq '.drift_ms, .cpu_pct' out/timeseries.jsonl  # one line per 5s window
```

A 🟢 GO run prints `verdict: "GO"` and all `.checks.*` are `true`.

## Exit codes

| Exit | Meaning | Fix |
|---|---|---|
| 0 | all ACs pass — 🟢 GO | — |
| 2 | unknown mode arg | use `parallel` or `aggregate` |
| 3 | mic_tap_install_failed / sys_tap_install_failed / audio_file_open_failed | rare; check disk + permissions |
| 4 | engine.start failed | mic permission may have been revoked between probe and start |
| 5 | watchdog_timeout | one engine wedged; check BlackHole + Multi-Output Device |
| 6 | tcc_not_authorized | grant Microphone access in System Settings → Privacy & Security |
| 7 | blackhole_not_installed | `brew install blackhole-2ch` + system-extension approval |
| 8 | sys recorded silence | system output not routed through Multi-Output → BlackHole |
| 9 | current_device_set_failed | HAL plugin failed to load; reboot |
| 10 | numeric quality bar failed | look at `.checks` for which AC missed |
| 11 | aggregate_device_not_found | (mode B) build the named Aggregate Device in Audio MIDI Setup |

## First-time setup (consolidates T-0.1 + T-0.2 prerequisites)

1. **Microphone permission**: System Settings → Privacy & Security → Microphone → enable for Terminal/iTerm/VS Code.
2. **BlackHole**: `brew install blackhole-2ch`. Approve system extension. Reboot if prompted.
3. **Audio MIDI Setup → Multi-Output Device** (parallel mode requires this for system audio to actually flow through BlackHole):
   - "+" → "Create Multi-Output Device".
   - Check: built-in speakers + BlackHole 2ch. Master = built-in speakers. Drift Correction ON for BlackHole.
   - Rename to `MeetingCopilot Output`.
   - Set as system output before the run; play audio (YouTube tab / Music) so BlackHole has signal.
4. **(Aggregate mode only) Audio MIDI Setup → Aggregate Device**:
   - "+" → "Create Aggregate Device".
   - Check: MacBook Pro Microphone + BlackHole 2ch. Master = mic. Drift Correction ON for BlackHole.
   - Rename to `MeetingCopilot Input`.
   - The script targets it by name (case-insensitive); pass the name as the 3rd arg.

## What this spike does NOT cover

- 16kHz mono resampling (whisper input format) — that's Phase 1 T-1.2.
- Diarization labeling beyond per-stream tagging — Phase 1 / 2.
- USB / Bluetooth headsets clock-domain edge cases — production code path.
- ScreenCaptureKit alternative — ARCH §2.2, deferred to v2 unless this spike NO-GOs.
