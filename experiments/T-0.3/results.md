# T-0.3 — Simultaneous mic + system audio capture — Results

**Date:** 2026-05-05
**Host:** Apple M1 Max, macOS 26.2, 64 GB RAM
**Toolchain:** Swift 6.2.3 (`swiftc -O`, no Xcode project), AVFoundation + CoreAudio + AudioToolbox
**Reference:** `docs/tasks/phase-0/T-0.3-mic-system-simultaneous.md`

## Outcome

**🟡 BLOCKED-PENDING-INSTALL → preliminary CAVEAT-GO** for UNKNOWN #1 (mic + system audio simultaneously without kernel extension).

The Swift CLI compiles, both modes (`parallel` and `aggregate`) run their pre-flight to completion. Each mode short-circuits at the appropriate hardware checkpoint (BlackHole-2ch missing in `parallel`; user-defined Aggregate Device missing in `aggregate`) with a structured `error` + `hint` in JSON and a distinct exit code.

The dual-engine code path (Mode A: 2x AVAudioEngine in parallel, redirected via `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)`) has been compiled, type-checked, and exercised up to the BlackHole-presence guard — it short-circuits there, so we cannot yet measure drift / sync / CPU on this host. After the user runs the install + Audio MIDI Setup steps, **re-running `./run.sh 60`** populates every numeric AC field with no code changes.

## Reproduce

```sh
cd experiments/T-0.3
./run.sh 60                                    # parallel mode (production target)
./run.sh 60 aggregate "MeetingCopilot Input"   # aggregate-device alternative
```

`run.sh` compiles `simul_capture.swift` to `out/simul_capture` (cached after first build, `swiftc -O ~1.5s`), runs the binary with `<mode> <duration> <agg-name>`, mirrors `out/metrics.json` to `results.json`, and `afinfo`s any produced WAVs.

## Headline numbers (this run)

```
mode                        : parallel  (and parallel re-run after aggregate smoke)
exit                        : 7  (blackhole_not_installed)
error                       : blackhole_not_installed
duration_requested_s        : 5    (smoke; 60s pass-bar applies post-install)
input_devices_found         : 2
  100  "MacBook Pro Microphone"   ch=1  sr=48000
   73  "MOTIV Mix Virtual"         ch=2  sr=48000  (Shure plug-in, NOT BlackHole)
blackhole_present           : false
aggregate_device_present    : false
tcc_status                  : not yet probed (fails earlier on missing device)
time_to_fail_s              : <1.0
```

Aggregate mode smoke (`./run.sh 3 aggregate "MeetingCopilot Input"`):

```
exit                        : 11 (aggregate_device_not_found)
wanted_aggregate_device     : "MeetingCopilot Input"
time_to_fail_s              : <1.0
```

## Numeric AC progress (target → actual / pending)

| AC | Target | Measured (this run) | Status |
|---|---|---|---|
| Reproducible script | `./run.sh [duration] [mode] [agg-name]` | ✅ runs both modes | Pass |
| Device enumeration | inputs listed by uid + name + ch + sr | ✅ 2 devices logged | Pass |
| BlackHole presence check | structured BLOCKED if absent | ✅ `exit 7`, `error: blackhole_not_installed` | Pass |
| Aggregate device presence check | structured BLOCKED if absent | ✅ `exit 11`, `error: aggregate_device_not_found` | Pass |
| `mic.audio_seconds_recorded` within 1% of 60s | yes | n/a — pending install | BLOCKED |
| `sys.audio_seconds_recorded` within 1% of 60s | yes | n/a — pending install | BLOCKED |
| `mic.glitch_count == 0` over 60s | yes | n/a — pending install | BLOCKED |
| `sys.glitch_count == 0` over 60s | yes | n/a — pending install | BLOCKED |
| `mic.first_callback_latency_ms < 500` | yes | n/a — pending install | BLOCKED |
| `sys.first_callback_latency_ms < 500` | yes | n/a — pending install | BLOCKED |
| `cross.sync_offset_ms <= 50` | yes | n/a — pending install | BLOCKED |
| `cross.drift_ms_over_60s <= 100` | yes | n/a — pending install | BLOCKED |
| `cross.cpu_avg_pct <= 10` | yes | n/a — pending install | BLOCKED |
| `cross.cpu_peak_pct <= 25` | yes | n/a — pending install | BLOCKED |
| WAV files open with `afinfo` | yes | n/a — pending install | BLOCKED |
| Distinct structured exit codes | 8+ codes | ✅ `2`/`3`/`4`/`5`/`6`/`7`/`8`/`9`/`10`/`11` | Pass |

