# T-W.7 — App Startup Integration (Wizard mount + setupCompleted persistence)

> **Status:** ✅ Landed (post-v1.0.1 fix loop, 2026-05-07).
> **Umbrella spec** for T-W.7 — covers Parts A/B/C across `R-W.5` (settings field), `R-W.6` (Tauri command wrappers), `R-W.7` (App.tsx mount + RTL).
> **Files of record:**
> - `src/App.tsx` — wizard gate + invoker adapters
> - `src/App.test.tsx` — 4 RTL integration tests (WT-1..WT-4)
> - `src/store/settingsStore.ts` — `setupCompleted: boolean` field (R-W.5)
> - `src/lib/setupCommands.ts` — typed `invoke` wrappers (R-W.6)
> - `src-tauri/src/commands/setup.rs` — 4 `#[tauri::command]` bodies + DTOs (R-W.6)

---

## Goal

Render the BlackHole Setup Wizard on first launch, persist user sign-off, and unmount the wizard on completion so the meeting UI takes over. The wizard must NOT re-fire on every cold start once the user has finished it.

## Wire Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                            App.tsx                                  │
│                                                                     │
│   useSettingsStore((s) => s.setupCompleted)  ◄── persisted gate    │
│           │                                                         │
│           ▼                                                         │
│   if (!setupCompleted) ──► <SetupWizard                             │
│                              invokers={wizardInvokers}              │
│                              onDone={onWizardDone} />               │
│                                  │                                  │
│                                  │  detect / install / configure /  │
│                                  │   verify Tauri invokes           │
│                                  ▼                                  │
│                            src/lib/setupCommands.ts                 │
│                                  │                                  │
│                                  ▼                                  │
│                            @tauri-apps/api/core::invoke             │
│                                  │                                  │
│                                  ▼                                  │
│                  src-tauri/src/commands/setup.rs (R-W.6)            │
│                                                                     │
│   else ──► <main>{ContextLoader, MeetingControls, …}</main>         │
│                                                                     │
│   onWizardDone() {                                                  │
│     setSetupCompleted(true);  // persisted to localStorage          │
│   }                                                                 │
└────────────────────────────────────────────────────────────────────┘
```

## Part A — `setupCompleted` settings field (R-W.5, landed `b2cbd96`)

Added under `SettingsValues` in `src/store/settingsStore.ts`:

```ts
// Phase-W T-W.7 — gate flag for the BlackHole Setup Wizard. Default
// `false` so a fresh install (or a v1/v2-without-this-key payload) sees the
// wizard on first launch.
setupCompleted: boolean;
```

`coerceLoaded` zero-fills missing keys to `false`, matching the pattern T-3.9 (`telemetryEnabled`) and T-4.2 (`mcpServerEnabled`) established. Existing user payloads (no field) → wizard fires once on first launch post-upgrade. The wizard short-circuits to `done` in ≤ 2 s when BlackHole is already configured (per T-W.6 detect FSM short-circuit branch — `nextStepForDetect("configured") === "verify"`).

## Part B — Tauri command wrappers (R-W.6, landed `b2cbd96`)

Four `#[tauri::command]` async fns in `src-tauri/src/commands/setup.rs`:

| Command | Helper-daemon function | DTO |
|---|---|---|
| `setup_detect_blackhole` | `audio_capture::detect_blackhole(RealCoreAudioProbe)` | `BlackHoleStatusDto` |
| `setup_install_blackhole` | `helper_daemon::install_via_brew(RealFilesystem, RealProcessRunner)` | `InstallReportDto` |
| `setup_configure_multi_output` | `audio_capture::create_multi_output(RealAggregateDeviceCreator, RealCoreAudioProbe, …)` | `ConfigureMultiOutputResultDto` |
| `setup_verify_capture` | `audio_capture::verify_capture(RealAudioInputProbe, …)` | `VerifyReportDto` |

Wire-format DTOs are byte-identical to the TS shapes consumed by `useSetupWizard.ts` (`BlackHoleStatus`, `VerifyReport`, `InstallReport`). Shape stability is locked by 6 cargo `#[test]` cases that round-trip JSON.

Typed JS wrappers in `src/lib/setupCommands.ts`:

```ts
setupDetectBlackhole(): Promise<BlackHoleStatus>
setupInstallBlackhole(): Promise<InstallReport>
setupConfigureMultiOutput(subDeviceUids: string[]): Promise<ConfigureMultiOutputResult>
setupVerifyCapture(deviceHint: string, durationMs: number): Promise<VerifyReport>
```

5 vitest cases (`setupCommands.test.ts`) lock command-name strings + camelCased arg shapes against the Rust side (renaming any one trips the test).

## Part C — App.tsx wizard mount (R-W.7, this commit)

### Conditional render

After all hooks have settled (rules-of-hooks compliant), App.tsx returns the wizard branch when `setupCompleted=false`:

```ts
if (!setupCompleted) {
  return <SetupWizard invokers={wizardInvokers} onDone={onWizardDone} />;
}
return <main>{ /* meeting UI */ }</main>;
```

The wizard is **not** wrapped in a portal/overlay — it replaces the App shell entirely until completion. This matches the wizard's `role="dialog" aria-modal="true"` semantics (`SetupWizard.tsx:184–187`) and avoids focus-trap edge cases that a half-overlay would create.

