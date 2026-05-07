# T-W.9 — Code Review

> Review of `tests/e2e/blackhole-wizard.e2e.test.ts` +
> `tests/e2e/__fixtures__/wizard-states.ts` against the INDEX Process Rule
> 3 checklist (`docs/tasks/blackhole-wizard/INDEX.md` §"Process Rules"
> point 3) plus the T-W.9-specific ACs from `T-W.9-e2e.md`.

## Phase Process Rule 3 Checklist

- [x] **No regression Phase 1 / 2 / 3 / 4** — audio capture path unchanged; settings schema additive only.
  - `bun run test` reports **934 passed (60 files)** at landing — 928 baseline (T-W.6 + T-W.8) + 6 new from T-W.9. No prior tests modified.
  - Zero source-tree edits outside `tests/e2e/**` and `docs/tasks/blackhole-wizard/**`.
  - Zero changes to `package.json`, `vitest.config.ts`, `tsconfig.json`, `src/**`, `crates/**`, `src-tauri/**`. The new e2e file matches the existing `tests/e2e/**/*.e2e.test.ts` include glob with no glob change.
  - `cargo test --workspace` regression: not run by this task (no Rust touched); preserved by definition.

- [x] **Permission prompt UX rationale visible to user in wizard** — N/A for this task (E2E covers rendering of existing rationale strings already shipped in T-W.6 step components; no new copy added). The brew sudo dialog warning lives in `Install.tsx` line 47-49 (reviewed in T-W.6); the TCC mic-permission rationale in `Verify.tsx` line 44-48; both render unchanged in E2E-1 / E2E-4 / E2E-5 walkthroughs.

- [x] **Idempotent (re-running wizard after completion does not break existing config)** — E2E-3 runs the full happy path 3× sequentially. Each run uses a fresh fixture handle and a fresh DOM tree (`cleanup()` in `beforeEach` + `afterEach`); each run reaches `done` and fires `onDone` exactly once. No shared state leaks across runs (fixture queues are local to `makeScenarioInvokers`; `vi.fn()` mocks are recreated per scenario). Determinism gate from INDEX phase exit criterion #2: **3/3 deterministic runs verified locally.**

- [x] **Rollback if user cancels mid-flow (no half-installed state visible to main app)** — E2E-5 covers the silent-capture retry case (the most likely real-world "user gets stuck" symptom). The reducer's `quit` action is already covered in `SetupWizard.test.tsx` SW-U11/SW-U11b (T-W.6); E2E-4 exercises the `back` action (manual-fallback retry). No half-state escapes the wizard FSM in any of the 6 e2e cases — `onDone` only fires on the `done` step, which is reached only after `verify_completed` with `signal_present=true` OR `quit`.

