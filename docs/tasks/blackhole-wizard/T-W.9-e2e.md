# T-W.9 — Fresh-Mac E2E simulation for the BlackHole Setup Wizard

> **Phase:** Phase-W (BlackHole Setup Wizard) post-v1.0 patch.
> **Dep:** T-W.6 (wizard FSM + step components shipped). Note: T-W.5
> (verify smoke test) and T-W.7 (App-startup integration + live Tauri
> commands) are still pending in INDEX — this E2E test is written against
> the prop-injected `SetupWizardInvokers` contract from T-W.6, which is
> exactly the same shape T-W.7 will adapt the live `invoke<>(setup_*)`
> calls to. The test therefore verifies the production wizard FSM
> end-to-end without depending on a Tauri runtime, real CoreAudio, real
> brew, or real `cpal` — same approach as Phase 4 T-4.10 used for the MCP
> dispatch e2e.
> **Out of scope:** real device enumeration, Tauri-command surface
> wrapping (T-W.7), capture stream (T-W.5), version bump + tag (T-W.10).

## Why now

INDEX phase exit criterion #2 mandates: *"T-W.9 E2E test (fresh-Mac
simulation, all CoreAudio + brew calls mocked): wizard walks all 5 steps
to 'All set' green check in ≥ 3/3 deterministic runs."* The wizard ships
in v1.0.1 as the user's first interaction with the app. A flake in the
five-step transition graph manifests as user-visible "the wizard froze on
detect" or "I clicked Install but nothing happened" — UX failures that
would re-introduce the very Phase-0 onboarding friction this whole patch
is meant to remove.

`SetupWizard.test.tsx` (T-W.6) covers each step in isolation — what's
*missing* is a single test that walks the entire reducer transition graph
in the order a fresh-Mac user would, with the install/configure/verify
mock responses queued in scenario-realistic sequence. T-W.9 fills that
gap.

## Scope

- One e2e test file: `tests/e2e/blackhole-wizard.e2e.test.ts`.
- One fixture file: `tests/e2e/__fixtures__/wizard-states.ts`
  (deterministic response sequences for the 4 invoker slots).
- Six test cases covering 5 ACs (E2E-1 through E2E-5).
- Vitest `e2e` glob pattern (per `vitest.config.ts` `tests/e2e/**/*.e2e.test.ts`).
- File extension `.e2e.test.ts` (not `.tsx`) per INDEX-declared filename;
  JSX-bearing component construction uses `React.createElement(...)`.

## Acceptance Criteria

| ID | Description | Verification |
|---|---|---|
| **E2E-1** | Happy path walks 5 reducer steps (welcome → detect → install → configure → verify → done) with `SCENARIO_FRESH_MAC_HAPPY` fixtures. `onDone` fires exactly once. | 1 `it` clicks through all 5 step buttons; `await waitFor` after each transition; final `expect(onDone).toHaveBeenCalledTimes(1)`. |
| **E2E-2** | Spy assertions confirm no real native calls leak. Each invoker is the fixture-backed mock; counters match scenario length; the fixture queue is fully drained at end-of-run. | 4 `expect(handle.<X>Mock).toHaveBeenCalledTimes(N)` + `expect(handle.remaining()).toEqual({ detect:0, install:0, configure:0, verify:0 })`. |
| **E2E-3** | 3/3 deterministic re-runs of the happy path produce identical reducer state and `onDone` call count. | `it.each([1,2,3])(...)` runs the full happy path 3× in sequence with fresh handles per run; each run's spy assertions hold. |
| **E2E-4** | Error path A: brew-not-found → manual URL link rendered with `target=_blank rel=noopener`; FSM stays on install; "I've installed" re-runs detect; flow resumes through configure → verify → done. | 1 `it` walks the install fallback then the resume; asserts `setup-wizard-manual-url` href + attrs; asserts `detectMock.toHaveBeenCalledTimes(2)`. |
| **E2E-5** | Error path B: verify silent × 3. Each silent capture surfaces the error pane and keeps the FSM on verify; after the 3rd attempt the wizard has NOT auto-advanced to done; `onDone` has NOT fired. | 1 `it` clicks Test capture → Try again → Test capture × 3 cycles; final `expect(getByTestId("setup-wizard-step-verify")).toBeInTheDocument()` + `expect(queryByTestId("setup-wizard-step-done")).not.toBeInTheDocument()` + `expect(onDone).not.toHaveBeenCalled()`. |

## Implementation notes

### Fixture-backed invoker harness

