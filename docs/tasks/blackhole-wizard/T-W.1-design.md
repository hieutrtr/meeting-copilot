# T-W.1 — Research + Design Memo + Phase Index — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.1.
> **Cross-refs**: `docs/spike-memo.md` §"Unknown #1" (lines 21–29 verdict + 81–88 risks #1, #3) · `experiments/T-0.2/blackhole_capture.swift` lines 98–167 (Swift CoreAudio enumeration; exit codes 5–10 mapped into T-W.2 Rust enum) · `docs/tasks/phase-4/INDEX.md` (rule structure reused — Process Rules, TDD per task, Acceptance Criteria Summary, Risk Register) · `docs/tasks/phase-4/T-4.1-integration-design.md` (this task is the structural twin: design-only, no code, locks contracts for the rest of the phase).
> **Reference impl**: `experiments/T-0.2/blackhole_capture.swift` (Swift) — to be ported into Rust at T-W.2 verbatim except for language idiom changes.
> **Depends on**: Phase 4 sign-off (`docs/tasks/phase-4/PHASE-4-COMPLETE.md`), v1.0.0 tag landed.
> **Blocks**: T-W.2..T-W.10 (this doc + INDEX + design memo are the lock-down for the rest of Phase-W).

---

## 1. Goal

Lock down — **before any code lands** — the four contracts that surface inside the BlackHole Setup Wizard so that T-W.2..T-W.10 implement against a frozen design:

1. **Detection ladder** — 4-state `BlackHoleStatus` enum + 4 promotion probes (HAL plug-in path, CoreAudio enumeration, Multi-Output sub-device list, 5s capture peak > 0.001).
2. **Install path tree** — brew cask first (Apple Silicon + Intel prefix probe + `which brew` fallback) → manual `.pkg` URL fallback (`https://existential.audio/blackhole/`).
3. **Configure CFDictionary blueprint** — `AudioHardwareCreateAggregateDevice` with `kAudioAggregateDeviceIsStackedKey: 1` (Multi-Output, NOT Aggregate). Idempotent re-create on UID match.
4. **Wizard FSM** — 5-step `useReducer` state machine with closed action union; quit-wizard escape hatch.

Plus a permission-UX inventory enumerating ≥ 3 macOS prompt sources (Microphone TCC, brew sudo via osascript, default-output change confirm) and a risk register with ≥ 5 entries.

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | Four files committed: `docs/tasks/blackhole-wizard/INDEX.md`, `docs/tasks/blackhole-wizard/T-W.1-design.md` (this file), `docs/tasks/blackhole-wizard/T-W.1-review.md`, `docs/blackhole-wizard-design.md`. | ✅ all four present pre-commit (verifiable via `git status` after stage) |
| AC-2 | Design memo (`docs/blackhole-wizard-design.md`) cross-references `docs/spike-memo.md` AND `experiments/T-0.2/blackhole_capture.swift` by line number. | ✅ design §8 cites spike-memo lines 21–29 + 81–88; spike Swift lines 98–167 + 144–154 + 162 |
| AC-3 | INDEX declares 10 tasks (T-W.1..T-W.10) with one-line AC per task. | ✅ INDEX §"Task Checklist" lists all 10 with file paths + diff size + AC summary |
| AC-4 | Risk register has ≥ 5 entries, each with probability + impact + mitigation. | ✅ INDEX §"Risk Register" has 6 rows (R-W.1..R-W.6) |
| AC-5 | Permission-UX inventory enumerates ≥ 3 prompt sources. | ✅ design §5 enumerates 3 prompts + 2 explicit "not in this list" entries |
| AC-6 | Detection ladder design specifies 4 states + 4 probes + maps Swift exit codes 5–10 to Rust enum variants. | ✅ design §1 + INDEX T-W.2 row both cite exit-code mapping |
| AC-7 | Install path tree contract specifies argv-array form (no shell string) — same Phase 4 R-2 BLOCKING checkbox shape. | ✅ design §2 + INDEX T-W.3 row both cite `Command::new("brew").args([...])` form |
| AC-8 | Configure blueprint specifies `kAudioAggregateDeviceIsStackedKey: 1` (Multi-Output) with explicit `0 vs 1` semantics doc-comment requirement for T-W.4. | ✅ design §3 + INDEX R-W.3 row both call this out as BLOCKING regression guard |
| AC-9 | FSM design specifies `useReducer` + closed action union + quit-wizard escape hatch. | ✅ design §4 includes the action-union TS code block + escape-hatch state diagram |

---

## 3. TDD Plan

T-W.1 is **doc-only** — no production code, no automated tests. Verification is by manual cross-reference lint:

| Verification | Method |
|---|---|
| AC-2 cross-ref accuracy | Hand-trace each line-number citation in design §8 against the live source files |
| AC-3 task count | `grep -c "^- \[ \] \*\*T-W\." docs/tasks/blackhole-wizard/INDEX.md` returns 9 (plus the T-W.1 row marked `[x]`) → 10 total |
| AC-4 risk count | `grep -c "^| R-W\." docs/tasks/blackhole-wizard/INDEX.md` returns 6 |
| AC-5 prompt count | `grep -c "^| [123] " docs/blackhole-wizard-design.md` (under §5 Permission UX inventory) returns ≥ 3 |
| AC-6/7/8/9 design contracts | Visual inspection — each section explicitly enumerated above |
| Markdown link audit | Manual: each relative path link resolves to an existing file (or is documented as "NEW — landing in T-W.<N>") |

The full Phase-W test gate at T-W.10 includes `bun test` + `cargo test --workspace` regression — no T-W.1 row contributes to those counts (this task is doc-only).

---

## 4. Implementation Notes

T-W.1 is the **contract lock-down** task. It produces no executable code; it produces:

- `docs/tasks/blackhole-wizard/INDEX.md` — the phase task list, dependency graph, TDD-per-task table, AC summary, risk register, process rules. ~600 LOC of markdown.
- `docs/blackhole-wizard-design.md` — the 1-page (~1500 word) design memo with the four contracts, sequence diagram, permission UX inventory, risks. ~500 LOC of markdown.
- `docs/tasks/blackhole-wizard/T-W.1-design.md` — this file (task spec).
- `docs/tasks/blackhole-wizard/T-W.1-review.md` — self-review with 5 BLOCKING checkboxes (no regression, permission UX, idempotency, rollback, no `git push`).

Reference impl pointers (Phase-4 pattern verbatim — same shape as T-4.1):

| Pattern | Phase-4 example | Phase-W use |
|---|---|---|
| 1-page design memo + INDEX + spec + review | `docs/tasks/phase-4/T-4.1-integration-design.md` + `INDEX.md` + `T-4.1-review.md` + `docs/ARCHITECTURE.md` Phase 4 addendum | `docs/blackhole-wizard-design.md` + `docs/tasks/blackhole-wizard/INDEX.md` + `T-W.1-design.md` + `T-W.1-review.md` |
| Closed error-code set | T-4.1 §4 enumerates `PrivacyModeViolation`, `DeeplinkNotRegistered`, `ContextNotFound`, `MeetingNotFound`, `InvalidMeetingId`, `ConfigSchemaUnsupported`, `BridgeConfigInvalid` | T-W.2..T-W.5 typed errors: `BlackHoleNotInstalled`, `MultiOutputNotConfigured`, `BrewNotFound`, `BrewExitNonZero`, `AggregateDeviceCreateFailed`, `BlackHolePresentButSilent`, `TccNotAuthorized`, `AggregateDeviceTransient` |
| Risk register format | T-4.1 review §"Risk Re-Check" 3-column table | INDEX §"Risk Register" 5-column table (Probability, Impact added per Phase 4 INDEX shape) |
| TDD-per-task summary table | Phase 4 INDEX §"TDD per task" | Phase-W INDEX §"TDD per task" — same column layout |
| AC summary table | Phase 4 INDEX §"Acceptance Criteria Summary" | Phase-W INDEX §"Acceptance Criteria Summary" — same column layout |
| Sign-off doc shape | `docs/tasks/phase-4/PHASE-4-COMPLETE.md` | T-W.10 will produce `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` matching this shape |

### Why these exact 10 tasks?

| Task | Justification |
|---|---|
| T-W.1 | Design-only lock-down (this task). Required by loop driver Rule 1 (plan-first). |
| T-W.2 | Detection — the blocking precondition for every other state in the wizard FSM. Must land first. |
| T-W.3 / T-W.4 | Install + Configure are independent post-detection (no shared module); can be parallelized in scheduling but each lands as its own task per Rule 4 (per-task commit). |
| T-W.5 | Verify — separate from detection because it requires Microphone TCC and a 5s blocking capture. Don't run on every wizard render. |
| T-W.6 | UI is independent of the Tauri command surface (mocks the commands). Lands after T-W.5 because verify step needs the response shape. |
| T-W.7 | Tauri commands + App.tsx integration. Wires the wizard into cold-start flow. Cannot land before T-W.6 (component mount target). |
| T-W.8 | End-user docs. Always late (docs reflect tested behavior, not aspirations) — same rule as Phase 4 T-4.11. |
| T-W.9 | E2E simulation. Always late (mocks Tauri commands; e2e contract is locked by T-W.7). |
| T-W.10 | Sign-off + tag. Always last (per Rule 5). |

### Why NOT include the following in scope?

- **GitHub auto-update of the wizard from a remote URL** — out of scope; would require codesigning + notarization for the wizard binary. Defer to Phase-W.x or Phase-5.
- **Linux / Windows audio routing** — Phase 0 architecture decision: macOS Apple Silicon only for Phase 1–4. v1.0.1 stays consistent.
- **Loopback.app integration** — paid third-party tool; not in our charge. The wizard's quit-escape hatch covers users who already use Loopback.
- **ScreenCaptureKit `SCStream` audio output** — Phase 0 spike pivot ladder reserves it for the BlackHole-fails fallback. NOT shipped in v1.0.1.
- **VAD integration / large-v3-turbo upgrade** — Phase 1 T-1.5b territory, separate from audio routing.

---

## 5. Risk

The single risk for T-W.1 itself is design drift between this lock-down and the actual T-W.2..T-W.10 implementations — same risk shape as Phase 4 R-1 (MCP SDK drift) and Phase 4 T-4.1 §"Risk Re-Check". Mitigation:

- Each T-W.<N> review doc cites this design memo by section number. Drift caught at review time.
- INDEX risk register R-W.6 (macOS API drift) covers the API-surface-changes-under-us flavor of drift.
- The 10-task plan is bounded and small (~3000 LOC of new code total estimated); drift surface is limited.

No risk for the doc-only commit itself — it touches zero source files, zero test files, zero `package.json` / `Cargo.toml` (so zero dependency surface change).

---

## 6. Files Touched (preview for review)

| Path | Type | Purpose |
|---|---|---|
| `docs/tasks/blackhole-wizard/INDEX.md` | new | Phase task list + dep graph + TDD + AC summary + risk register + process rules |
| `docs/blackhole-wizard-design.md` | new | 1-page (~1500 word) design memo: 4 contracts + sequence diagram + permission UX + risks |
| `docs/tasks/blackhole-wizard/T-W.1-design.md` | new | This file — task spec |
| `docs/tasks/blackhole-wizard/T-W.1-review.md` | new | Self-review with 5 BLOCKING checkboxes |

Zero source files touched. Zero `package.json` / `Cargo.toml` / `tauri.conf.json` edits.

---

## 7. Sign-Off

T-W.1 ships the **contract lock-down** for Phase-W. The phase exit criterion ("user with a fresh Mac walks the wizard end-to-end → BlackHole installed + Multi-Output configured + 5s verify peak > 0.001") depends on four contract surfaces being stable across T-W.2..T-W.10: detection (§1), install (§2), configure (§3), wizard FSM (§4). All four are now frozen by design and traceable back to spike-memo + experiment line numbers. Subsequent tasks implement against this design without re-litigating shape decisions.

Next loop iteration: **T-W.2 — Detection module + tests**.
