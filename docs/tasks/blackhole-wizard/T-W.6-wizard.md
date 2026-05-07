# T-W.6 — Onboarding Wizard UI (5-step Tauri component) — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.6.
> **Locks against**: `docs/blackhole-wizard-design.md` §4 "Wizard FSM" (5-step `useReducer` state machine; quit-wizard escape hatch sets `setupCompleted=true`) + §7 happy-path sequence diagram.
> **Reference impl**: `src/components/SettingsSheet.tsx` (Phase 3 T-3.6 prop-injected test seam pattern — `testConnection?: TestConnectionFn`); `src/store/meetingStore.ts` (Phase 1 reducer-shape with closed action union); `src/components/ContextLoader.test.tsx` (Phase 1 `vi.mock("@tauri-apps/api/core")` invoke pattern reused here through prop injection instead).
> **Depends on**: T-W.2 (`BlackHoleStatus` 4-variant enum — wizard short-circuit branch reads it), T-W.3 (`InstallReport` shape — brew_found + manual_url for fallback UI), T-W.4 (`ConfigureError` text surfaces in error pane; wizard never re-implements the configure logic), T-W.5 (`VerifyReport` shape — peak_amplitude, signal_present, duration_ms_actual, callback_count).
> **Blocks**: T-W.7 app-startup integration (mounts `<SetupWizard invokers={…}/>` with the live `@tauri-apps/api/core::invoke` adapter; flips `settingsStore.setupCompleted` on the `onDone` callback), T-W.9 e2e fresh-Mac simulation (drives the same prop-injected invoker surface — no Tauri runtime).

---

## 1. Goal

Ship the **wizard UI layer** for the BlackHole Setup Wizard: a 5-step React state machine that walks a fresh-Mac user from `welcome → detect → install → configure → verify → done` against four prop-injected invokers (the Tauri command surface T-W.7 wires up). The reducer is pure (no Tauri calls, no I/O, no timers) so 14 reducer-isolation tests + 13 RTL container tests can run under jsdom without spinning up the helper-daemon. The container holds the side-effect `useEffect` blocks keyed off `state.step + state.retryCount`.

Concretely, T-W.6 lands:

