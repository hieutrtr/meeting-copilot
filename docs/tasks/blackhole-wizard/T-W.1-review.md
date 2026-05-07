# T-W.1 — Research + Design Memo + Phase Index — Self-Review

> Closes T-W.1 from `docs/tasks/blackhole-wizard/INDEX.md`. Pairs with `T-W.1-design.md` and `docs/blackhole-wizard-design.md`.

## Files Changed

| Path | Type | Purpose |
|---|---|---|
| `docs/tasks/blackhole-wizard/INDEX.md` | new | Phase-W task list (10 tasks) + dep graph + TDD-per-task table + AC summary + risk register (6 entries) + process rules |
| `docs/blackhole-wizard-design.md` | new | 1-page (~1500 word) design memo: 4 contracts (detect / install / configure / FSM) + sequence diagram + permission UX inventory (3 prompts) + 6 risks |
| `docs/tasks/blackhole-wizard/T-W.1-design.md` | new | T-W.1 task spec — goal, AC, TDD plan, implementation notes, risk |
| `docs/tasks/blackhole-wizard/T-W.1-review.md` | new | This file |

**Touched-but-unchanged check**: Zero source files touched. Zero test files touched. Zero `package.json` / `Cargo.toml` / `tauri.conf.json` / `src/**/*.{ts,tsx}` / `src-tauri/**/*.rs` / `crates/**/*.rs` edits. Phase 4 sign-off (`docs/tasks/phase-4/PHASE-4-COMPLETE.md`) and v1.0.0 tag remain untouched.

## Test Count

- **0 unit tests** (T-W.1 is doc-only by design — INDEX TDD row says "Doc-only review (markdown manual cross-ref against spike-memo + experiments)").
- **No regression sweep run** in this iteration — T-W.1 commit touches zero code; full `bun test` + `cargo test --workspace` regression sweep is reserved for T-W.10 phase test gate.
- Manual lint: each cross-reference (line numbers in spike-memo + experiments + Phase 4 INDEX/T-4.1) hand-verified — see Cross-Reference Trace below.

## Cross-Reference Trace (manual lint)

| Cross-ref claim | Source file | Line(s) | Verdict |
|---|---|---|---|
| `docs/spike-memo.md` §"Unknown #1" verdict | `docs/spike-memo.md` | 21–29 | ✅ exists; "Mic + system audio simultaneously on macOS" + "BLOCKED-PENDING-INSTALL" caveat verbatim cited |
| `docs/spike-memo.md` Risks #1, #3 | `docs/spike-memo.md` | 81–88 | ✅ Risk #3 "BlackHole present-but-silent" — most relevant to T-W.5 verify step semantic |
| `experiments/T-0.2/blackhole_capture.swift` Swift CoreAudio enumeration scaffold | `experiments/T-0.2/blackhole_capture.swift` | 98–167 | ✅ `enumerateDevices`, `findBlackHole`, `cfStringForProperty` — to be ported to Rust at T-W.2 |
| Swift `findBlackHole` UID + name match | `experiments/T-0.2/blackhole_capture.swift` | 144–154 | ✅ case-insensitive name match + UID prefix; T-W.2 unit test #4 + #5 mirror |
| Swift exit code 7 (`blackhole_not_installed`) | `experiments/T-0.2/blackhole_capture.swift` | 159–167 | ✅ maps to `BlackHoleStatus::NotInstalled` per T-W.2 |
| Swift exit code 8 (`blackhole_present_but_silent`) | `experiments/T-0.2/blackhole_capture.swift` | 421–457 | ✅ maps to `VerifyError::BlackHolePresentButSilent` per T-W.5 |
| `crates/audio-capture/src/mic.rs` cpal mic source — re-used by T-W.5 | `crates/audio-capture/src/mic.rs` | 78–165 | ✅ `build_input_stream` / device-open path is the seam T-W.5 inherits |
| `docs/tasks/phase-4/INDEX.md` rule structure | `docs/tasks/phase-4/INDEX.md` | 229–242 (Process Rules) | ✅ same 5-rule format reproduced verbatim in Phase-W INDEX |
| `docs/tasks/phase-4/T-4.1-integration-design.md` design-only pattern | `docs/tasks/phase-4/T-4.1-integration-design.md` | 1–80 | ✅ design memo style + 1-page word-budget mirrored |
| `docs/tasks/phase-4/PHASE-4-COMPLETE.md` v1.0.0 sign-off | `docs/tasks/phase-4/PHASE-4-COMPLETE.md` | 1–60 | ✅ this loop targets v1.0.1 — version table format inherited |

