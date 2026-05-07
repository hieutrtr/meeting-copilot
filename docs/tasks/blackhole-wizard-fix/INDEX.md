# BlackHole Wizard — Post-v1.0.1 Fix Loop — Task Index

> Reference: `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` (verdict `CODE-COMPLETE-PENDING-HOST-VERIFY` cut on commit `d9883d4`); `docs/tasks/blackhole-wizard/INDEX.md` (T-W.1 → T-W.10 plan + dep graph). Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`. Loop step **1/8** (this commit).
>
> Stack lock (carry-forward from wizard v1.0.1): **Tauri 2 + React + TypeScript + Rust helper daemon + cpal + MLX whisper + Deepgram + ElevenLabs + Claude Sonnet 4.6 + MCP SDK ^1.0.0**. Fix loop ADDS **zero** new dependencies — every fix is a derive / trait-bound / method addition / wiring change against the already-pinned crates (`coreaudio-rs ^0.11`, `core-foundation ^0.9`, `cpal`, `tokio`).

---

## Loop Goal

The wizard v1.0.1 main loop landed `CODE-COMPLETE-PENDING-HOST-VERIFY` with two structural deferrals (T-W.5 verify FFI body + T-W.7 App.tsx + Tauri-command wrappers + `setupCompleted` field). Bridge-bot has now installed the Rust toolchain on the Mac dev host (`cargo 1.95.0`, `rustc 1.95.0`, `stable-aarch64-apple-darwin`). Discovery `cargo test --workspace --no-run` reports **12 compile errors** that block any cargo green-bar:

```
   5 error[E0277]: `dyn provider::SttProvider` doesn't implement `Debug`
   2 error[E0277]: `wav::WavFileSource` doesn't implement `Debug`
   2 error[E0277]: `elevenlabs::ElevenLabsAdapter` doesn't implement `Debug`
   2 error[E0277]: `deepgram::DeepgramAdapter` doesn't implement `Debug`
   1 error[E0599]: no method named `next_chunk` found for struct `WavFileSource`
   1 error: could not compile `stt-mlx` (lib test)
   1 error: could not compile `audio-capture` (lib test)