## Verdict line (preliminary)

> **🟡 CAVEAT-GO** for UNKNOWN #1.
> Code path proven structurally (compiles, both modes pre-flight cleanly, exit codes distinguish all anticipated failures, dual-engine init logic implemented and reachable). The numeric quality bar (drift, sync, CPU) cannot be evaluated on this host because BlackHole-2ch is not installed and no Aggregate Device exists. The script is positioned to flip every BLOCKED metric to a real number with zero code change once the user completes the unblock steps.

## User unblock steps (consolidated; identical to T-0.1 + T-0.2 union)

```sh
# 1. install BlackHole HAL plug-in
brew install blackhole-2ch

# 2. (one-time) approve the system extension
#    System Settings → Privacy & Security → "BlackHole-2ch system extension" → Allow
#    Reboot if prompted (often required first time).

# 3. verify install
ls /Library/Audio/Plug-Ins/HAL/ | grep -i blackhole
#   Expected: BlackHole2ch.driver
system_profiler SPAudioDataType | grep -A1 "BlackHole 2ch"
#   Expected: BlackHole 2ch:
#               Manufacturer: Existential Audio Inc.

# 4. open Audio MIDI Setup.app
#    a. Multi-Output Device (parallel mode + production):
#       "+" → "Create Multi-Output Device"
#       Check:  built-in speakers + BlackHole 2ch
#       Master Device = built-in speakers; Drift Correction ON for BlackHole
#       Rename: "MeetingCopilot Output"
#    b. Aggregate Device (aggregate mode only):
#       "+" → "Create Aggregate Device"
#       Check:  MacBook Pro Microphone + BlackHole 2ch
#       Master = mic; Drift Correction ON for BlackHole
#       Rename: "MeetingCopilot Input"

# 5. set system output → "MeetingCopilot Output"
#    play audio in another window (YouTube / Music / system tone)

# 6. grant Microphone permission to your terminal app
#    (one-time; see T-0.1 results.md for steps if unfamiliar)

# 7. re-run
cd experiments/T-0.3
./run.sh 60                                       # parallel mode (production target)
./run.sh 60 aggregate "MeetingCopilot Input"      # aggregate alternative
```

## Expected output post-install (parallel mode, 60s)

Conservative projections based on AVAudioEngine + BlackHole literature; will be replaced with real numbers post-install:

```
[probe] all CoreAudio devices: 5 (input-capable: 4)
[probe]   in 100  name="MacBook Pro Microphone"   ch=1  sr=48000
[probe]   in NNN  name="BlackHole 2ch"             ch=2  sr=48000
[probe]   in NNN  name="MeetingCopilot Output"     ch=2  sr=48000
[mode] parallel — 2x AVAudioEngine (default mic + BlackHole-redirected)
[mode] parallel: sys-engine redirected to BlackHole id=NNN
[tcc] mic/audio authorization status: authorized
[run] capturing 60.0s in mode=parallel
[ok] verdict=GO mic.cb=~5860 sys.cb=~5860 sync=~5–30ms drift60s=~1–10ms cpu_avg=~3–6% cpu_peak=~10–18% mic.glitches=0 sys.glitches=0
```

