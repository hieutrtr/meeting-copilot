# BlackHole Setup Wizard — Design Memo (v1.0.1 patch)

**Date**: 2026-05-07 · **Author**: loop driver · **Phase**: post-v1.0 (becomes v1.0.1) · **Decision sought**: green-light T-W.2..T-W.10 implementation against the contracts locked here.

> **Scope.** Locks down — before any code lands — the four contracts that surface inside the BlackHole Setup Wizard so T-W.2..T-W.10 implement against a frozen design: (1) detection ladder, (2) install path tree, (3) configure CFDictionary blueprint, (4) wizard state machine. Plus a permission-UX inventory (≥ 3 prompt sources) and 6 risks (transitive Aggregate Device, brew prefix split, IsStacked bit confusion, TCC re-prompt, sudo timing, API drift). Cross-references `docs/spike-memo.md` lines 21–29 + 81–88 (Risks #1, #3) and `experiments/T-0.2/blackhole_capture.swift` lines 98–167 (Swift CoreAudio scaffolding to be ported into Rust).

---

## TL;DR — 4 contracts

| # | Contract | Decision | Anchor |
|---|---|---|---|
| 1 | **Detection** — when is BlackHole "good enough" to start a meeting? | 4-state ladder: `NotInstalled → InstalledNotConfigured → Configured → Verified`. Promotion via 4 cumulative probes (HAL plug-in path, CoreAudio device list, Multi-Output sub-device list, 5s capture peak > 0.001). | T-W.2 enum mirrors spike Swift exit codes 5–10. |
| 2 | **Install** — how do we get BlackHole on disk without making the user open Terminal? | 2-tier tree: **brew cask first** (`brew install --cask blackhole-2ch`, both Apple Silicon `/opt/homebrew` and Intel `/usr/local` prefixes probed); **manual `.pkg`** fallback (`https://existential.audio/blackhole/`) opened in default browser. Never run brew shell-string; Rust-side `Command::new()` with array argv. | T-W.3 `BrewProbe` trait; argv array form is a unit-test BLOCKING checkbox. |
| 3 | **Configure** — how do we wire BlackHole into system audio without Audio MIDI Setup UI scripting? | `AudioHardwareCreateAggregateDevice(CFDictionary)` with `kAudioAggregateDeviceIsStackedKey: 1` (Multi-Output, NOT Aggregate). Sub-devices = built-in output + BlackHole UID. UID = `MeetingCopilotMultiOut`. Idempotent: existing UID match → return existing device ID, no recreate. | T-W.4 mock-driven CFDictionary builder; IsStacked=1 regression guard test. |
| 4 | **Wizard FSM** — what does the user actually click? | 5-step `useReducer` state machine: `welcome → detect → install → configure → verify → done`. Detection result short-circuits: all-green skips install + configure, jumps straight to verify. Quit-wizard escape hatch sets `setupCompleted=true` (escape valve so users with custom audio routing aren't trapped). | T-W.6 reducer-isolation tests + 12 RTL component tests. |

---

## §1 Detection ladder (T-W.2)

The Swift `experiments/T-0.2/blackhole_capture.swift` ships 6 exit codes covering the failure space (line 162: `exit(7) blackhole_not_installed`, line 195: `exit(6) tcc_not_authorized`, line 213: `exit(5) watchdog_timeout`, line 242: `exit(9) current_device_set_failed`, line 421: `exit(8) blackhole_present_but_silent`, line 422: `exit(10) quality_bar_failed`). The wizard collapses these into a 4-state `BlackHoleStatus` enum because the wizard's job is to **promote the user from worse to better**, not to expose the full failure surface:

```rust
pub enum BlackHoleStatus {
    NotInstalled,                  // covers Swift exit 7
    InstalledNotConfigured,        // device present, no Multi-Output containing BH UID (covers Swift exit 8 partially)
    Configured,                    // Multi-Output exists with BH; capture not yet attempted
    Verified { peak: f32, callback_count: u32 }, // capture peak > 0.001 (covers Swift exit 0)
}
```

Promotion probes (each is a pure read; no side effects):

| Probe | Source | Promotes from | Promotes to |
|---|---|---|---|
| (a) HAL plug-in path exists at `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/` | `std::fs::metadata` | — | `NotInstalled` → `InstalledNotConfigured` (next probe must agree) |
| (b) CoreAudio enumeration (`kAudioHardwarePropertyDevices`) contains a device with name matching `/blackhole 2ch/i` OR UID containing `BlackHole2ch_UID` | Mirrors Swift `findBlackHole` lines 144–154 | (a) | (a) re-confirmed; sets BH UID for next probe |
| (c) Multi-Output Device (Aggregate with `IsStacked=1`) exists whose `kAudioAggregateDeviceSubDeviceListKey` contains BH UID from (b) | New: walks Aggregate sub-list | `InstalledNotConfigured` | `Configured` |
| (d) 5s `cpal::build_input_stream` from BH device with peak amplitude > 0.001 | T-W.5 verify smoke test | `Configured` | `Verified` |

T-W.2 ships probes (a)+(b)+(c). T-W.5 ships probe (d). Wizard step "Detect" calls `detect_blackhole()` which runs (a)+(b)+(c) and returns a `BlackHoleStatus` short of `Verified`. Wizard step "Verify" calls T-W.5 separately to flip the final bit.

**Why not collapse all 4 probes into one call?** Probe (d) requires Microphone TCC permission and emits a 5-second blocking capture. We do NOT want that running on every wizard render; we want it once at the end. So detect = (a)+(b)+(c), verify = (d), separately invokable.

---

## §2 Install path tree (T-W.3)

```
                  ┌─────────────────────┐
                  │  Wizard step:       │
                  │  Install            │
                  └──────────┬──────────┘
                             ▼
                ┌────────────────────────────┐
                │  Probe Homebrew presence:  │
                │  1. /opt/homebrew/bin/brew │  ← Apple Silicon
                │  2. /usr/local/bin/brew    │  ← Intel
                │  3. `which brew` shell-out │  ← user-PATH custom
                └────────────┬───────────────┘
                             ▼
              ┌──────────────────────────────┐
              │  brew found?                 │
              └──────────┬─────────┬─────────┘
                       yes         no
                         │         │
                         ▼         ▼
        ┌────────────────────┐  ┌──────────────────────────────┐
        │  std::process::    │  │  Render manual URL link in   │
        │  Command::new(brew)│  │  the wizard:                 │
        │  .args([          │  │  https://existential.audio/   │
        │    "install",     │  │  blackhole/                   │
        │    "--cask",      │  │  + "Open in browser" button   │
        │    "blackhole-2ch"│  │  + "I've installed, retry"    │
        │  ])                │  │  button (re-runs detect)      │
        │                    │  │                              │
        │  Stream stdout +   │  │  No Tauri shell plugin       │
        │  stderr → wizard   │  │  involvement; just shell out │
        │  via mpsc channel  │  │  `open <url>` from Rust.     │
        │                    │  │                              │
        │  On non-zero exit: │  │                              │
        │  surface stderr,   │  │                              │
        │  offer manual URL  │  │                              │
        │  fallback within   │  │                              │
        │  same step         │  │                              │
        └─────────┬──────────┘  └──────────────────────────────┘
                  ▼
              (advance to Configure step on success)
```

**Critical contract**: `Command::new("brew").args(["install", "--cask", "blackhole-2ch"])` — array argv form; **never** a shell string. Phase 4 R-2 (deeplink injection) review checkbox is reused verbatim here. Manual URL link uses `target="_blank" rel="noopener"` in the React component.

**Why brew cask, not formula?** BlackHole on Homebrew is a cask (it ships a signed `.pkg`, not a Homebrew-built binary). `brew install blackhole-2ch` *also* works on modern Homebrew (auto-detects the cask), but `brew install --cask blackhole-2ch` is the explicit form documented in BlackHole's README and is the safer write.

**Why not `installer -pkg <path> -target /` directly from Rust?** Requires `sudo`, which would need the wizard to capture and forward the user's password — privacy/security nightmare. Brew shells out to its own `osascript` admin dialog, which is the standard macOS UX and the user already trusts.

---

## §3 Configure CFDictionary blueprint (T-W.4)

`AudioHardwareCreateAggregateDevice(description: CFDictionaryRef, deviceID: AudioDeviceID*) → OSStatus`

```objc
{
  kAudioAggregateDeviceUIDKey: "MeetingCopilotMultiOut",            // CFString — our brand
  kAudioAggregateDeviceNameKey: "Meeting Copilot Multi-Output",     // CFString — user-visible
  kAudioAggregateDeviceMasterSubDeviceKey: <built-in-output-uid>,   // CFString — the device clock follows
  kAudioAggregateDeviceSubDeviceListKey: [                          // CFArray<CFDictionary>
    { kAudioSubDeviceUIDKey: <built-in-output-uid> },
    { kAudioSubDeviceUIDKey: <BlackHole2ch-uid> }
  ],
  kAudioAggregateDeviceIsStackedKey: 1                              // CFNumber — 1 = Multi-Output, 0 = Aggregate
}
```

**The IsStacked bit is THE gotcha.** `1` creates a Multi-Output Device — audio sent to this device fans out to ALL sub-devices simultaneously (built-in output AND BlackHole). `0` creates a regular Aggregate Device — sub-devices feed input streams. We need the user to *hear* their meeting AND have it captured by BlackHole; that's Multi-Output. T-W.4 unit test #4 (`is_stacked_key_is_1_for_multi_output_not_0`) is a BLOCKING regression guard.

**Idempotent re-creation contract:**

```
fn create_multi_output(name, sub_uids) -> Result<AudioDeviceID, ConfigureError>:
    1. enumerate_devices() → look for existing Aggregate with UID="MeetingCopilotMultiOut"
    2. if found:
         a. validate IsStacked=1 (else destroy + recreate per (3))
         b. validate sub-list contains all sub_uids
         c. return existing device_id  (no AudioHardware* call)
    3. AudioHardwareCreateAggregateDevice(build_dict(name, sub_uids), &mut id)
    4. return id
```

Idempotency is critical because (a) the wizard re-runs on every cold-start until `setupCompleted=true` is persisted, and (b) Aggregate Devices are *transient* (lost at reboot — R-W.1) so we must recreate at app startup unconditionally.

**Default-output flip (optional, opt-in):** the wizard does NOT automatically set the new Multi-Output as the system default output (that would change what the user hears next time they play YouTube). The "Verify" step displays a one-click button "Set as system output for this meeting" that calls `AudioObjectSetPropertyData(kAudioHardwarePropertyDefaultSystemOutputDevice)` and reverts on app quit. Reverting on quit is a Phase-W stretch goal; if not in scope, document the manual revert in `docs/SETUP.md`.

---

## §4 Wizard state machine (T-W.6)

```
              ┌─────────────┐
              │  WELCOME    │  Render: title + 1-paragraph "why" + Continue button + Skip link
              │  state      │
              └──────┬──────┘
                     │ Continue
                     ▼
              ┌─────────────┐
              │  DETECT     │  Auto-runs detect_blackhole() on mount. 4-row checklist UI:
              │  state      │  [✓] HAL plug-in present
              │             │  [✓] CoreAudio device enumerated
              │             │  [ ] Multi-Output configured  ← short-circuit branch
              └──────┬──────┘
                     │
       ┌─────────────┼───────────────┬──────────────┐
       │             │               │              │
   NotInstalled  InstalledNot…   Configured     (any error)
       │           Configured        │              │
       ▼              ▼              ▼              ▼
  ┌─────────┐   ┌──────────┐   ┌──────────┐  ┌───────────┐
  │ INSTALL │   │CONFIGURE │   │  VERIFY  │  │ ERROR PANE│
  └────┬────┘   └─────┬────┘   └─────┬────┘  │  (in-step;│
       │              │              │       │  not its  │
       ▼              ▼              ▼       │  own state│
   (after install)  (after config)  ▼        │   — never │
       │              │       ┌──────────┐   │  unmounts)│
       └──────────────┘       │   DONE   │   └───────────┘
                              └──────────┘

  Quit-wizard link is rendered on every step except DONE; clicking sets
  `settingsStore.setupCompleted = true` and unmounts the wizard. This is
  the user's escape hatch when they have a custom audio routing setup
  the wizard doesn't recognize (e.g. Loopback.app, Aggregate Device
  for studio recording).
```

Implemented via `useReducer` with a closed action union:

```ts
type WizardAction =
  | { type: "continue" }
  | { type: "detect_result"; status: BlackHoleStatus }
  | { type: "install_started" }
  | { type: "install_progress"; line: string }
  | { type: "install_completed" }
  | { type: "install_failed"; error: string }
  | { type: "configure_completed"; deviceId: number }
  | { type: "configure_failed"; error: string }
  | { type: "verify_completed"; peak: number }
  | { type: "verify_failed"; error: string }
  | { type: "retry" }       // verify-silent retry
  | { type: "quit" };       // escape hatch
```

The reducer is pure (no side effects); side effects (Tauri `invoke()` calls) live in the parent component's `useEffect` keyed off `state.step`. T-W.6 tests assert the reducer transitions in isolation (12 cases) — this is the same test pattern Phase 2 used for `meetingStore` state transitions.

---

## §5 Permission UX inventory (≥ 3 sources)

The wizard surfaces three distinct macOS permission prompts. Each is documented in T-W.8 SETUP.md and pre-warned in the wizard step that triggers it:

| # | Prompt | Source | Wizard step | Pre-warning copy |
|---|---|---|---|---|
| 1 | **Microphone (TCC)** modal: "Meeting Copilot would like access to the microphone." | First call to `AVCaptureDevice` / cpal `build_input_stream` from helper-daemon | T-W.5 Verify | "macOS will ask for microphone access in a moment. We need this to capture audio (mic + system) — both go through the microphone TCC bucket on macOS 14+." |
| 2 | **Sudo / admin** dialog (osascript): "Homebrew wants to make changes." | Brew cask install drops the `.pkg` into `/Library/Audio/Plug-Ins/HAL/`, which is a system path requiring elevation. Brew handles the dialog itself. | T-W.3 Install | "You may see a macOS password prompt — that's Homebrew running the BlackHole installer. Type your login password to continue." |
| 3 | **Default output change** confirm (no modal, but visible in System Settings menu bar) | Optional T-W.4 stretch: setting Multi-Output as system default output. macOS does NOT modal-prompt for this; it is silent. | T-W.5 Verify (post-success) | "Click 'Use for this meeting' to route system audio through the Multi-Output Device. Your Mac will return to its previous output device when Meeting Copilot quits." |

**Not in this list (intentionally):**

- **Accessibility TCC** — would be required for an `osascript` UI-script of Audio MIDI Setup. We do NOT use that path because it is heavier than Microphone TCC and is reserved for the emergency-fallback documented under R-W.6 (NOT shipped). The wizard's CFDictionary path (T-W.4) does NOT need Accessibility.
- **Screen Recording TCC** — not used. We do NOT use ScreenCaptureKit (Phase 0 spike pivot ladder reserves it for the BlackHole-fails fallback).

---

## §6 Risks (≥ 5; full list lives in INDEX.md §"Risk Register")

Top 6 condensed (full mitigations in INDEX):

1. **R-W.1 — Aggregate Device transience.** Recreated at app startup; idempotent.
2. **R-W.2 — Apple Silicon vs Intel Homebrew prefix split.** `BrewProbe` trait checks both `/opt/homebrew` and `/usr/local` + `which brew` fallback.
3. **R-W.3 — `IsStacked=1 vs 0` confusion.** BLOCKING regression test (`is_stacked_key_is_1_for_multi_output_not_0`).
4. **R-W.4 — TCC re-prompt across helper-daemon respawn.** Capture stays in main Tauri process, not a fresh subprocess.
5. **R-W.5 — Brew sudo cancel race.** Stderr surfaced live; manual URL fallback within the same step.
6. **R-W.6 — macOS API drift.** Pin to public macOS 13+ APIs only; emergency UI-script path documented but not shipped.

---

## §7 Sequence: happy path (cold-start fresh Mac → Verified)

```
User                  Wizard UI            Tauri command          Rust (helper-daemon)        macOS
 │                       │                      │                      │                       │
 │ launch app            │                      │                      │                       │
 ├──────────────────────▶│                      │                      │                       │
 │                       │ render WELCOME       │                      │                       │
 │ click Continue        │                      │                      │                       │
 ├──────────────────────▶│                      │                      │                       │
 │                       │ DETECT step mounts   │                      │                       │
 │                       ├─────invoke──────────▶│                      │                       │
 │                       │                      │ setup_detect_blackhole                       │
 │                       │                      ├─────────────────────▶│                       │
 │                       │                      │                      │ enumerate_devices()   │
 │                       │                      │                      ├──────────────────────▶│
 │                       │                      │                      │◀── kAudioHwPropDevs ──┤
 │                       │                      │◀─ NotInstalled ──────┤                       │
 │                       │◀ status: NotInstalled│                      │                       │
 │                       │ INSTALL step mounts  │                      │                       │
 │ click "Install via brew"                     │                      │                       │
 ├──────────────────────▶│                      │                      │                       │
 │                       ├─invoke (streaming)──▶│                      │                       │
 │                       │                      │ setup_install_blackhole                      │
 │                       │                      ├─────────────────────▶│                       │
 │                       │                      │                      │ Command::new("brew")  │
 │                       │                      │                      │  .args([install, ...])│
 │                       │                      │                      ├──────────────────────▶│
 │                       │                      │                      │       (osascript admin │
 │                       │                      │ ◀──── stdout lines ──┤        dialog appears) │
 │                       │ render progress      │                      │                       │
 │ enter password        │                      │                      │                       │
 ├─────────────────────────────────────────────────────────────────────────────────────────────▶│
 │                       │                      │                      │ ◀ brew exit 0 ────────┤
 │                       │                      │◀── ok: installed ────┤                       │
 │                       │ CONFIGURE step       │                      │                       │
 │ click "Create Multi-Output"                  │                      │                       │
 ├──────────────────────▶│                      │                      │                       │
 │                       ├─invoke──────────────▶│                      │                       │
 │                       │                      │ setup_configure_multi_output                 │
 │                       │                      ├─────────────────────▶│                       │
 │                       │                      │                      │ AudioHardwareCreate-  │
 │                       │                      │                      │   AggregateDevice(dict)│
 │                       │                      │                      ├──────────────────────▶│
 │                       │                      │                      │◀── device_id ─────────┤
 │                       │                      │◀── ok: deviceId ─────┤                       │
 │                       │ VERIFY step          │                      │                       │
 │ click "Test capture"  │                      │                      │                       │
 ├──────────────────────▶│                      │                      │                       │
 │                       ├─invoke──────────────▶│                      │                       │
 │                       │                      │ setup_verify_capture                         │
 │                       │                      ├─────────────────────▶│                       │
 │                       │                      │                      │ cpal build_input_stream│
 │                       │                      │                      │ (5s)                  │
 │                       │                      │                      │       (Microphone TCC │
 │                       │                      │                      │        modal first    │
 │                       │                      │                      │        time only)     │
 │ click Allow           │                      │                      │                       │
 ├─────────────────────────────────────────────────────────────────────────────────────────────▶│
 │                       │                      │                      │◀── peak: 0.234 ───────┤
 │                       │                      │◀── ok: Verified ─────┤                       │
 │                       │ DONE state           │                      │                       │
 │                       │ setSetupCompleted    │                      │                       │
 │                       │   (settingsStore)    │                      │                       │
 │                       │ unmount + render     │                      │                       │
 │                       │   main app UI        │                      │                       │
```

---

## §8 References

- `docs/spike-memo.md` lines 21–29 (Unknown #1 verdict + caveat), lines 81–88 (Risks #1, #3 — runaway-decode, BlackHole present-but-silent).
- `experiments/T-0.2/blackhole_capture.swift` lines 98–167 (Swift CoreAudio enumeration scaffolding, exit codes 5–10 mapped to T-W.2 enum).
- `crates/audio-capture/src/mic.rs` (cpal mic source — re-used by T-W.5 verify capture).
- `docs/tasks/phase-4/INDEX.md` (rule structure reused: Process Rules, TDD per task, Acceptance Criteria Summary, Risk Register).
- Apple — *Core Audio User-Space Hardware Plug-In* documentation (`AudioHardwareCreateAggregateDevice`, `kAudioAggregateDeviceIsStackedKey` semantics — public macOS 13+ API).
- Existential Audio — *BlackHole 2ch* official site (`https://existential.audio/blackhole/`) for manual `.pkg` download fallback.

---

*Word count: ~1500. This memo is the lock-down point for Phase-W; T-W.2..T-W.10 review docs cite this design by section number.*