```

This loop closes all three: (a) **fix the 12 cargo errors** (R-W.2 + R-W.3), (b) **land the two deferred tasks** (T-W.5 verify FFI body via R-W.4; T-W.7 App + Tauri commands + settings field via R-W.5/R-W.6/R-W.7), (c) **bump the wizard sign-off** from `CODE-COMPLETE-PENDING-HOST-VERIFY` → `✅ VERIFIED` and **re-tag** local `v1.0.1` (R-W.9). Final review files (R-W.10) close the audit trail.

## Loop Exit Criteria

A clean `cargo test --workspace` (zero errors, all tests pass) on this Mac dev host, plus `bun test` ≥ 934 (the wizard v1.0.1 baseline) with no regression, plus T-W.5 and T-W.7 task files committed under `docs/tasks/blackhole-wizard/` (the same dir as the rest of the wizard task suite — these two tasks belong to the wizard, not to this fix loop), plus `PHASE-COMPLETE.md` verdict bumped + task-tally row updated for T-W.5 and T-W.7 with their commit hashes, plus a re-tagged annotated `v1.0.1` pointing at the final commit. **No `git push`** at any point.

## Naming Convention

This fix loop introduces a new doc folder `docs/tasks/blackhole-wizard-fix/` to keep the audit trail of the **fix-loop** sub-tasks (R-W.1..R-W.10) separate from the wizard's **v1.0.1** task suite (T-W.1..T-W.10) — but the **two newly-landed wizard tasks themselves** (T-W.5 + T-W.7) write their spec + review files in the **wizard** folder (`docs/tasks/blackhole-wizard/`) so a future reader of the wizard plan does not need to know this fix loop ever happened. Concretely:

| File | Folder | Why |
|---|---|---|
| `INDEX.md` (this file) | `docs/tasks/blackhole-wizard-fix/` | Fix-loop plan + dep graph; not visible from the wizard's own INDEX |
| `R-W.<N>-*.md` × 10 | `docs/tasks/blackhole-wizard-fix/` | Per-step audit trail for the fix loop's own work |
| `T-W.5-verify.md` + `T-W.5-review.md` | `docs/tasks/blackhole-wizard/` | Belongs to the wizard plan — wizard's INDEX checkbox flips |
| `T-W.7-integration.md` + `T-W.7-review.md` | `docs/tasks/blackhole-wizard/` | Belongs to the wizard plan — wizard's INDEX checkbox flips |
| `PHASE-COMPLETE.md` (existing) | `docs/tasks/blackhole-wizard/` | Mutated in place — verdict + task tally row |

## Baselines

| Suite | Pre-fix | Post-fix target |
|---|---:|---:|
| `bun test` (vitest) | **934 / 934** across 60 files (wizard v1.0.1 baseline; commit `d9883d4`) | **≥ 934 + new T-W.7 RTL** (4 RTL integration tests pinned in wizard INDEX line 62; net `+4` minimum, target `~938`). Zero Phase 1–4 + wizard regression. |
| `cargo test --workspace --no-run` | **12 compile errors** (5× `Debug` on `dyn SttProvider`, 2× on `WavFileSource`, 2× on `DeepgramAdapter`, 2× on `ElevenLabsAdapter`, 1× missing `WavFileSource::next_chunk`) | **0 errors**, builds green |
| `cargo test --workspace` | _Cannot run — build fails_ | **All structural tests green** (Phase 0–4 carry-forward + wizard `+24` from T-W.2/T-W.3/T-W.4 + T-W.5 `+4` new = wizard `+28` cargo, all green) |
| `bun run typecheck` (`tsc --noEmit`) | exits 0 | exits 0 (no degradation) |
| Local annotated tag | `v1.0.1` → commit `d9883d4` | `v1.0.1` → final R-W.9/10 commit (tag deleted + recreated, NOT pushed) |

---

## Task Checklist (10 sub-tasks)

- [ ] **R-W.1** — Plan + INDEX (this commit). Read `PHASE-COMPLETE.md` + `INDEX.md` + T-3.* + T-1.* reviews + the four error sites (`crates/stt-mlx/src/providers/mod.rs:391`, `crates/audio-capture/src/wav.rs`, `crates/stt-mlx/src/providers/deepgram.rs`, `crates/stt-mlx/src/providers/elevenlabs.rs`). Write this INDEX. Commit `docs(plan): R-W.1 blackhole-wizard-fix INDEX + dep graph`. **AC:** `docs/tasks/blackhole-wizard-fix/INDEX.md` exists with dep graph + naming convention + exit gates + baselines table; commit landed on `main`; **no `git push`**. **Dep:** none. **Risk:** plan drift later — mitigated by re-reading this INDEX at the top of every subsequent iteration. **Files touched:** `docs/tasks/blackhole-wizard-fix/INDEX.md` (NEW). **Diff size:** ~250 LOC of markdown.

- [ ] **R-W.2** — Fix the 11 `Debug` derive errors. Add `: std::fmt::Debug` super-trait bound on `SttProvider` (or, if any non-`Debug` field exists in adapter state, manual `impl Debug` skipping that field) so `Box<dyn SttProvider>` satisfies the `expect_err()` `{:?}` print at `crates/stt-mlx/src/providers/mod.rs:391`. Add `#[derive(Debug)]` (or skip-field manual impl if `WavReader` is not `Debug`) on `WavFileSource`, `DeepgramAdapter`, `ElevenLabsAdapter`. **AC:** `cargo test --workspace --no-run` reports **0 errors**; existing tests still compile (no test rewrites); no behavioral change. **Dep:** R-W.1. **Risk:** A field type (`WavReader`, `tokio::sync::Mutex`, websocket handle) doesn't impl `Debug` → falls back to manual `impl Debug` with the offending field replaced by `&"<opaque>"` per Phase 4 carry-forward pattern. **Files touched:** `crates/stt-mlx/src/provider.rs` (super-trait bound), `crates/stt-mlx/src/providers/{deepgram,elevenlabs}.rs` (derive/impl), `crates/audio-capture/src/wav.rs` (derive/impl). **Diff size:** ~30–80 LOC.

