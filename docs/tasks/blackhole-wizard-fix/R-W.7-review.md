# R-W.7 — Review (App.tsx wizard mount + RTL integration)

> **Commit:** _set after commit lands_ (this iteration). Loop step 5/8.
> **Spec:** `docs/tasks/blackhole-wizard/T-W.7-integration.md` (umbrella for T-W.7 parts A/B/C across R-W.5/R-W.6/R-W.7).
> **Files touched:**
> - `src/App.tsx` — wizard mount gate + invoker adapters (~50 LOC)
> - `src/App.test.tsx` — NEW; 4 RTL integration tests (~165 LOC)
> - `src/__tests__/E2E.test.tsx` — pre-flip `setupCompleted=true` to skip the wizard (1 store seam in `beforeEach` + 1 import)
> - `docs/tasks/blackhole-wizard/T-W.7-integration.md` — NEW spec (~140 LOC markdown)
> - `docs/tasks/blackhole-wizard-fix/R-W.7-review.md` — this file

## What changed

1. **App.tsx** now reads `useSettingsStore((s) => s.setupCompleted)` and renders `<SetupWizard invokers={…} onDone={…} />` instead of the meeting UI when the flag is `false`. The conditional render lives **after** all hook calls (rules-of-hooks compliant).
2. Four invoker adapters bridge the wizard's `SetupWizardInvokers` shape to the typed `setupCommands` wrappers from R-W.6:
   - `detect`: caches the result in a `detectStatusRef` so `configure` can forward the `blackhole_uid`.
   - `install`: ignores the `onLine` callback (brew streaming is a Phase-W follow-up).
   - `configure`: reads the cached BlackHole UID and forwards as the single-element `subDeviceUids` arg.
   - `verify`: forwards the device hint `"blackhole"` and a 5_000 ms window (the wizard's deviceId arg is currently unused).
3. **App.test.tsx** is new — 4 RTL integration cases (WT-1..WT-4) covering the gate-flag transitions. The wizard component itself is mocked to a click-driven stub so the App-level mount logic is the unit under test.
4. **E2E.test.tsx** pre-flips `setupCompleted=true` in `beforeEach` so the existing happy-path tests still see the meeting UI shell. Without this, the new wizard gate would short-circuit them.

## What tests cover it

| Test | Suite | Asserts |
|---|---|---|
| WT-1 | `src/App.test.tsx` | `setupCompleted=false` → wizard rendered, meeting UI hidden |
| WT-2 | `src/App.test.tsx` | `setupCompleted=true` → wizard skipped, meeting UI shown |
| WT-3 | `src/App.test.tsx` | wizard onDone → store flag flips → wizard unmounts → meeting UI mounts |
| WT-4 | `src/App.test.tsx` | toggle flag back → wizard re-mounts → second onDone restores meeting UI |
| (existing) | `src/components/SetupWizard/SetupWizard.test.tsx` | 12 RTL cases (FSM internals, untouched) |
| (existing) | `src/store/settingsStore.test.ts` | persistence + `coerceLoaded` zero-fill (R-W.5) |
| (existing) | `src/lib/setupCommands.test.ts` | 5 cases for command-name + arg shapes (R-W.6) |

## Sign-off checklist (from `docs/tasks/blackhole-wizard-fix/INDEX.md` §Process Rules)

- [x] No regression vitest ≥ 934 (wizard v1.0.1 baseline) — full sweep landed at **952** (62 files), zero failures.
- [x] `cargo test --workspace` ALL GREEN — covered by R-W.4 (no Rust changes in this commit).
- [x] No `git push` performed.
- [x] Idempotent — WT-4 asserts re-running the wizard after a prior completion does not break the meeting UI.
- [x] `setupCompleted` field migration safe — default `false`, `coerceLoaded` zero-fills missing keys (covered in R-W.5; this commit only consumes the field).

## Why this approach

- **Replace, don't overlay.** The wizard already declares `role="dialog" aria-modal="true"`. Layering the meeting UI underneath would duplicate scrollable surfaces and create focus-trap edge cases. Replacing the App body until completion is simpler and matches the wizard's existing semantics.
- **Stub the wizard in App.test.tsx.** The wizard's FSM has 12 RTL cases of its own; re-asserting them here would duplicate work and bloat the suite. App.test.tsx is the gate-flag test, not the wizard test.
- **Adapt at the App layer.** The wire-format wrappers (`setupCommands.ts`) own the Tauri shape; the wizard owns its UI shape. Adapters in App.tsx are the natural hinge. They also keep `setupCommands` reusable for any future settings affordance ("re-run setup wizard from Settings") without dragging in wizard-shaped types.
- **Pre-flip in E2E tests.** The E2E tests are not testing wizard gating — they are testing the meeting UI happy-path. Skipping the wizard there is the correct scope decision; WT-1..WT-4 cover the gate explicitly.

## Risks & follow-ups

- **brew streaming.** `install(onLine)` is currently a no-op. Long brew installs (~30–90 s) will show an empty log mid-install. Phase-W follow-up: have `helper_daemon::install_via_brew` emit Tauri events that the App invoker forwards into `onLine`.
- **Configure UID picker.** App.tsx forwards a single UID (the BlackHole UID from detect). A richer UX would let the user pick a destination speaker; the wire format already supports it (`subDeviceUids: string[]`).
- **Re-run from Settings.** WT-4 asserts the gate-toggle works end-to-end, but the user-visible Settings button is not yet implemented. A small SettingsSheet addition would expose `setSetupCompleted(false)` to the user.
- **Verify deviceId fast-path.** The wizard plumbs `multi_output_id` through the verify invoker but the current `setup_verify_capture` resolves by hint string. Adding a numeric-deviceId fast-path would skip the cpal enumerate scan; not blocking.