1. `src/components/SetupWizard/useSetupWizard.ts` — **pure reducer + hook** + 4 public types (`BlackHoleStatus`, `VerifyReport`, `InstallReport`, `WizardState`) + 18-variant action union (`continue`, `detect_started`, `detect_result`, `detect_failed`, `install_started`, `install_progress`, `install_completed`, `install_failed`, `configure_started`, `configure_completed`, `configure_failed`, `verify_started`, `verify_completed`, `verify_failed`, `retry`, `back`, `quit`). Closed union; reducer's default arm is `never` so adding a variant without a matching case is a compile error.
2. `src/components/SetupWizard/SetupWizard.tsx` — **container component** holding the `useEffect` side effects (auto-fire detect on entry, explicit-click install / configure / verify, finalize on `done` via `onDone`). Accepts `SetupWizardInvokers` as a prop so tests inject mocks; T-W.7 wraps it with the live `invoke<>(…)` adapter.
3. Five **step components** — `Welcome.tsx`, `Detect.tsx`, `Install.tsx`, `Configure.tsx`, `Verify.tsx` — each pure render-only. Step copy + a11y attributes mirror design §4 (4-row checklist for Detect, brew log `<pre aria-live=polite>` for Install, peak meter for Verify).
4. **14 reducer-isolation tests** + **13 RTL container tests** = 27 total. Reducer tests cover the closed action union exhaustively (every variant + the off-step no-op guard); RTL tests cover the user-visible behavior (welcome→detect transition, short-circuit branch, install streaming, manual fallback URL with `target=_blank rel=noopener`, configure error surface, verify silent retry, quit-wizard escape from welcome AND mid-flow, modal a11y `role=dialog aria-modal=true`).
5. Zero new npm deps. The wizard re-uses Phase 1–4's `react@^18.3.1` + `@testing-library/react@^16.3.2` + `@testing-library/user-event@^14.6.1` already pinned. No `@tauri-apps/api/core` import in the test files (prop injection instead — same pattern as Phase 3 `SettingsSheet.test.tsx` `testConnection` seam).

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | `src/components/SetupWizard/useSetupWizard.ts` exists exporting `setupWizardReducer`, `useSetupWizard`, `nextStepForDetect`, `INITIAL_WIZARD_STATE`, plus types `WizardState`, `WizardAction`, `WizardStep`, `BlackHoleStatus`, `VerifyReport`, `InstallReport`. | ✅ landed this commit |
| AC-2 | `src/components/SetupWizard/SetupWizard.tsx` exists exporting `SetupWizard` (default UI surface) + `SetupWizardInvokers` interface (4 methods: `detect`, `install(onLine)`, `configure`, `verify(deviceId)`). | ✅ |
| AC-3 | 5 step components exist: `Welcome.tsx`, `Detect.tsx`, `Install.tsx`, `Configure.tsx`, `Verify.tsx`. Each is pure render-only (no `useState` for step-local logic; container owns all state). | ✅ |
| AC-4 | Reducer is pure: zero side effects, zero timers, zero `invoke()` calls. Verified by `grep -E "invoke\\b\|setTimeout\|fetch\\(" src/components/SetupWizard/useSetupWizard.ts` returning empty. | ✅ |
| AC-5 | Reducer's `default` arm is exhaustive — `const _exhaustive: never = action;` catches a missing variant at compile time. Adding a 19th variant without a matching case is a TS error. | ✅ |
| AC-6 | 14 reducer-isolation tests under `useSetupWizard.test.ts`. Cover SW-R1..SW-R14 per §3 below. All green under `bun run test` (vitest 4.1.5). | ✅ |
| AC-7 | 13 RTL container tests under `SetupWizard.test.tsx` (12 INDEX-mandated cases + SW-U11b sentinel for mid-flow quit). Cover SW-U1..SW-U12 per §3 below. All green under `bun run test`. | ✅ |
| AC-8 | Manual-URL link uses `target="_blank"` AND `rel` containing `noopener`. SW-U6 asserts both attributes (R-2 carry-forward from Phase 4 deeplink-injection review). | ✅ |
| AC-9 | Container root has `role="dialog"` + `aria-modal="true"` (focus-trap surface — design §6 R-W.4 mitigation for keyboard accidentally driving the main app). SW-U12 asserts both. | ✅ |
| AC-10 | Quit-wizard from `welcome` does NOT invoke `detect` (no wasted CoreAudio call when the user already knows they have a custom setup). SW-U11 asserts `detectMock.toHaveBeenCalledTimes(0)`. | ✅ |
| AC-11 | Verify with `signal_present=false` does NOT advance to `done` and does NOT fire `onDone`. The reducer surfaces an error pane + a Try-again button (SW-R10 + SW-U10). | ✅ |
| AC-12 | TypeScript clean: `bun run typecheck` exits 0. No `any` casts in the wizard code surface. | ✅ |
| AC-13 | No regression Phase 1–4: `bun run test` reports 928/928 passing (was 900 before T-W.6 — +28 new tests, zero deletions). | ✅ |

---

## 3. TDD Plan

T-W.6 ships **27 tests total** = 14 reducer-isolation + 13 RTL container. The reducer tests are pure-function (no jsdom, no DOM); the RTL tests use jsdom + `@testing-library/react` + prop-injected mock invokers.

### 3.1 Reducer-isolation tests (`useSetupWizard.test.ts`)