- [ ] **R-W.3** — Fix the 1 `WavFileSource::next_chunk` missing-method error. Either rename the call site to use the existing `AudioSource::read_chunk` (or whatever the trait method is named in `crates/audio-capture/src/source.rs`), OR add a `next_chunk(&mut self) -> Option<PcmChunk>` inherent method on `WavFileSource` that wraps the trait method. Whichever route preserves the test's intent. **AC:** `cargo test --workspace --no-run` builds; `cargo test -p audio-capture` (the package containing `wav.rs`) all green; the test that calls `next_chunk` passes; **no rewrite of the `AudioSource` trait** (Phase 1 contract is frozen). **Dep:** R-W.2. **Risk:** `next_chunk` was removed during a refactor and the test was missed — the rename route is the safe one (mirror trait API exactly). **Files touched:** `crates/audio-capture/src/wav.rs` (+1 inherent method or test rename) OR the test file calling `next_chunk` (rename to trait method). **Diff size:** ~20–40 LOC.

- [ ] **R-W.4** — **T-W.5 lands**: implement `crates/audio-capture/src/verify.rs` real FFI body. Add `pub fn verify_capture(device_id: AudioDeviceID, duration_ms: u64) -> Result<VerifyReport, VerifyError>`. Open a `cpal::build_input_stream` from the BlackHole device, accumulate peak amplitude over a 5 s window, return `Verified { peak_amplitude }` if `peak > 0.001`, `BlackHolePresentButSilent` if `peak ≤ 1e-4`, `TimedOutNoCallbacks` if zero callbacks fire in 5 s, `BuildInputStreamFailed(cpal::BuildStreamError)` on stream-construction failure. Mirror `experiments/T-0.2/blackhole_capture.swift` lines 293–377 (peak + tap loop) verbatim. Add a `MockAudioStream` trait seam so the 4 unit tests run with synthesized PCM (no real CoreAudio). Wizard's `BlackHoleStatus::Verified { peak_amplitude }` + closed `VerifyError` set are already declared in `PHASE-COMPLETE.md` line 66 — implementation matches that contract. Write `docs/tasks/blackhole-wizard/T-W.5-verify.md` (spec — interface, mock seam, 4 test cases) **before** implementation; review doc deferred to R-W.10. **AC:** 4 unit tests green (`verify_passes_when_peak_above_threshold`, `verify_fails_when_silent`, `verify_times_out_when_zero_callbacks_in_5s`, `verify_returns_callback_count_for_telemetry`); `cargo test -p audio-capture verify::` all green; the FFI body is feature-flagged or `#[cfg(target_os = "macos")]` so non-Mac CI still compiles (cross-platform parity carry-forward from T-W.2/T-W.4). **Dep:** R-W.3 (cargo must build). **Risk:** TCC microphone permission propagates per-process and the cargo-test process may not have it — the 4 tests use `MockAudioStream` and never touch real CoreAudio, so this is host-test-only and documented in `T-W.5-verify.md`. **Files touched:** `crates/audio-capture/src/verify.rs` (NEW), `crates/audio-capture/src/lib.rs` (`pub mod verify;`), `docs/tasks/blackhole-wizard/T-W.5-verify.md` (NEW). **Diff size:** ~300–450 LOC code + ~150 LOC markdown.

- [ ] **R-W.5** — **T-W.7 part A**: `src/store/settingsStore.ts` adds `setupCompleted: boolean` field (default `false`) with the same `coerceLoaded` zero-fill pattern as `telemetryEnabled` (Phase 3 T-3.9) and `mcpServerEnabled` (Phase 4 T-4.2). Persist via the existing settings persistence layer; new vitest covers default value, post-set persistence, and `coerceLoaded` zero-fill on settings file from a previous version (no field present). **AC:** `bun test src/store/settingsStore.test.ts` shows ≥ 3 new test cases green; existing settings tests green (no migration breakage); `bun run typecheck` clean. **Dep:** R-W.4 (so wizard verify command response shape exists in TS via Tauri-command type generation). **Risk:** existing user's settings file lacks the field → `coerceLoaded` zero-fills to `false` → wizard fires once on first launch post-upgrade (acceptable; wizard short-circuits to "Done" in ≤ 2 s if BlackHole is already configured per T-W.6 FSM). **Files touched:** `src/store/settingsStore.ts` (+1 field + coerce arm), `src/store/settingsStore.test.ts` (+3 tests). **Diff size:** ~80–120 LOC.

