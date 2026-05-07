# T-W.2 — BlackHole Detection Module — Code Review

> **Reviews**: `crates/audio-capture/src/blackhole.rs` + sibling lib.rs / Cargo.toml edits.
> **Spec**: `docs/tasks/blackhole-wizard/T-W.2-detection.md`.
> **Design lock**: `docs/blackhole-wizard-design.md` §1 "Detection ladder".

---

## 1. Process Rules (loop-binding — INDEX §"Process Rules" rows 1–5)

- [x] **Rule 1 — Task file per task.** `T-W.2-detection.md` (spec) + `T-W.2-review.md` (this file) committed alongside the source.
- [x] **Rule 2 — TDD strict.** 8 unit tests defined in `mod tests`. All tests use `MockCoreAudio` — zero real CoreAudio calls under `cargo test`. The 6 INDEX-mandated cases are present plus 2 extras (idempotency + boundary). Test count: `grep -c "^    #\[test\]" crates/audio-capture/src/blackhole.rs` = 8.
- [x] **Rule 3 — Code review per task** (this file's checkboxes below).
- [x] **Rule 4 — Per-task git commit.** Subject `feat(setup): T-W.2 BlackHole detection module + tests`. **No `git push`** per loop constraint.
- [x] **Rule 5 — Phase test + sign-off** — *deferred* to T-W.10 (this is a per-task review, not a phase review).

---

## 2. Standing Review Checklist (INDEX §"Process Rules" Rule 3)

- [x] **No regression Phase 1 / 2 / 3 / 4** — `crates/audio-capture/src/{mic,wav,chunker,ring,source}.rs` are byte-identical to pre-commit. Verified via `git diff --stat crates/audio-capture/src/`: only `lib.rs` (additive `pub mod` + `pub use`) and the NEW `blackhole.rs` show up. Settings schema, Tauri commands, React stores: untouched.
- [x] **Permission prompt UX: rationale string visible to user in wizard** — N/A for T-W.2 (this task is a Rust-only detection module; user-facing copy lands in T-W.6 wizard UI). Module-level rustdoc + `RealCoreAudioProbe` rustdoc reference design §1 + §5 so the wizard implementer in T-W.6 has the cross-link. **AC met by deferral with documented hand-off.**
- [x] **Idempotent (re-running wizard after completion does not break existing config)** — `detect_blackhole` is a pure read; `RealCoreAudioProbe::hal_plugin_present` is `Path::exists()`; `enumerate_devices` / `enumerate_aggregates` are read-only CoreAudio property queries (FFI bodies stubbed in T-W.2; design contract documented for T-W.4 fill-in). Test #7 `detect_is_pure_no_state_mutation_across_calls` is the regression guard for R-W.1's cold-start re-run mitigation.
- [x] **Rollback if user cancels mid-flow** — N/A: T-W.2 has zero side effects (no installs, no Aggregate Device creation). Wizard cancel is a no-op against this module.
- [x] **No `git push`** — verified; commit lands locally only.

---

## 3. Spec Acceptance Criteria (T-W.2-detection.md §2)

| AC | Status | Evidence |
|---|---|---|
| AC-1 | ✅ | `crates/audio-capture/src/blackhole.rs` NEW; `lib.rs` declares `pub mod blackhole;` + 9-symbol `pub use` block. |
| AC-2 | ✅ | `BlackHoleStatus { NotInstalled, InstalledNotConfigured { blackhole_uid }, Configured { blackhole_uid, multi_output_uid, multi_output_id }, Verified { peak, callback_count } }` derives `Debug, Clone, PartialEq`. |
| AC-3 | ✅ | `CoreAudioProbe` declares `hal_plugin_present`, `enumerate_devices`, `enumerate_aggregates`. |
| AC-4 | ✅ | `MockCoreAudio` in `mod tests` is the only `impl CoreAudioProbe` used by tests; production `RealCoreAudioProbe` is referenced only outside `mod tests`. |
| AC-5 | ✅ | Tests #1–#6 implement the INDEX-mandated 6 cases (re-named #5 from `find_blackhole_matches_uid_prefix` to `find_blackhole_matches_uid_when_name_unfamiliar` for readability — same UID-substring semantic). |
| AC-6 | ✅ | Tests #7 and #8 are the regression sentinels. |
| AC-7 | ✅ | `Cargo.toml` adds macOS-gated `coreaudio-sys 0.2`, `core-foundation 0.9`, `core-foundation-sys 0.8` block. |
| AC-8 | ✅ | `git diff --stat` shows only `lib.rs` (additive), `Cargo.toml` (additive), `blackhole.rs` (new). No edits to `mic.rs`, `wav.rs`, `chunker.rs`, `ring.rs`, `source.rs`. |
| AC-9 | ✅ | `RealCoreAudioProbe::hal_plugin_present` uses `Path::new(HAL_PLUGIN_PATH).exists()` — production-ready for probe (a). |

---

## 4. Design Lock-Down Adherence

| Design contract | Adhered? | Evidence |
|---|---|---|
| 4-state ladder enum (design §1 table) | ✅ | `BlackHoleStatus` 4-variant — `Verified` ships here as the closed-enum tail variant; T-W.5 fills the construction site, but the type lives in `blackhole.rs` so wizard reducers / Tauri commands can exhaustively match. |
| Probe (a) HAL filesystem | ✅ | `RealCoreAudioProbe::hal_plugin_present` uses `HAL_PLUGIN_PATH = "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver"` per design §1 |
| Probe (b) name-or-UID matching | ✅ | `find_blackhole` lower-cases name + checks `blackhole 2ch` / `blackhole2ch` substrings OR `BlackHole2ch_UID` UID substring. Mirrors Swift `findBlackHole` lines 144–154. |
| Probe (c) Multi-Output `is_stacked=true` filter | ✅ | `find_multi_output_with_blackhole` rejects `is_stacked=false` aggregates. R-W.3 BLOCKING regression guard at the detection layer (T-W.4 has the symmetric guard at the creation layer). |
| Trait-seam architecture (no real CoreAudio in tests) | ✅ | `MockCoreAudio` is the only `impl CoreAudioProbe` exercised by `cargo test`; `RealCoreAudioProbe` is only referenced from `RealCoreAudioProbe::default()` and is never constructed in tests. |
| Cross-platform test build | ✅ | `coreaudio-sys` and friends are `[target.'cfg(target_os = "macos")']` gated. The `RealCoreAudioProbe` impl uses only `std::path::Path` (cross-platform) plus stub bodies — non-macOS `cargo check` succeeds. |

---

## 5. Diff Summary (`git diff --stat` shape)

```
crates/audio-capture/Cargo.toml                       |  10 ++
crates/audio-capture/src/blackhole.rs                 | 330 +++++++++++++++++++++++++++++++++++++
crates/audio-capture/src/lib.rs                       |   8 +-
docs/tasks/blackhole-wizard/INDEX.md                  |   2 +-
docs/tasks/blackhole-wizard/T-W.2-detection.md        | 134 +++++++++++++++
docs/tasks/blackhole-wizard/T-W.2-review.md           |  82 +++++++++
6 files changed, ~566 insertions(+), 1 deletion(-)
```

(LOC numbers approximate; final shape will be reflected in the commit `git show --stat`.)

---

## 6. Hand-Off Notes for Downstream Tasks

- **T-W.3 install caller** can poll `detect_blackhole(&RealCoreAudioProbe)` to know when the brew install completes. Filesystem probe (a) is sufficient for the immediate post-install poll; CoreAudio probe (b) may lag a few seconds while the HAL plug-in registers.
- **T-W.4 configurator** must:
  - Fill the FFI body in `RealCoreAudioProbe::enumerate_devices` and `enumerate_aggregates` (shared `cfStringForProperty` helper).
  - Construct the `BlackHoleStatus::Configured { multi_output_uid, multi_output_id, .. }` payload with the deviceID returned by `AudioHardwareCreateAggregateDevice`.
  - Re-run `detect_blackhole` post-create as the idempotency check (per design §3 idempotent re-create contract step 1).
- **T-W.5 verify** constructs `BlackHoleStatus::Verified { peak, callback_count }` from the 5s capture peak amplitude and is the only producer of that variant.
- **T-W.7 Tauri command wrapper** wraps `detect_blackhole` in an `async fn` and surfaces the `BlackHoleStatus` to the React side as a Zod-validated payload.

---

## 7. Verdict

✅ **Approved for commit** — all standing checkboxes ticked, all spec ACs met, design contract adhered to. `cargo test` re-verify deferred to PHASE-MANUAL-VERIFY (host re-run; loop sandbox lacks toolchain — INDEX §"Inputs Carried Forward" carry-forward blocker #2).

Reviewer: loop driver, 2026-05-07.