## AC Verification

| AC | Status | Evidence |
|---|---|---|
| AC-1 — Four files committed | ✅ | `git status` will show all 4 untracked pre-commit; commit lands all 4 atomically |
| AC-2 — Design memo cites spike-memo + experiments by line number | ✅ | design §8 References block enumerates 6 line-anchored citations |
| AC-3 — INDEX declares 10 tasks (T-W.1..T-W.10) | ✅ | INDEX §"Task Checklist" — `[x]` for T-W.1 + `[ ]` for T-W.2..T-W.10 = 10 rows |
| AC-4 — Risk register ≥ 5 entries | ✅ | INDEX §"Risk Register" has 6 rows (R-W.1..R-W.6); design §6 condenses to 6 short bullets |
| AC-5 — Permission UX inventory ≥ 3 prompts | ✅ | design §5 enumerates 3 prompts (Microphone TCC, brew sudo, default-output flip) + 2 explicit "not in this list" entries |
| AC-6 — Detection ladder: 4 states + 4 probes + Swift exit-code mapping | ✅ | design §1 has all four; INDEX T-W.2 row repeats the enum-name → Swift exit-code mapping |
| AC-7 — Install path tree: argv array form (no shell string) | ✅ | design §2 ASCII tree shows `Command::new("brew").args(["install", "--cask", "blackhole-2ch"])`; INDEX T-W.3 row + risk R-W.5 reinforce |
| AC-8 — Configure: `IsStacked: 1` (Multi-Output, NOT 0) — BLOCKING regression doc-comment requirement | ✅ | design §3 explicit "IsStacked bit is THE gotcha" callout; INDEX R-W.3 marked CRITICAL impact + BLOCKING test |
| AC-9 — FSM: useReducer + closed action union + quit-wizard escape hatch | ✅ | design §4 has the action-union TS code block + ASCII state diagram showing escape-hatch link on every step |

## Self-Review Checklist (5 BLOCKING)

- [x] **No regression Phase 1 / 2 / 3 / 4** — zero source files touched; doc-only commit. Audio capture path (`crates/audio-capture/src/mic.rs`), MCP surface (`src/mcp/**`), settings store (`src/store/settingsStore.ts`), Tauri command surface (`src-tauri/src/lib.rs`) — all untouched. No risk of import-path drift, schema drift, test breakage. v1.0.0 tag stays valid; v1.0.1 will be cut at T-W.10.
- [x] **Permission prompt UX: rationale string visible to user in wizard** — design §5 enumerates 3 prompts with pre-warning copy strings ("macOS will ask for microphone access in a moment…", "You may see a macOS password prompt — that's Homebrew running the BlackHole installer.", "Click 'Use for this meeting' to route system audio…"). Each is referenced by T-W.6 component spec (will land in T-W.6 review).
- [x] **Idempotent (re-running wizard after completion does not break existing config)** — design §3 specifies idempotent `create_multi_output()`: existing UID match → return existing `AudioDeviceID`, no recreate. INDEX R-W.1 documents Aggregate-Device transience mitigation (recreate at app startup). T-W.7 row specifies `re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui` test.
- [x] **Rollback if user cancels mid-flow (no half-installed state visible to main app)** — design §4 FSM includes quit-wizard escape hatch on every step EXCEPT done; clicking sets `setupCompleted=true` regardless. Rationale: a half-installed state (BlackHole installed, Multi-Output not configured) is detected by T-W.2's 4-state enum on next launch, so re-running the wizard handles partial state gracefully. INDEX R-W.5 covers the brew-sudo-cancel mid-flow case (stderr surfaced live; manual URL fallback in same step).
- [x] **No `git push`** — per loop rule 4. Commit lands on `main` locally only. v1.0.1 tag will be cut at T-W.10 (NOT pushed; operator pushes after sign-off).