| # | Test name | Covers |
|---|---|---|
| SW-R1 | `initial state is welcome / not pending / no error` | Initial state shape — INITIAL_WIZARD_STATE. |
| SW-R2 | `continue from welcome advances to detect` | welcome → detect. |
| SW-R3 | `detect_result NotInstalled → install` | Branch: `not_installed` → install. |
| SW-R4 | `detect_result InstalledNotConfigured → configure (skips install)` | Branch: `installed_not_configured` → configure. |
| SW-R5 | `detect_result Configured → verify (short-circuit; lifts deviceId)` | Branch: `configured` → verify; lifts `multi_output_id` to state for verify reuse. |
| SW-R6 | `install_completed brew_found=true → configure` | Happy path: brew installed → advance. |
| SW-R7 | `install_completed brew_found=false → stay install + surface manual URL` | Manual fallback: stay on step, expose `installReport.manual_url`. |
| SW-R8 | `configure_completed → verify (carries deviceId)` | configure → verify; deviceId threading. |
| SW-R9 | `verify_completed signal_present=true → done` | Happy path: signal real → done. |
| SW-R10 | `verify_completed signal_present=false → stay verify + error` | Silent capture: stay on verify, surface error (Swift exit 8 mirror). |
| SW-R11 | `quit from any step → done (escape hatch)` | Escape valve from welcome / detect / install / configure / verify — all 5 origins → done. |
| SW-R12 | `retry clears error + bumps retryCount` | Retry contract: error cleared, counter incremented (so the side-effect `useEffect` re-fires). |
| SW-R13 | `actions are ignored when step doesn't match (defensive no-op)` | Off-step guard: late-arriving promise (e.g. install_completed) does NOT teleport from welcome to configure. |
| SW-R14 | `install_started clears prior log + report (per-attempt scope)` | Re-attempt scope: stale brew lines from a prior failed attempt do not bleed into the new attempt. |

Plus 1 extra: `nextStepForDetect maps every BlackHoleStatus variant to a single step` (pure-fn test, exhaustiveness sentinel).

### 3.2 RTL container tests (`SetupWizard.test.tsx`)

12 INDEX-mandated cases + 1 sentinel (SW-U11b for mid-flow quit). All use the `makeInvokers()` helper that returns `Mock`-backed `detect`/`install`/`configure`/`verify`.

| # | Test name | Covers |
|---|---|---|
| SW-U1 | `welcome renders Continue button + Skip link; Continue advances to detect step` | Welcome → detect transition. Uses a deferred detect promise so the assertion sees the `detect` step before it auto-advances. |
| SW-U2 | `detect auto-fires on mount; NotInstalled → advances to install` | Detect side-effect; transition through DOM. |
| SW-U3 | `detect Configured → skips install + configure; lands on verify` | Short-circuit branch: assert `install` and `configure` were NEVER mounted; `configure` invoker NEVER called. |
| SW-U4 | `detect rejection surfaces error pane; retry re-runs the invoker` | Error path + retry semantics. Mock returns reject-once + resolve-once — assert 2 calls + advance to install. |
| SW-U5 | `install streams brew lines into the log <pre>` | Streaming via `onLine` callback; brew_found=true advances. |
| SW-U6 | `brew_found=false renders manual URL link with target=_blank rel=noopener; stays on install` | Manual fallback rendering + R-2 anchor-rel safety. |
| SW-U7 | `clicking Configure invokes the configure command and advances on success` | Configure click → invoker called → verify step. |
| SW-U8 | `configure rejection renders alert; FSM stays on configure` | Error path scoped to step (no auto-quit). |
| SW-U9 | `verify with signal_present=true → done + onDone fires` | Happy path tail: deviceId threaded from detect, onDone fires once. |
| SW-U10 | `verify silent → error + Try again button → retry stays on verify` | Silent-capture UX: error pane + dedicated retry button + retry clears error. |
| SW-U11 | `clicking Skip from welcome fires onDone (escape valve)` | Escape valve at welcome — detect NEVER called. |
| SW-U11b | `clicking Skip from install also fires onDone` | Escape valve mid-flow — sentinel for design §4 "any-step quit". |
| SW-U12 | `root has role=dialog and aria-modal=true (focus-trap surface)` | A11y modal contract; focus-trap delegated to T-W.7 wrapper. |