- [ ] **R-W.6** — **T-W.7 part B**: `src-tauri/src/lib.rs` adds 4 `#[tauri::command]` wrappers — `setup_detect_blackhole`, `setup_install_blackhole`, `setup_configure_multi_output`, `setup_verify_capture` — each delegating to the matching helper-daemon / audio-capture function from T-W.2/T-W.3/T-W.4/R-W.4. Register all four in the Tauri builder's `invoke_handler`. Add 4 cargo `#[test]` for dispatch shape (same pattern as Phase 4 T-4.4 `start_from_deeplink`). **AC:** `cargo test -p meeting-copilot src::tests` (or wherever `lib.rs` `#[test]` sit) shows 4 new dispatch-shape tests green; `cargo build` produces a Tauri binary that exposes the 4 commands (verified by string-grep on the binary or by the RTL test in R-W.7); `bun run typecheck` discovers the 4 invoke shapes via Tauri's command-type generation (or the matching `src/types/setup.ts` if hand-written). **Dep:** R-W.4 (`verify_capture` exists), R-W.5 (`settingsStore.setupCompleted` exists for caller TS to wire). **Risk:** Tauri command-name typo silently makes the wizard fail with `command "setup_…" not found` runtime — mitigated by a single source-of-truth string constant per command, used by both Rust `#[tauri::command]` rename arg AND the TS invoker call site. **Files touched:** `src-tauri/src/lib.rs` (+4 commands + builder registration + 4 `#[test]`), `src/types/setup.ts` (NEW or extended; Tauri command response shapes). **Diff size:** ~250–400 LOC.

- [ ] **R-W.7** — **T-W.7 part C**: `src/App.tsx` reads `settingsStore.setupCompleted` on mount; if `false`, mount `<SetupWizard onDone={() => setSetupCompleted(true)} setupInvoker={…tauri-invokes…} />` as a modal overlay before the main UI. Wire the four invoke functions from R-W.6 into `setupInvoker`. Write `docs/tasks/blackhole-wizard/T-W.7-integration.md` spec (T-W.7 lands across R-W.5/R-W.6/R-W.7 — this spec is the umbrella). Add 4 RTL integration tests (already pinned in wizard INDEX line 62): `app_renders_wizard_when_setup_incomplete`, `app_skips_wizard_when_setup_completed_true`, `app_persists_setup_completed_to_settings_store_after_done`, `re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui`. **AC:** 4 RTL tests green; full `bun test` ≥ **938** (934 wizard baseline + 4 new); zero regression in any prior test file. **Dep:** R-W.6. **Risk:** Wizard fires on every cold-start until `setupCompleted=true` is persisted — R-W.5's `coerceLoaded` zero-fill + the Verify step's `setSetupCompleted(true)` close that loop. R-W.5 + R-W.6 + R-W.7 must land in this order so the Tauri commands exist before the React component invokes them. **Files touched:** `src/App.tsx` (+1 conditional render + 1 mount), `src/App.test.tsx` (+4 RTL tests), `docs/tasks/blackhole-wizard/T-W.7-integration.md` (NEW). **Diff size:** ~250–350 LOC.

- [ ] **R-W.8** — Full test sweep + capture metrics. Run `cargo test --workspace` and capture: per-package pass count, total wall time, any feature-gated test that was excluded. Run `bun test` and capture: 60-file pass count (must be ≥ 934 + 4 = 938), total wall time, vitest reporter summary. Run `bun run typecheck` to confirm 0 errors. Append the captured metrics to `docs/tasks/blackhole-wizard-fix/R-W.8-test-sweep.md` (NEW — short doc, ~100 LOC: just a table of per-suite numbers). **AC:** all three sweeps green; metrics file committed. **Dep:** R-W.7. **Risk:** A feature-gated test (`#[cfg(feature = "deepgram")]` or `#[cfg(feature = "elevenlabs")]`) is silently skipped — the metrics doc explicitly enumerates `--all-features` re-run vs default-features run so any drift is visible. **Files touched:** `docs/tasks/blackhole-wizard-fix/R-W.8-test-sweep.md` (NEW). **Diff size:** ~100 LOC of markdown.