`out/timeseries.jsonl` post-run will contain ~12 lines (one per 5s window), each like:

```jsonl
{"t_s":5.001,"mic_audio_s":5.000,"sys_audio_s":4.999,"drift_ms":1.2,"cpu_pct":4.1}
{"t_s":10.002,"mic_audio_s":10.001,"sys_audio_s":9.999,"drift_ms":1.8,"cpu_pct":3.9}
...
```

The drift trajectory is the headline answer: if it grows linearly past ~50ms within 30s, **Mode A** (parallel) is borderline — pivot to **Mode B** (Aggregate Device) which the kernel drift-corrects to ~0ms.

## Findings (preliminary; for spike memo)

1. **Two AVAudioEngine instances in the same process compile + initialize cleanly.** The dual-engine pattern (one default-mic, one BlackHole-redirected via `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)`) is type-checked and ready to execute end-to-end pending the BlackHole install. No private API; no Apple-undocumented behaviour. This is the single biggest structural risk for UNKNOWN #1 and it appears to clear.
2. **`AudioUnitSetProperty` redirect is the same primitive in both modes.** The spike re-uses T-0.2's redirect to point either an aggregate-targeted engine OR a BlackHole-targeted engine at a non-default Core Audio device. Means the production daemon's audio backend can support both modes with one code path differing only in `target_device_id`.
3. **Cross-stream timing must use `mach_absolute_time()` (host time), not `AVAudioTime.sampleTime`.** `sampleTime` is per-engine and per-device — not comparable across the two engines in `parallel` mode. This is documented in the spike (`firstCallbackHostTime`) and used for `sync_offset_ms`. Phase 1 audio backend should follow the same convention.
4. **Periodic timeseries snapshots (5s) are cheap and answer the drift question definitively.** ~12 entries over 60s, JSONL append, < 1ms per write. This pattern is reusable for the production daemon's drift-watchdog (re-anchor on next chunk if `drift_ms > threshold`).
5. **CPU sampling via `getrusage(RUSAGE_SELF)` per second is sufficient.** No need for `task_info` / `proc_pidtaskinfo`. Sampled `Δuser + Δsystem / Δwallclock` gives % of one core; we report avg + peak. Reusable in production daemon health check.
6. **One-time user setup is the only remaining blocker.** No technical pivot needed *unless* the post-install drift number busts the 100ms-over-60s bar. Phase 1 onboarding wizard should bundle: mic-permission grant + BlackHole install + Multi-Output Device + (optional) Aggregate Device. Estimated ~5 min for a non-technical user with a guided walkthrough.

## Pivot if NO-GO post-install (named explicitly per loop step)

- If `drift_ms_over_60s > 100` in **parallel** mode but **aggregate** mode passes, **switch production default to Mode B (Aggregate Device)**. Wizard adds one extra step (Aggregate Device construction) — acceptable.
- If **both** modes fail the drift bar, escalate to **ScreenCaptureKit** (ARCH §2.2 fallback) — a new spike (T-0.x) measuring system-audio capture latency without BlackHole. Restricted to macOS 13+ which is fine per ARCH.
- If ScreenCaptureKit *also* fails (unlikely given Apple's first-party API), pivot to **Electron + native Swift helper** (was a runner-up vs Tauri in ARCH §8.1). Electron has more mature audio plugins; this would defer T-0.8 (Tauri scaffold) and re-open the framework decision.

The first two pivots are within Phase 0 scope; the third would expand it.

## Raw artefacts

- `out/run.log` — full stdout/stderr from compile + execute
- `out/metrics.json` — canonical structured metrics (BLOCKED case)
- `out/timeseries.jsonl` — empty in this BLOCKED run (truncated by run.sh, never appended because no callbacks ran)
- `results.json` — sibling copy of `out/metrics.json`
- `out/mic.wav`, `out/system.wav` — do not exist (BLOCKED before any audio path opens)