### 3.3 Test seams

- **`makeInvokers()`** — factory returning a `SetupWizardInvokers` impl that delegates each call to a `vi.fn()`. The Mocks are exposed on the same object as `detectMock` / `installMock` / `configureMock` / `verifyMock` so the test body can `mockResolvedValue(...)` / `mockRejectedValueOnce(...)` / `mockImplementation(...)` per case.
- **`@vitest-environment jsdom`** pragma at the top of `SetupWizard.test.tsx` (mirrors Phase 1/3 component tests). The reducer test file is plain Node — no jsdom needed.
- **No `@tauri-apps/api/core` mock** — the invokers prop is the test seam. T-W.7 will swap the prop default for the real adapter; T-W.7's tests will then mock `@tauri-apps/api/core` once at the App boundary.

---

## 4. Diff Plan

| File | Verb | Diff |
|---|---|---|
| `src/components/SetupWizard/useSetupWizard.ts` | NEW | ~280 LOC: 4 public types, 18-variant action union, `setupWizardReducer` (12 case arms + quit guard + exhaustive default), `nextStepForDetect`, `previousStep`, `INITIAL_WIZARD_STATE`, `useSetupWizard` hook. |
| `src/components/SetupWizard/SetupWizard.tsx` | NEW | ~190 LOC: container + 4 `useEffect` blocks (one per step's side effect) + `errorMessage` helper + done-state render branch. |
| `src/components/SetupWizard/Welcome.tsx` | NEW | ~50 LOC: render-only step. |
| `src/components/SetupWizard/Detect.tsx` | NEW | ~95 LOC: render-only step + 3-row checklist `checklistRowsFor`. |
| `src/components/SetupWizard/Install.tsx` | NEW | ~110 LOC: render-only step + manual-URL fallback block. |
| `src/components/SetupWizard/Configure.tsx` | NEW | ~70 LOC: render-only step. |
| `src/components/SetupWizard/Verify.tsx` | NEW | ~95 LOC: render-only step + peak meter. |
| `src/components/SetupWizard/useSetupWizard.test.ts` | NEW | ~210 LOC: 14 reducer tests + 1 helper-fn test + 4 step-state factory helpers. |
| `src/components/SetupWizard/SetupWizard.test.tsx` | NEW | ~420 LOC: 13 RTL tests + `makeInvokers` factory. |
| `docs/tasks/blackhole-wizard/T-W.6-wizard.md` | NEW | This file. |
| `docs/tasks/blackhole-wizard/T-W.6-review.md` | NEW | Review checklist (sibling file). |
| `docs/tasks/blackhole-wizard/INDEX.md` | EDIT | T-W.6 row checkbox `[ ]` → `[x]` with outcome line. |

**No edits to**: `package.json` (zero new deps), `vitest.config.ts`, `tsconfig.json`, any Phase 1–4 source file.

---

## 5. Permission UX Inventory (this task's contribution)

Per design §5, the wizard's three pre-warning copy strings are surfaced from these step components:

| # | Prompt | Step component | Pre-warning copy location |
|---|---|---|---|
| 1 | Microphone (TCC) modal | `Verify.tsx` | "macOS will ask for microphone access in a moment. We need this to capture audio (mic + system) — both go through the microphone TCC bucket on macOS 14+." |
| 2 | Sudo / admin (osascript) | `Install.tsx` | "You may see a macOS password prompt — that's Homebrew running the BlackHole installer. Type your login password to continue." |
| 3 | Default-output change | (deferred to T-W.7 stretch goal) | "Click 'Use for this meeting' to route system audio through the Multi-Output Device. Your Mac will return to its previous output device when Meeting Copilot quits." |

Permission prompt #3 is documented in design §3 as opt-in and lives in T-W.7 (or T-W.10 release notes). T-W.6 does NOT render the "Use for this meeting" button.

---

## 6. Risk Posture (this task's contribution)

T-W.6 mitigates three Phase-W risks directly:

- **R-W.4 — TCC re-prompt across helper-daemon respawn.** The wizard's `verify` step does NOT spawn a new subprocess; it dispatches to the existing helper-daemon's in-process Rust verify capture. This is enforced at the prop-injected boundary: the `invokers.verify(deviceId)` contract is a single async call, not a subprocess factory. T-W.7's adapter wires this to the live `@tauri-apps/api/core::invoke("setup_verify_capture")` which runs in the main Tauri process.
- **R-W.5 — Brew sudo cancel race.** The Install step renders the brew log via `<pre aria-live=polite>` so stderr lines stream live; on `install_failed` the manual URL fallback is rendered within the SAME step (no need to restart the wizard). SW-U6 asserts the fallback rendering.
- **R-W.6 — macOS API drift.** The wizard does not hard-code any CoreAudio API surface; it talks to the Tauri command surface. If a future macOS deprecates `kAudioAggregateDeviceIsStackedKey`, only T-W.4's Rust code needs to change — the wizard still walks the same 5 steps.

Plus one wizard-specific risk handled here:

- **Wizard re-mount on every cold-start until `setupCompleted=true`.** The container's `useEffect([state.step])` for `onDone` fires once when state transitions to `done`. The parent (T-W.7) is responsible for persisting `setupCompleted=true` to settings. If persist fails, the wizard re-prompts on next launch — a feature, not a bug, until the user successfully verifies.

---

## 7. Hand-Off Notes for Downstream Tasks

- **T-W.7 app-startup integration** (`src/App.tsx` + `src-tauri/src/lib.rs`):
  - Mount `<SetupWizard invokers={liveInvokers} onDone={() => setSetupCompleted(true)} />` as a modal overlay above the existing main UI, conditional on `settingsStore.setupCompleted === false`.
  - Build `liveInvokers`:
    ```ts
    import { invoke } from "@tauri-apps/api/core";
    const liveInvokers: SetupWizardInvokers = {
      detect: () => invoke<BlackHoleStatus>("setup_detect_blackhole"),
      install: (onLine) => invoke<InstallReport>("setup_install_blackhole"), // streaming TBD via Tauri events
      configure: () => invoke<{ deviceId: number }>("setup_configure_multi_output"),
      verify: (deviceId) => invoke<VerifyReport>("setup_verify_capture", { deviceId }),
    };
    ```
  - Add `setupCompleted: boolean` (default `false`) to `SettingsValues` in `src/store/settingsStore.ts` with the same `coerceLoaded` zero-fill pattern as `telemetryEnabled` (Phase 3 T-3.9).
- **T-W.7 streaming `install` lines**: pure `invoke<>` does NOT stream stdout. Either use `@tauri-apps/api/event::listen("setup_install_progress", …)` (preferred — matches the helper-daemon's `tokio::sync::mpsc` channel from T-W.3) or have the Rust command return the full report after completion (logs visible only post-completion). The wizard's `install(onLine)` contract supports both — `onLine` simply isn't called in the second mode.
- **T-W.9 e2e fresh-Mac simulation** (`tests/e2e/blackhole-wizard.e2e.test.ts`):
  - Drives the same `SetupWizardInvokers` prop boundary — no Tauri runtime, no real CoreAudio. Reuses `makeInvokers()` shape.
  - Covers: 3/3 deterministic happy-path runs, 2 error paths (brew-not-found + verify-silent retry-loop bounded to 3).
- **T-W.8 `docs/SETUP.md` end-user guide**:
  - Cross-references the 5 step components by their `data-testid` (so screenshot stubs can be filename-anchored to step IDs).
  - The manual-fallback section reproduces the wizard's `https://existential.audio/blackhole/` URL verbatim.

---

## 8. Word Count + Anchor

~1700 words. This task spec is the lock-down point for T-W.6 — T-W.7 e2e + T-W.8 docs cite this spec by section number.