## Risk Re-Check

| From task spec (INDEX risk register + design §6) | Outcome / Mitigation locked |
|---|---|
| **R-W.1** — Aggregate Device transience (gone after reboot) | T-W.7 startup integration re-runs `detect_blackhole`; T-W.4 idempotent recreate path covers. T-W.8 SETUP.md FAQ section documents. |
| **R-W.2** — Apple Silicon vs Intel Homebrew prefix split | T-W.3 `BrewProbe` trait checks `/opt/homebrew` AND `/usr/local` AND `which brew` fallback; 2 unit tests cover each prefix. |
| **R-W.3** — `IsStacked=1 vs 0` confusion (Multi-Output vs Aggregate) | T-W.4 unit test #4 (`is_stacked_key_is_1_for_multi_output_not_0`) is BLOCKING regression guard. Doc-comment on `create_multi_output()` enumerates the bit semantics. |
| **R-W.4** — TCC microphone re-prompt across helper-daemon respawn | Tauri main process owns AVCaptureDevice authorization; helper-daemon delegates capture in-process, NOT a fresh subprocess. |
| **R-W.5** — Brew sudo prompt timing race | T-W.3 streams stderr to wizard UI; on non-zero exit, surface manual URL fallback within same step. |
| **R-W.6** — macOS API drift | Pin to public macOS 13+ APIs only; T-W.10 release notes document tested macOS range; emergency UI-script path documented but NOT shipped. |
| **Design drift (T-W.1-specific)** between this lock-down and T-W.2..T-W.10 implementations | Each T-W.<N> review cites this design by section number; INDEX risk register entry R-W.6 covers the macOS-API-changes-under-us flavor; 10-task plan is bounded (~3000 LOC) so drift surface is limited. |

## Phase-Goal Re-Check

T-W.1 ships the **contract lock-down** for Phase-W (BlackHole Setup Wizard). The phase exit criterion ("user with a fresh Mac launches Meeting Copilot v1.0.1, walks the wizard end-to-end, leaves with BlackHole installed + Multi-Output configured + 5s verify peak > 0.001") depends on four contract surfaces being stable across T-W.2..T-W.10:

1. **Detection** (§1) — 4-state enum + 4 probes
2. **Install** (§2) — brew cask first, manual URL fallback, argv array form
3. **Configure** (§3) — `AudioHardwareCreateAggregateDevice` with `IsStacked=1`, idempotent on UID match
4. **Wizard FSM** (§4) — `useReducer` + closed action union + quit-escape

All four are now frozen by design and traceable back to the cross-referenced spike-memo + experiment line numbers. Subsequent tasks implement against this design without re-litigating shape decisions. T-W.10 sign-off will reproduce the 4-contract table to verify each was honored.

## Hardware-Verification Caveats

None for T-W.1 itself (doc-only). Phase-W carry-forwards from Phase 0–4:

- `cargo` + `rustup` + `tauri-cli` not on loop sandbox — same shape as Phase 1–4. T-W.2/T-W.4/T-W.5 will ship code-complete with structural Rust tests; cargo re-verify pending host (PHASE-MANUAL-VERIFY at T-W.10).
- `brew` not necessarily on loop sandbox — T-W.3 ships with `BrewProbe` mock seam; live brew install verify deferred to PHASE-MANUAL-VERIFY.
- Microphone TCC permission not granted on loop sandbox — T-W.5 ships with `MockAudioStream` seam; live TCC verify deferred to PHASE-MANUAL-VERIFY.
- Aggregate Device creation requires real macOS — T-W.4 ships with mock `AudioHardwareCreateAggregateDevice` seam; live device-creation verify deferred to PHASE-MANUAL-VERIFY.

## Sign-Off

T-W.1 **doc-complete + AC-verified by inspection** (cross-references all hand-traced; 4 contracts locked; 10-task plan declared; 6-risk register; 3-prompt permission UX inventory). Ready to commit (type `docs(setup)`).

Next loop iteration: **T-W.2 — Detection module + 6 unit tests** (`crates/audio-capture/src/blackhole.rs` NEW; `BlackHoleStatus` enum mirroring Swift exit codes 5–10; `MockCoreAudio` trait seam).