- [ ] **R-W.9** — Sign-off bump + re-tag `v1.0.1`. Mutate `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md`: (a) bump verdict from `CODE-COMPLETE-PENDING-HOST-VERIFY` → `✅ VERIFIED` (keep the same `CAVEAT-GO` shape — six carry-forward blockers narrow to four since C-C cargo + Wizard-new T-W.5/T-W.7 deferrals close), (b) flip exit-gate row #2 (`cargo test --workspace`) from `⚠️ Code-complete — re-verify pending host` → `✅ {N} tests pass on aarch64-apple-darwin`, (c) flip task-tally rows for T-W.5 + T-W.7 from `Deferred to host` → `Landed` with their commit hashes from R-W.4 / R-W.5 / R-W.6 / R-W.7, (d) update the cumulative test counts (vitest 934 → final number, cargo `+24` → `+28` net new under `+4` from T-W.5). Then re-tag: `git tag -d v1.0.1` (delete the local v1.0.1 cut at `d9883d4`) + `git tag -a v1.0.1 -m "v1.0.1 BlackHole wizard sign-off — fix loop verified on host {date}"` pointing at the commit landed in this iteration. **AC:** `git tag -l v1.0.1 -n50` shows the new annotation; `git rev-parse v1.0.1` points at this iteration's commit (NOT `d9883d4`); **no `git push --tags`**. **Dep:** R-W.8. **Risk:** Re-tagging to a different commit is a write-state on the local repo — operator must `git push --force origin v1.0.1` later to update GitHub if v1.0.1 was already pushed (it was NOT — Phase v1.0.1 sign-off says "operator owns the push"). Documented in the new sign-off section. **Files touched:** `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` (mutate verdict + task tally + exit gate). **Diff size:** ~80–120 LOC of markdown changes.

- [ ] **R-W.10** — Final review files. Write `docs/tasks/blackhole-wizard/T-W.5-review.md` + `docs/tasks/blackhole-wizard/T-W.7-review.md` (with the standard 5-checkbox set: no Phase 1–4 regression / permission UX rationale visible / idempotent / rollback safe / no `git push`). Plus `docs/tasks/blackhole-wizard-fix/R-W.<2..9>-review.md` per-step audit (one short doc each — ~50 LOC: what was changed, why, what tests cover it). Plus this `INDEX.md` checkbox flips for all 10 R-W rows. **AC:** all 10 R-W boxes ticked; T-W.5 + T-W.7 review docs match the test counts captured in R-W.8; markdown link audit (each cross-ref resolves). **Dep:** R-W.9. **Risk:** Doc drift if review docs differ from landed code — mitigated by writing R-W.10 LAST. **Files touched:** `docs/tasks/blackhole-wizard/T-W.5-review.md` (NEW), `docs/tasks/blackhole-wizard/T-W.7-review.md` (NEW), `docs/tasks/blackhole-wizard-fix/R-W.<2..9>-review.md` × 8 (NEW), `docs/tasks/blackhole-wizard-fix/INDEX.md` (10 checkboxes flip). **Diff size:** ~600–900 LOC of markdown.

---

## Dependency Graph (ASCII)

```
        ┌──────────────────────────────────────────────────────────────┐
        │  Wizard v1.0.1 carry-forward (NOT re-implemented):           │
        │   PHASE-COMPLETE.md verdict CODE-COMPLETE-PENDING-HOST-VERIFY│
        │   T-W.2/T-W.3/T-W.4 detection + install + configure (landed) │
        │   T-W.6 SetupWizard.tsx FSM (landed; props-injected invoker) │
        │   T-W.9 e2e fixture file types (interface-pinned)            │
        │   experiments/T-0.2/blackhole_capture.swift (Swift blueprint)│
        │   crates/audio-capture/src/source.rs AudioSource trait       │
        └──────┬───────────────────────────────────────────────────────┘
               ▼
         ┌──────────┐
         │  R-W.1   │  Plan + INDEX (this commit)
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.2   │  Fix 11 Debug derive errors
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.3   │  Fix WavFileSource::next_chunk
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.4   │  T-W.5 verify FFI body + 4 unit tests
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.5   │  settingsStore.setupCompleted (T-W.7 part A)
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.6   │  Tauri command wrappers × 4 (T-W.7 part B)
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.7   │  App.tsx wizard mount + 4 RTL (T-W.7 part C)
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.8   │  Test sweep + metrics
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.9   │  PHASE-COMPLETE bump + re-tag v1.0.1
         └────┬─────┘
              ▼
         ┌──────────┐
         │  R-W.10  │  Final review files + INDEX checkbox flips
         └──────────┘
```