### Invoker adapters

The wizard's `SetupWizardInvokers` shape (`SetupWizard.tsx:27–32`) does not match the `setupCommands.ts` wrappers 1:1, so App.tsx provides four adapters via `useMemo`:

| Wizard expectation | App-side adapter |
|---|---|
| `detect()` | direct `setupDetectBlackhole()`; result cached in `detectStatusRef` so `configure()` can reuse the BlackHole UID |
| `install(onLine)` | direct `setupInstallBlackhole()`; the `onLine` callback is intentionally unused — brew streaming is a Phase-W follow-up (`helper_daemon::install_via_brew` blocks until cask completion; no Tauri events are emitted yet) |
| `configure()` | reads `detectStatusRef.current.blackhole_uid` (when present) and forwards as the single-element `subDeviceUids` arg; renames `device_id` → `deviceId` for the wizard's reducer |
| `verify(deviceId)` | `deviceId` is currently unused — the Rust side resolves the input device by hint string (`"blackhole"`); future revision can add a numeric-deviceId fast-path |

Constants `SETUP_VERIFY_DURATION_MS = 5_000` + `SETUP_VERIFY_DEVICE_HINT = "blackhole"` mirror the wizard copy and the helper-daemon's `verify_capture` 5-second window (R-W.4 `crates/audio-capture/src/verify.rs:298`).

### onDone persistence

```ts
const onWizardDone = useCallback(() => {
  setSetupCompleted(true);
}, [setSetupCompleted]);
```

`setSetupCompleted` is the Zustand setter from R-W.5; it writes through to `localStorage` (best-effort, swallowed on quota/security errors per the settings-store invariant). On the next render the `if (!setupCompleted)` branch evaluates false and the wizard unmounts.

## RTL Integration Tests (4)

`src/App.test.tsx` mocks `SetupWizard` to a click-driven stub so the App-level mount gate is the unit under test. The wizard's own FSM is covered by `SetupWizard.test.tsx` (12 RTL cases).

| ID | Name | What it asserts |
|---|---|---|
| WT-1 | `app_renders_wizard_when_setup_incomplete` | `setupCompleted=false` (default) → `<SetupWizard>` in DOM, "Meeting Copilot" h1 absent |
| WT-2 | `app_skips_wizard_when_setup_completed_true` | `setupCompleted=true` at mount → wizard not rendered, meeting UI visible |
| WT-3 | `app_persists_setup_completed_to_settings_store_after_done` | Click stub Done → `useSettingsStore.getState().setupCompleted === true`, wizard unmounted, meeting UI visible |
| WT-4 | `re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui` | Toggle gate back to `false` → wizard re-mounts → second onDone restores meeting UI without throwing |

Mocks (lowest-layer, applied via `vi.mock` before the App import):

- `@tauri-apps/api/core` — `invoke()` returns `[]` for `load_meetings`, `undefined` for everything else (`useMeetingPersist` pulls past meetings on mount; an undefined response would crash `PastMeetings.tsx`)
- `@tauri-apps/api/event` — `listen()` returns a no-op unlisten; `useTranscriptStream` never receives an event
- `@anthropic-ai/sdk` — fake constructor + empty `messages.stream()` so `useAskClaude` import doesn't reach the network

## Acceptance Criteria

- [x] `setupCompleted: boolean` field present in `SettingsValues` with default `false` (R-W.5)
- [x] `coerceLoaded` zero-fills missing key to `false` for migrating users (R-W.5)
- [x] 4 Tauri commands registered + invoked under canonical snake_case names (R-W.6)
- [x] Typed JS wrappers expose 1:1 typed surfaces (R-W.6)
- [x] App.tsx mounts wizard iff `setupCompleted=false` (R-W.7)
- [x] Wizard `onDone` flips the persisted flag and unmounts the wizard (R-W.7)
- [x] 4 RTL tests green (`bun test src/App.test.tsx`) (R-W.7)
- [x] Full vitest suite ≥ 938 (target was 934 + 4 new); landed at **952** total (R-W.7)
- [x] `bun run typecheck` exits 0 (R-W.7)
- [x] No regression in `src/__tests__/E2E.test.tsx` — those tests pre-flip the gate to `true` so they see the meeting UI directly

## Constraints & Carry-Forward

- **No `git push`** — local-only commits per fix-loop rule.
- **Migration safety** — existing users with v1/v2 settings payloads pre-T-W.7 see the wizard once on next launch (acceptable; the FSM short-circuits if BlackHole is already configured).
- **brew streaming** — `onLine` callback ignored; Phase-W follow-up FFI work covers Tauri-event-based streaming (`helper-daemon` would emit `install:line` events).
- **Configure UID picker** — App.tsx forwards the BlackHole UID from the cached detect status; a richer UID picker (multi-select speakers) is a future UX iteration.
- **Verify deviceId fast-path** — currently the wizard hands `multi_output_id` into the verify invoker but App.tsx ignores it; Rust resolves by hint string. Adding a numeric-deviceId variant of `setup_verify_capture` would skip the cpal enumerate scan.
- **Re-run from Settings** — WT-4 asserts the regression-safety of toggling the flag back; the user-visible Settings affordance is a follow-up UI task (the store seam is already in place).