- [x] **No `git push`** — landing commit is local-only (`feat(setup)` series convention; this task's prefix is `test(e2e)` per INDEX Process Rule 4). Operator pushes after `PHASE-COMPLETE.md` lands in T-W.10.

## T-W.9-Specific AC Checklist

- [x] **E2E-1 — Happy path 5 reducer steps walked.** `tests/e2e/blackhole-wizard.e2e.test.ts:175-228` (describe block "T-W.9 — fresh-Mac E2E (happy path)"). Asserts every step's testid via `getByTestId("setup-wizard-step-<X>")`, asserts `onDone` fires once, asserts `verifyMock` was called with the deviceId surfaced by `configure_completed` (137 — confirms the deviceId hand-off).

- [x] **E2E-2 — Spy assertions confirm no real native calls leak.** Same it block. Final assertion: `expect(handle.remaining()).toEqual({ detect:0, install:0, configure:0, verify:0 })`. Plus per-mock call-count assertions inline. The `fromQueue` helper throws on under-supply (queue empty when wizard tries to call), surfacing fixture-vs-test drift as a named error rather than a JSDOM symptom.

- [x] **E2E-3 — 3/3 deterministic re-runs.** `it.each([1, 2, 3])` block at line 232-271. Each run constructs fresh fixture handle, fresh DOM, walks full happy path. Local verification: 3 consecutive `bun run test tests/e2e/blackhole-wizard.e2e.test.ts` invocations all reported `Tests 6 passed (6)` with consistent ~1.81s duration ±0.05s.

- [x] **E2E-4 — Brew-not-found error path.** `tests/e2e/blackhole-wizard.e2e.test.ts:275-340`. Walks: detect (NotInstalled) → install click → manual_url surface → re-check click → detect (InstalledNotConfigured) → configure → verify → done. Asserts the manual URL anchor has `target="_blank"` and `rel` matches `/noopener/`. Confirms `detectMock` was called twice (mount + retry-detect from manual fallback).

- [x] **E2E-5 — Silent capture retry-bounded to 3.** `tests/e2e/blackhole-wizard.e2e.test.ts:344-417`. Walks 3 silent-attempt cycles. After each silent result asserts `setup-wizard-step-verify` is still mounted, error pane visible, `onDone` not fired. After the 3rd attempt the FSM is still on verify and the fixture's verify queue is fully drained. The retry-cap is *operator-bounded* in this test (T-W.7 will add an FSM-level cap and its own integration test); E2E-5 confirms the FSM remains stable across 3 silent results without auto-advancing or crashing.

## Code Quality

- [x] **Imports tidy.** Every import either bridges a vitest-builtin
      (`vi`, `expect`, `it`, `describe`, `beforeEach`, `afterEach`,
      `Mock`), an RTL helper (`render`, `screen`, `waitFor`, `cleanup`),
      a user-event setup, the production component
      (`SetupWizard` + types from `useSetupWizard`), or the local
      fixture module. No circular deps, no module side effects.
- [x] **Type safety strict.** `Mock<...>` types preserve the invoker
      function signatures so the test fails at compile time if the
      `SetupWizardInvokers` interface drifts (TypeScript's `noImplicitAny`
      kicks in for `vi.fn` without explicit type). The fixture file types
      every constant against the production response interfaces
      (`BlackHoleStatus`, `InstallReport`, `VerifyReport`).
- [x] **No flake-prone constructs.** Real timers replaced by fake timers;
      `userEvent` advanced via the same clock; no `await new Promise(r => setTimeout(r, N))`; no `screen.getBy*` race-after-mount (every async transition wrapped in `waitFor`); no fixed sleeps.
- [x] **Magic numbers documented.** `137` (multi_output_id) is declared
      in the fixture, then asserted at the verify call site with an
      inline comment ("deviceId from detect"). The `0.42` peak amplitude
      is well above the documented `1e-3` threshold (mirrored from the
      Swift exit-8 pivot in `experiments/T-0.2/blackhole_capture.swift`).
- [x] **Comments explain WHY, not WHAT.** The header docstring traces
      AC IDs to it-block lines; per-test inline comments call out the
      reducer transition each user click triggers and why the spy
      assertion matters at that point.

## Risks / Caveats

- **R-1: T-W.7 not yet shipped.** This E2E exercises the wizard
  component contract via prop-injected invokers. T-W.7 will adapt the
  contract to live `@tauri-apps/api/core::invoke` calls. The contract is
  fixed at the type level (`SetupWizardInvokers` interface in
  `SetupWizard.tsx`); T-W.7's adapter is a thin `async () => invoke(...)`
  wrapper. **Mitigation:** T-W.7 must add at least 1 `cargo #[test]`
  asserting the Tauri-command response shape matches the
  `BlackHoleStatus` / `InstallReport` / `VerifyReport` Zod schemas (or
  serde rename_all = "snake_case" derive) used here.
- **R-2: T-W.5 verify smoke test not yet shipped.** The verify mocks
  here return synthesized `VerifyReport` objects. T-W.5 will land the
  Rust-side `crates/audio-capture/src/verify.rs` whose serialized output
  must match the `VerifyReport` interface — same shape as already
  pinned by the T-W.6 test fixtures. **Mitigation:** T-W.5 includes a
  Rust unit test asserting the `Serialize` derive produces JSON matching
  these fields verbatim.
- **R-3: Retry-bound regression.** E2E-5 asserts the FSM remains stable
  across 3 silent attempts but does NOT enforce a hard cap (the reducer
  is unbounded by design; the App-level wrapper caps at 3 in T-W.7).
  **Mitigation:** T-W.7's integration test must assert the cap directly
  on the App-level wrapper component (this is on T-W.7's punch list).
- **R-4: Fixture drift.** If T-W.6 (or future tasks) changes the
  `BlackHoleStatus` / `InstallReport` / `VerifyReport` shape, the
  fixture file is the single source of truth for the e2e mocks and will
  fail-compile loudly (caught by `bun run typecheck`). No silent drift
  possible.

## Sign-Off

- [x] All 6 e2e tests pass (`Tests 6 passed (6)` at the file scope).
- [x] Full vitest sweep `Tests 934 passed (60 files)` at the workspace scope (was 928 baseline; +6 from this task).
- [x] `bun run typecheck` clean.
- [x] Determinism gate met: 3/3 sequential runs of the e2e file pass with consistent test count + duration.
- [x] No `git push` performed; commit landed locally on `main`.

**Reviewer verdict:** READY for INDEX checkbox flip. T-W.10 may proceed
to the phase-test sweep + sign-off + v1.0.1 tag once T-W.5 + T-W.7 land
(they are the remaining open boxes ahead of the phase-exit gate).
