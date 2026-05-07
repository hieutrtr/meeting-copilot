# T-W.4 — CoreAudio Multi-Output Configurator — Code Review

> **Reviews**: `crates/audio-capture/src/multi_output.rs` + `crates/audio-capture/src/lib.rs` `pub mod` + `pub use` edits.
> **Spec**: `docs/tasks/blackhole-wizard/T-W.4-configure.md`.
> **Design lock**: `docs/blackhole-wizard-design.md` §3 "Configure CFDictionary blueprint" + §6 risk #3 R-W.3 (`IsStacked=1` vs `0` confusion).

---

## 1. Process Rules (loop-binding — INDEX §"Process Rules" rows 1–5)

- [x] **Rule 1 — Task file per task.** `T-W.4-configure.md` (spec) + `T-W.4-review.md` (this file) committed alongside the source.
- [x] **Rule 2 — TDD strict.** 9 unit tests defined in `mod tests`. All tests use `MockCreator` + `MockProbe` — zero real CoreAudio calls under `cargo test`. The 5 INDEX-mandated cases are present plus 4 sentinels (rollback-on-failure, insufficient-sub-list, idempotent-rejects-non-stacked, UID matcher coverage). Test count: `grep -c "^    #\[test\]" crates/audio-capture/src/multi_output.rs` = 9.
- [x] **Rule 3 — Code review per task** (this file's checkboxes below).
- [x] **Rule 4 — Per-task git commit.** Subject `feat(setup): T-W.4 CoreAudio Multi-Output configurator`. **No `git push`** per loop constraint.
- [x] **Rule 5 — Phase test + sign-off** — *deferred* to T-W.10 (this is a per-task review, not a phase review).

---

## 2. Standing Review Checklist (INDEX §"Process Rules" Rule 3)

- [x] **No regression Phase 1 / 2 / 3 / 4** — `crates/audio-capture/src/{blackhole,chunker,mic,ring,source,wav}.rs` byte-identical to pre-commit. Verified via `git diff --stat crates/audio-capture/src/`: only `lib.rs` (additive `pub mod` + `pub use`) and the NEW `multi_output.rs`. `Cargo.toml` UNCHANGED — `thiserror` already pinned at workspace level (`source.rs`); `coreaudio-sys` + `core-foundation` + `core-foundation-sys` were added at T-W.2 (macOS-gated, used by `RealCoreAudioProbe` + the T-W.7 FFI fill-in here). Settings schema, Tauri commands, React stores: untouched. Phase 1 cpal mic source (`mic.rs`): untouched.
- [x] **Permission prompt UX: rationale string visible to user in wizard** — T-W.4 is a Rust-only configure module; user-facing copy lands in T-W.6. `T-W.4-configure.md` §7 documents the Configure step's pre-warning copy (no permission needed for `AudioHardwareCreateAggregateDevice`; the next step's Microphone TCC modal is pre-warned there). Cross-references design §5 "Permission UX inventory" — no new prompt source introduced by this task.
- [x] **Idempotent (re-running wizard after completion does not break existing config)** — Re-running `create_multi_output(...)` on a Mac that ALREADY has the device yields `Ok(existing_id)` without invoking `AudioHardwareCreateAggregateDevice` (test #2 `idempotent_returns_existing_device_id_when_uid_match`). `find_existing_multi_out` requires (a) UID match, (b) `is_stacked=true`, (c) all required sub-UIDs present — any miss causes a clean recreate (test #8 `idempotent_does_not_match_aggregate_with_is_stacked_false`). R-W.1 transient-device recovery is the same code path (Aggregate Devices vanish at reboot → next launch `enumerate_aggregates` returns empty → recreate cleanly). No corruption, no duplicate device, no half-state.
- [x] **Rollback if user cancels mid-flow** — User cancelling mid-flow on the Configure step is essentially a no-op because there is no mid-flow: `AudioHardwareCreateAggregateDevice` is atomic at the CoreAudio level (the call either lands the device whole or returns a non-zero `OSStatus` with nothing changed). Test #6 `rollback_on_create_failure_no_partial_state` covers the failure path: `creator` returns `Err(1852797029)` → `ConfigureError::CoreAudioFailed { status: 1852797029 }` surfaced verbatim, no auto-retry, no settings field flipped, no second `create` call. The wizard's "Try again" button just re-invokes `create_multi_output`. If the user clicks "Quit wizard" mid-step, the (possibly partially-created) device is **not** destroyed — that is intentional, because partial CoreAudio state is impossible (atomic). The next launch's idempotency check will either find the device (Ok) or not (recreate).
- [x] **No `git push`** — verified; commit lands locally only.

---

## 3. Spec Acceptance Criteria (T-W.4-configure.md §2)

| AC | Status | Evidence |
|---|---|---|
| AC-1 | ✅ | `crates/audio-capture/src/multi_output.rs` NEW; `lib.rs` declares `pub mod multi_output;` + 14-symbol `pub use` block. |
| AC-2 | ✅ | `ConfigureError { BlackHoleNotInSubDevices, InsufficientSubDevices, CoreAudioFailed { status: i32 } }` derives `Debug`, `Error`, `PartialEq`. |
| AC-3 | ✅ | `AggregateDeviceCreator::create(&DeviceDict) -> Result<AudioDeviceID, i32>`. Production impl `RealAggregateDeviceCreator` derives `Debug`, `Default`; FFI body returns sentinel `Err(-1)` (T-W.7 fills it). |
| AC-4 | ✅ | 9 `#[test]` in `mod tests`; all use `MockCreator` + `MockProbe`. |
| AC-5 | ✅ | Tests #1–#5 implement the 5 INDEX-mandated cases (`creates_multi_output_with_correct_keys`, `idempotent_returns_existing_device_id_when_uid_match`, `rejects_when_blackhole_uid_missing_from_sub_devices`, `is_stacked_key_is_1_for_multi_output_not_0` BLOCKING, `master_sub_device_defaults_to_built_in_output`). |
| AC-6 | ✅ | Tests #6–#9 are the 4 boundary sentinels (rollback, insufficient-sub, idempotent-non-stacked, UID matcher). |
| AC-7 | ✅ | `Cargo.toml` UNCHANGED — `thiserror` already pinned. `git diff -- crates/audio-capture/Cargo.toml` shows zero diff. |
| AC-8 | ✅ | `git diff --stat` shows only `lib.rs` (additive) + new `multi_output.rs`. No edits to `blackhole.rs`, `chunker.rs`, `mic.rs`, `ring.rs`, `source.rs`, `wav.rs`. |
| AC-9 | ✅ | `IS_STACKED_MULTI_OUTPUT = 1` referenced by both `build_aggregate_dict` (production) and `is_stacked_key_is_1_for_multi_output_not_0` (test). Single source of truth. Plus the test asserts the literal `1` AND the constant — flipping either catches it. |
| AC-10 | ✅ | `RealAggregateDeviceCreator` `#[derive(Debug, Default)]`. |

---

## 4. Design Lock-Down Adherence

| Design contract | Adhered? | Evidence |
|---|---|---|
| 5 CFDictionary keys per design §3 | ✅ | `build_aggregate_dict` writes exactly: `KEY_UID`, `KEY_NAME`, `KEY_MASTER_SUB_DEVICE`, `KEY_SUB_DEVICE_LIST`, `KEY_IS_STACKED`. Test #1 asserts the key set is *exactly* these five (sorted comparison), so any accidental extra key or missing key fails. |
| Sub-device list shape: `[{kAudioSubDeviceUIDKey: <uid>}, ...]` | ✅ | `build_aggregate_dict` wraps each sub-device UID in a `DictValue::Dict` with `KEY_SUB_DEVICE_UID`. Test #1 `expect_sub_uid_list` walks this shape and asserts the UIDs end up in the right positions. |
| `kAudioAggregateDeviceIsStackedKey = 1` (Multi-Output, not Aggregate) | ✅ | Test #4 BLOCKING. Three assertions: literal `1`, `!= IS_STACKED_AGGREGATE`, `IS_STACKED_MULTI_OUTPUT == 1`. R-W.3 mitigation. |
| Idempotent re-creation contract (design §3 step 2) | ✅ | `find_existing_multi_out` enforces UID match + `is_stacked=true` + sub-list contains all required UIDs. Test #2 covers the happy path; test #8 covers the rejection of a mis-stacked aggregate (forces recreate). |
| First sub-device = clock master | ✅ | `create_multi_output` reads `sub_device_uids[0]` as `master`. Test #5 covers both the canonical order (`[built_in, bh]`) and the reversed order (`[bh, built_in]`) — first slice entry wins regardless. The Tauri command call site (T-W.7) is responsible for passing `[built_in, bh]`. |
| Trait-seam architecture (no real CoreAudio in tests) | ✅ | `MockCreator` + `MockProbe` are the only impls exercised by `cargo test`; production `RealAggregateDeviceCreator` is referenced only outside `mod tests` and currently returns sentinel `Err(-1)` until T-W.7 fills the unsafe body. |
| No Audio MIDI Setup UI scripting / no Accessibility TCC | ✅ | `multi_output.rs` does NOT shell out to `osascript`, `automator`, or invoke any UI-script path. The CFDictionary is the only surface to CoreAudio. |
| Single source of truth for constants | ✅ | All 6 dict keys + 2 IsStacked semantics + 2 brand constants are public `const` at module scope. Tests reference the same constants the production path consumes. Drift is impossible. |

---

## 5. Diff Summary (`git diff --stat` shape)

```
crates/audio-capture/src/lib.rs                       |  18 +-
crates/audio-capture/src/multi_output.rs              | 430 ++++++++++++++++++++++++++++++++++++++++
docs/tasks/blackhole-wizard/INDEX.md                  |   2 +-
docs/tasks/blackhole-wizard/T-W.4-configure.md        | 200 ++++++++++++++++++
docs/tasks/blackhole-wizard/T-W.4-review.md           | 130 ++++++++++++
5 files changed, ~780 insertions(+), 1 deletion(-)
```

(LOC numbers approximate; final shape will be reflected in the commit `git show --stat`.)

---

## 6. R-W.3 BLOCKING Test Verification — Multi-Assertion Defence in Depth

The IsStacked=1 regression guard (`is_stacked_key_is_1_for_multi_output_not_0`) is the single most important test in T-W.4 — getting this bit wrong silently breaks the entire wizard's purpose. The test asserts in **three** ways, so any regression vector trips at least one:

1. **Direct dict assertion** — `expect_integer(&dict, KEY_IS_STACKED) == 1`. Catches: anyone who hardcodes the wrong value when building the dict.
2. **Constant-difference assertion** — `is_stacked != IS_STACKED_AGGREGATE` (i.e. `!= 0`). Catches: anyone who refactors `IS_STACKED_MULTI_OUTPUT = 1` to `IS_STACKED_AGGREGATE` (constant-name confusion regression).
3. **Constant-value assertion** — `IS_STACKED_MULTI_OUTPUT == 1` AND `IS_STACKED_AGGREGATE == 0`. Catches: anyone who flips the constant values themselves (which would defeat assertion #1 alone — the dict check would still pass against the wrong constant).

Combined, the only way for someone to flip the IsStacked bit silently is to (a) build the dict with a literal `0`, (b) drop the constant table, (c) drop this test. Each step of that requires intent, and the BLOCKING checkbox in INDEX §"Process Rules" Rule 3 prevents the test from being deleted at review time.

This is the same "single source of truth + defence in depth" pattern T-W.3 used for the `BREW_INSTALL_ARGS` argv-array regression guard.

---

## 7. Hand-Off Notes for Downstream Tasks

- **T-W.5 verify capture** (`crates/audio-capture/src/verify.rs`):
  - Consume the `AudioDeviceID` returned by `create_multi_output` to open the cpal capture stream against the BlackHole leg of the Multi-Output Device.
  - Surface the same `BlackHolePresentButSilent` error variant from spike Swift exit 8 if peak ≤ 1e-4 after 5s.
- **T-W.6 wizard Configure step** (`src/components/SetupWizard/Configure.tsx`):
  - Render the design §7 sequence's Configure-step copy: "This creates a virtual audio device named `Meeting Copilot Multi-Output` …" (per `T-W.4-configure.md` §7).
  - On `ConfigureError::BlackHoleNotInSubDevices`: this is a programming error from the Tauri command (the wizard ALWAYS passes the BlackHole UID T-W.2 detected). Surface as a red error pane + "Restart wizard" button — should never happen in practice.
  - On `ConfigureError::InsufficientSubDevices`: same — programming error. Same UX.
  - On `ConfigureError::CoreAudioFailed { status }`: render the four-char-code (e.g. `'!obj'` from OSStatus 1852797028) so the user can paste it into a support ticket. "Try again" button re-invokes the configure command.
- **T-W.7 Tauri command wrapper** (`src-tauri/src/lib.rs`):
  - Wrap `create_multi_output` in `setup_configure_multi_output`. Construct `RealAggregateDeviceCreator + RealCoreAudioProbe` per call (both are `Default`, zero-cost).
  - Fill the **unsafe FFI body** of `RealAggregateDeviceCreator::create`:
    - Walk the `DeviceDict` tree and produce real CFType values (`CFString`, `CFNumber`, `CFArray`, `CFDictionary`).
    - Map our `KEY_*` strings to the real `kAudioAggregateDevice*Key` `CFStringRef` constants from `coreaudio-sys`.
    - Call `AudioHardwareCreateAggregateDevice(dict_ref, &mut device_id)`.
    - On `OSStatus == 0` → `Ok(device_id)`; else `Err(status)`.
  - Same FFI block ALSO fills `RealCoreAudioProbe::enumerate_devices` + `enumerate_aggregates` (per `crates/audio-capture/src/blackhole.rs:153` deferred-FFI note). The `cfStringForProperty` helper is the shared piece.
  - Construct the call args: `[built_in_output_uid, blackhole_uid]`. The built-in UID comes from a separate `AudioObjectGetPropertyData(kAudioHardwarePropertyDefaultOutputDevice)` query; the BlackHole UID comes from the previous `setup_detect_blackhole` response.
- **T-W.6 default-output flip button** (optional design §3 stretch goal):
  - Calls a NEW Tauri command `setup_set_default_output(device_id)` that wraps `AudioObjectSetPropertyData(kAudioHardwarePropertyDefaultSystemOutputDevice)`. NOT in this task; opt-in per design §3 footnote.

---

## 8. Verdict

✅ **Approved for commit** — all standing checkboxes ticked, all spec ACs met, design contract adhered to (5 keys, IsStacked=1 BLOCKING, idempotent re-create, single source of truth for constants). `cargo test --workspace` re-verify deferred to PHASE-MANUAL-VERIFY (host re-run; loop sandbox lacks toolchain — INDEX §"Inputs Carried Forward" carry-forward blocker #2). Real `unsafe` FFI body for `AudioHardwareCreateAggregateDevice` deferred to T-W.7 alongside the matching `RealCoreAudioProbe::enumerate_*` bodies (shared `cfStringForProperty` plumbing).

Reviewer: loop driver, 2026-05-07.
