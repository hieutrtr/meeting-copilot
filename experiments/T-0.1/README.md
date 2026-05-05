# T-0.1 — Mic capture spike

> Throwaway prototype for Phase 0 unknown #1 (audio capture). See `docs/tasks/phase-0/T-0.1-mic-capture.md` for the task definition.

## Reproduce

```sh
cd experiments/T-0.1
./run.sh 10              # 10-second recording (default)
./run.sh 30              # 30-second recording (matches plan AC)
```

Outputs land in `experiments/T-0.1/out/`:

- `mic.wav` — float32 LPCM at the device's native sample rate
- `metrics.json` — measurements (latency, glitches, peak, etc.)
- `run.log` — full stdout/stderr including `afinfo` of the WAV

`results.json` (sibling of this README) is overwritten on each run as a canonical copy of the metrics for the loop framework.

## First-time TCC permission

macOS will prompt for **Microphone** access the first time `swift` runs this. Grant it for the parent terminal (Terminal.app, iTerm, VS Code integrated terminal — whatever launched the script). If permission is denied or never granted in a headless session, the script will exit with status `2` or fire zero audio callbacks; `metrics.json` will record `{"ok": false, "error": "..."}` with the unblock hint.

To inspect / reset permissions:

```sh
# Check microphone-permission state for current terminal binary
codesign -dv "$(which swift)" 2>&1 | head -3
# Reset (re-prompts on next run; needs sudo)
tccutil reset Microphone
```

## Verify a successful run by hand

```sh
afinfo out/mic.wav                    # duration ≈ requested seconds
jq . out/metrics.json                 # callback_count > 0, glitch_count == 0
afplay out/mic.wav                    # listen back
```

## Files

- `mic_capture.swift` — single-file Swift CLI (no Xcode project, no Package.swift)
- `run.sh` — invokes `swift` and records stdout/stderr
- `out/` — generated artefacts (gitignored intent — kept for spike traceability)