Critical path: **R-W.1 → R-W.2 → R-W.3 → R-W.4 → R-W.5 → R-W.6 → R-W.7 → R-W.8 → R-W.9 → R-W.10** (10 hops, strict serial — every step's AC depends on the prior step's compile-or-test-green outcome). No parallel branches: R-W.2 + R-W.3 must precede R-W.4 because R-W.4 writes a NEW Rust file in the same workspace that must build cleanly; R-W.5 must precede R-W.6 because the Tauri commands return responses consumed by the TS settings store; R-W.6 must precede R-W.7 because App.tsx invokes the commands. R-W.8 gates R-W.9 + R-W.10 (no sign-off without green test sweep).

Cross-loop dependencies:

| Fix-loop work | Depends on wizard v1.0.1 landed task |
|---|---|
| R-W.2 Debug derives | T-3.1 / T-3.2 / T-3.4 trait + adapter signatures (frozen) |
| R-W.3 WavFileSource::next_chunk | T-1.3 `AudioSource` trait API (frozen) |
| R-W.4 verify.rs FFI body | T-W.4 `BlackHoleStatus::Verified` variant + closed `VerifyError` set declared in `PHASE-COMPLETE.md` line 66 |
| R-W.5 settingsStore.setupCompleted | Phase 3 T-3.9 + Phase 4 T-4.2 `coerceLoaded` zero-fill pattern |
| R-W.6 Tauri commands | T-W.2 / T-W.3 / T-W.4 / R-W.4 helper-daemon function signatures |
| R-W.7 App.tsx mount | T-W.6 `<SetupWizard onDone setupInvoker />` props contract (frozen) |
| R-W.8 metrics doc | All prior wizard task plans + reviews |
| R-W.9 PHASE-COMPLETE bump | The full `PHASE-COMPLETE.md` from `d9883d4` (mutated in place) |
| R-W.10 review files | All R-W.<2..9> commits + the wizard's `T-W.5-verify.md` + `T-W.7-integration.md` specs from R-W.4 + R-W.7 |

---

## TDD per task

| Task | Harness | Notes |
|---|---|---|
| R-W.1 | Doc-only review (this INDEX) | No code; AC = INDEX has dep graph + naming + baselines table |
| R-W.2 | `cargo test --workspace --no-run` | 0 errors; existing tests still compile |
| R-W.3 | `cargo test -p audio-capture` | The test that calls `next_chunk` passes (no rewrite of trait) |
| R-W.4 | `cargo test -p audio-capture verify::` | 4 unit tests via `MockAudioStream` seam; zero real CoreAudio |
| R-W.5 | `bun test src/store/settingsStore.test.ts` | ≥ 3 new tests; existing tests green |
| R-W.6 | `cargo test -p meeting-copilot` (or wherever `lib.rs` `#[test]` sit) | 4 dispatch-shape tests; argv = command name |
| R-W.7 | `bun test src/App.test.tsx` | 4 RTL tests pinned in wizard INDEX line 62 |
| R-W.8 | Manual sweep — capture per-suite numbers | No new code; metrics doc only |
| R-W.9 | `git tag -l v1.0.1 -n50` + `git rev-parse v1.0.1` | Annotation matches; commit pointer matches HEAD |
| R-W.10 | Doc-only review + markdown link audit | All cross-refs resolve; checkboxes flipped |

---

## Acceptance Criteria Summary