`makeScenarioInvokers(scenario)` builds 4 `vi.fn()` mocks backed by FIFO
queues drained from the scenario object. Each `invoke()` call shifts the
next response off its queue. An empty queue throws *with the queue name*
in the error message — so a fixture-vs-test drift surfaces as
`[T-W.9 fixture] verify queue empty — scenario expected fewer calls than
the wizard made` rather than as a confusing JSDOM symptom three frames
deep in `userEvent.click`.

The harness exposes `remaining()` so end-of-test assertions can confirm
the wizard made *exactly* the calls scripted — no more, no less. This is
the spy-assertion form INDEX T-W.9 AC asks for ("verified by spy
assertions").

### Three scenarios

| Scenario | Path | Detect | Install | Configure | Verify |
|---|---|---|---|---|---|
| `SCENARIO_FRESH_MAC_HAPPY` | welcome→detect→install→configure→verify→done | `[NotInstalled]` | `[brew_found=true, 4 stdout lines]` | `[{deviceId:137}]` | `[signal=true, peak=0.42]` |
| `SCENARIO_BREW_NOT_FOUND` | welcome→detect→install (manual)→detect→configure→verify→done | `[NotInstalled, InstalledNotConfigured]` | `[brew_found=false, manual_url]` | `[{deviceId:137}]` | `[signal=true]` |
| `SCENARIO_VERIFY_SILENT_RETRY` | welcome→detect (Configured short-circuit)→verify×3 (silent) | `[Configured, multi_output_id=137]` | `[]` | `[]` | `[silent×3]` |

### Determinism budget

- `vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout","setInterval","clearTimeout","clearInterval"] })` in `beforeEach` so any internal debounces don't pull in wall-clock time. The reducer is sync; the only async surface is the invoker promises, which resolve immediately via `async () => fixture.shift()`.
- `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` ties the user-event input simulation to the same fake-timer clock.
- `cleanup()` in both `beforeEach` and `afterEach` to un-mount the JSDOM tree between tests (defense in depth — RTL's auto-cleanup also runs).

### Why `createElement`, not JSX?

INDEX T-W.9 declares the filename `tests/e2e/blackhole-wizard.e2e.test.ts`
(extension `.ts`, not `.tsx`). The vitest config's e2e glob includes
`tests/e2e/**/*.e2e.test.ts` only — adding `.tsx` would expand the include
glob and risk pulling other future `.tsx` e2e files in unintentionally.
Using `React.createElement(SetupWizard, { invokers, onDone })` produces
the *same* render output as `<SetupWizard invokers={...} onDone={...} />`;
no behavioral difference, no perf cost, just a different syntactic form.
RTL's `render(...)` accepts `ReactElement` either way.

## Non-Goals

- **No live Tauri command coverage.** T-W.7 will write `cargo
  #[test]`-level wrappers asserting the dispatch shape; this E2E sits at
  the React layer, not the Rust layer.
- **No real CoreAudio enumeration.** The fixture's `Configured` short-
  circuit path *exercises* the reducer's `nextStepForDetect` mapping but
  the underlying CoreAudio probe is mocked.
- **No retry-bound enforcement code.** INDEX T-W.9 talks about "retry
  loop bounded to 3 attempts then surfaces error" — but the reducer
  itself doesn't enforce a retry cap (it's unbounded; "the App-level
  wiring caps it" per `Verify.tsx` line 4-6 docstring). T-W.9's E2E-5
  test simulates the operator-supervised version of that bound: drive 3
  silent attempts, assert the FSM remains stable, no auto-advance to
  done. T-W.7's App-level wiring will add the actual cap (and its own
  integration test).

## Files Touched

| File | Direction | Purpose |
|---|---|---|
| `tests/e2e/blackhole-wizard.e2e.test.ts` | NEW | 6 e2e cases covering 5 ACs |
| `tests/e2e/__fixtures__/wizard-states.ts` | NEW | 3 scenarios + atomic response constants |
| `docs/tasks/blackhole-wizard/T-W.9-e2e.md` | NEW | This spec |
| `docs/tasks/blackhole-wizard/T-W.9-review.md` | NEW | Code review checkboxes |
| `docs/tasks/blackhole-wizard/INDEX.md` | UPDATE | Tick T-W.9 checkbox + landing summary |

Diff size: ~500 LOC of test + ~190 LOC of fixture + ~250 LOC of docs.

## Test Plan (host re-verify)

```bash
bun run test tests/e2e/blackhole-wizard.e2e.test.ts   # 6/6 pass
bun run test                                          # 934/934 pass (was 928 baseline + 6 new)
bun run typecheck                                     # clean
# Determinism: re-run e2e file 3 consecutive times
for i in 1 2 3; do bun run test tests/e2e/blackhole-wizard.e2e.test.ts; done
```

All four pass on the host at landing. `cargo test --workspace` regression
is preserved by definition (this task adds zero Rust code).