| Task | Numeric AC |
|---|---|
| R-W.1 | INDEX exists; dep graph + naming convention + baselines table; commit landed; no push |
| R-W.2 | `cargo test --workspace --no-run` reports 0 errors (was 12) |
| R-W.3 | `cargo test -p audio-capture` builds; `next_chunk` resolves |
| R-W.4 | 4 unit tests green; `T-W.5-verify.md` spec committed; mock seam covers all 4 cases |
| R-W.5 | `setupCompleted: boolean` field with `coerceLoaded` zero-fill; ≥ 3 new vitest cases |
| R-W.6 | 4 Tauri commands registered + 4 cargo `#[test]` green; command names match TS invoker |
| R-W.7 | 4 RTL tests green; `bun test` ≥ 938; `T-W.7-integration.md` umbrella spec committed |
| R-W.8 | `cargo test --workspace` + `bun test` + `bun run typecheck` all green; metrics doc committed |
| R-W.9 | `PHASE-COMPLETE.md` verdict bumped; `v1.0.1` tag re-cut at HEAD; **no `git push --tags`** |
| R-W.10 | All 10 R-W boxes ticked; T-W.5 + T-W.7 review docs match test counts; markdown links resolve |

---

## Process Rules (loop-binding — same shape as wizard v1.0.1)

1. **Task file per task** — `docs/tasks/blackhole-wizard-fix/R-W.<N>-*.md` for fix-loop work; T-W.5 + T-W.7 spec + review files write to `docs/tasks/blackhole-wizard/`.
2. **TDD strict** — every Rust fix goes through `cargo test --workspace --no-run` first (R-W.2 + R-W.3) then `cargo test --workspace` (R-W.4 onward). Every TS change goes through `bun test` + `bun run typecheck`.
3. **Code review per task** — `R-W.<N>-review.md` (R-W.10 writes these in batch) with explicit checkboxes:
   - [ ] No regression vitest ≥ 934 (wizard v1.0.1 baseline)
   - [ ] `cargo test --workspace` ALL GREEN (pre-fix: 12 errors)
   - [ ] No `git push` performed
   - [ ] Idempotent (re-run wizard does not break post-completion)
   - [ ] `setupCompleted` field migration safe (default `false`, no break for existing user)
4. **Per-task commit** — type prefixes:
   - R-W.1 → `docs(plan)`
   - R-W.2 / R-W.3 → `fix(rust)`
   - R-W.4 → `feat(setup)`
   - R-W.5 / R-W.6 / R-W.7 → `feat(ui)` (R-W.6 may use `feat(setup)` since it's Rust-side; agent decides)
   - R-W.8 → `test(sweep)`
   - R-W.9 → `chore(release)`
   - R-W.10 → `docs(review)`
   **No `git push`.**
5. **Phase test + sign-off** — R-W.8 metrics doc lands first, then R-W.9 `PHASE-COMPLETE.md` verdict bump + re-tag, then R-W.10 review files batch.

Every commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Constraints (from loop prompt)

- **NO `git push`** at any point. **NO `git push --tags`**.
- **NO regression** of Phase 1–4 vitest (wizard v1.0.1 baseline 934 — must hold).
- One iter = one task = one commit (R-W.1 lands in this commit).
- Re-tag `v1.0.1` via `git tag -d v1.0.1 && git tag -a v1.0.1 -m "..."` (R-W.9). The original tag at `d9883d4` is overwritten locally; operator's `git push origin v1.0.1` (post-sign-off) will need `--force` if `v1.0.1` was already pushed (it was NOT per `PHASE-COMPLETE.md` line 156).
- Brew + Rust toolchain are present on this host (PATH already exports `/opt/homebrew/opt/rustup/bin`); no blocked-action carry-forward this loop. Phase 0 carry-forward C-C closes by R-W.8.
- Budget: $20–$35 total loop estimate (R-W.4 verify FFI body + R-W.6 Tauri command wiring are the heaviest two).

---

## Sign-Off Trail

This INDEX flips checkboxes as each R-W step completes. Final state must show all 10 boxes ticked before R-W.10's review-file commit closes the loop. The wizard's own `PHASE-COMPLETE.md` is the canonical sign-off — this INDEX is the audit trail of how the deferred work + the cargo errors got cleared.
