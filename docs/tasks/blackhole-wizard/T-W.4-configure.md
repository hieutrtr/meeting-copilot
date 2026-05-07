# T-W.4 — CoreAudio Multi-Output Configurator — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.4.
> **Locks against**: `docs/blackhole-wizard-design.md` §3 "Configure CFDictionary blueprint" (5 keys, IsStacked=1) and §6 risk #3 R-W.3 (`IsStacked=1` vs `0` confusion — BLOCKING regression test).
> **Reference impl**: `crates/audio-capture/src/blackhole.rs` (T-W.2 — same trait-seam shape; `CoreAudioProbe` re-used here for idempotency).
> **Depends on**: T-W.2 (`AggregateInfo`, `CoreAudioProbe`, `BLACKHOLE_UID_HINT`, `BLACKHOLE_NAME_HINT_LOWER` re-used).
> **Blocks**: T-W.5 verify capture (consumes the `AudioDeviceID` returned here), T-W.6 wizard Configure step (renders error pane against `ConfigureError`), T-W.7 Tauri command `setup_configure_multi_output` (wraps `create_multi_output` and provides the real FFI body for `RealAggregateDeviceCreator::create`).

---

## 1. Goal

Ship the **configure layer** for the BlackHole Setup Wizard: programmatically create — or detect + reuse an existing — Multi-Output Device combining the user's built-in output with BlackHole 2ch, so system audio fans out to **both** the speakers (the user hears their meeting) and BlackHole (Meeting Copilot captures it). No Audio MIDI Setup UI scripting; no `osascript` GUI driver; no Accessibility TCC. The wizard hits `AudioHardwareCreateAggregateDevice` directly with a CFDictionary that locks `kAudioAggregateDeviceIsStackedKey = 1`.

Concretely, T-W.4 lands:

1. A new module `crates/audio-capture/src/multi_output.rs` with:
   - `pub fn create_multi_output(creator, probe, name, sub_device_uids) -> Result<AudioDeviceID, ConfigureError>` — the safe core. Idempotent re-runs return the existing device's ID without invoking CoreAudio.
   - `pub fn build_aggregate_dict(name, master_uid, sub_device_uids) -> DeviceDict` — the test-friendly CFDictionary builder. Production + tests share one builder so the regression-guard tests assert against the *exact* dict the FFI sees.
   - `pub fn find_existing_multi_out(aggregates, required_subs) -> Option<AudioDeviceID>` — idempotency probe. Rejects regular Aggregates (`is_stacked=false`) and incomplete sub-lists.
   - `pub fn looks_like_blackhole_uid(uid) -> bool` — UID-shape predicate (mirrors `find_blackhole` in `blackhole.rs`).
2. The `AggregateDeviceCreator` test seam + production stub `RealAggregateDeviceCreator` (real FFI body deferred to T-W.7 alongside the matching `RealCoreAudioProbe::enumerate_*` bodies — they share the same unsafe `coreaudio-sys` plumbing).
3. The `ConfigureError` typed enum: `BlackHoleNotInSubDevices` / `InsufficientSubDevices` / `CoreAudioFailed { status: i32 }`. `Debug` + `Error` (thiserror) + `PartialEq`.
4. Six `pub const` keys mirroring `<CoreAudio/AudioHardware.h>` (`KEY_UID`, `KEY_NAME`, `KEY_MASTER_SUB_DEVICE`, `KEY_SUB_DEVICE_LIST`, `KEY_IS_STACKED`, `KEY_SUB_DEVICE_UID`) + two semantic constants (`IS_STACKED_MULTI_OUTPUT = 1`, `IS_STACKED_AGGREGATE = 0`) + two brand constants (`MEETING_COPILOT_MULTI_OUT_UID`, `MEETING_COPILOT_MULTI_OUT_NAME`). Single source of truth — production + tests reference the same constants.
5. Nine unit tests — the 5 INDEX-mandated cases plus 4 sentinels (rollback-on-failure, insufficient-sub-list, idempotent-rejects-non-stacked, UID matcher coverage).

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | `crates/audio-capture/src/multi_output.rs` exists; `lib.rs` declares `pub mod multi_output;` and re-exports the public surface (`create_multi_output`, `build_aggregate_dict`, `find_existing_multi_out`, `looks_like_blackhole_uid`, `AggregateDeviceCreator`, `AudioDeviceID`, `ConfigureError`, `DeviceDict`, `DictValue`, `RealAggregateDeviceCreator`, all `KEY_*` consts, `IS_STACKED_*` consts, `MEETING_COPILOT_MULTI_OUT_*` consts). | ✅ landed this commit |
| AC-2 | `ConfigureError` enum has 3 variants — `BlackHoleNotInSubDevices`, `InsufficientSubDevices`, `CoreAudioFailed { status: i32 }`. Derives `Debug`, `Error` (thiserror), `PartialEq`. | ✅ |
| AC-3 | `AggregateDeviceCreator` trait declares `fn create(&self, dict: &DeviceDict) -> Result<AudioDeviceID, i32>`. Production impl `RealAggregateDeviceCreator` is `Default`-derivable; the unsafe FFI body returns sentinel `Err(-1)` (T-W.7 fills it). | ✅ |
| AC-4 | 9 `#[test]` functions in `mod tests` — all using `MockCreator` + `MockProbe`. Zero real CoreAudio calls under `cargo test`. | ✅ |
| AC-5 | The 5 INDEX-mandated cases are covered (test names): `creates_multi_output_with_correct_keys`, `idempotent_returns_existing_device_id_when_uid_match`, `rejects_when_blackhole_uid_missing_from_sub_devices`, `is_stacked_key_is_1_for_multi_output_not_0` (BLOCKING), `master_sub_device_defaults_to_built_in_output`. | ✅ |
| AC-6 | 4 additional sentinels: `rollback_on_create_failure_no_partial_state` (rollback contract from review §"Standing Checklist"), `insufficient_sub_devices_rejected_before_creator_call` (precondition), `idempotent_does_not_match_aggregate_with_is_stacked_false` (R-W.3 idempotency variant), `looks_like_blackhole_uid_handles_uid_and_name_variants` (UID matcher coverage). | ✅ |
| AC-7 | `Cargo.toml` adds **zero** new deps — `thiserror` already pinned (`source.rs`); `coreaudio-sys` + `core-foundation` + `core-foundation-sys` were added at T-W.2 (macOS-gated) for this task to consume in T-W.7 FFI fill-in. No diff this task. | ✅ verified by `git diff -- crates/audio-capture/Cargo.toml` (no diff) |
| AC-8 | No regression in Phase 1–4: `crates/audio-capture/src/{blackhole,chunker,mic,ring,source,wav}.rs` byte-identical to pre-commit. | ✅ verified by `git diff --stat crates/audio-capture/src/` (only `lib.rs` `pub mod` + `pub use` block + the NEW `multi_output.rs`) |
| AC-9 | `IS_STACKED_MULTI_OUTPUT = 1` is referenced by both `build_aggregate_dict` (production) and `is_stacked_key_is_1_for_multi_output_not_0` (test). Single source of truth — flipping the constant breaks the test. | ✅ |
| AC-10 | `RealAggregateDeviceCreator` derives `Default` (zero-cost construction at the Tauri command boundary in T-W.7). | ✅ |

---

## 3. TDD Plan

T-W.4 ships 9 unit tests against the `(AggregateDeviceCreator, CoreAudioProbe)` seam pair. Tests #1–#5 are the 5 INDEX-mandated cases; tests #6–#9 are boundary sentinels.

| # | Test | Branch covered |
|---|---|---|
| 1 | `creates_multi_output_with_correct_keys` | Empty system → call goes through. Asserts: dict key set is exactly the 5 design-§3 keys; UID = `MeetingCopilotMultiOut`; Name = supplied; Master = first sub-device; sub-list shape = `[{uid:built_in}, {uid:bh}]`. |
| 2 | `idempotent_returns_existing_device_id_when_uid_match` | Probe reports an existing Multi-Output (`uid=MeetingCopilotMultiOut`, `is_stacked=true`, sub-list contains BH) → returns that device's id; `creator.call_count() == 0`. R-W.1 (transience) recovery path AND wizard re-run safety. |
| 3 | `rejects_when_blackhole_uid_missing_from_sub_devices` | Caller passes `["BuiltInSpeakerDevice", "FocusriteScarlettUID"]` (no BH) → `Err(BlackHoleNotInSubDevices)` BEFORE calling creator. Precondition guard. |
| 4 | `is_stacked_key_is_1_for_multi_output_not_0` | **BLOCKING** (R-W.3, design §3 + §6). Asserts: dict's `KEY_IS_STACKED` integer == `1`; not equal to `IS_STACKED_AGGREGATE` (0); `IS_STACKED_MULTI_OUTPUT` constant still equals 1. Defence in depth — multiple assertions catch both `if`-branch flips and constant drift. |
| 5 | `master_sub_device_defaults_to_built_in_output` | Slice `[built_in, bh]` → master = built_in. Plus reversal sanity: `[bh, built_in]` → master = bh (the contract is "first slice entry"). |
| 6 | `rollback_on_create_failure_no_partial_state` | **Sentinel** — rollback. Mock creator returns `Err(1852797029)` (OSStatus four-char-code `'nope'`) → `ConfigureError::CoreAudioFailed { status: 1852797029 }` surfaced verbatim; no auto-retry; no partial state. |
| 7 | `insufficient_sub_devices_rejected_before_creator_call` | **Sentinel** — slice with 1 entry OR empty slice → `Err(InsufficientSubDevices)`; creator never called. Documents the `len() < 2` precondition. |
| 8 | `idempotent_does_not_match_aggregate_with_is_stacked_false` | **Sentinel** — existing aggregate has our brand UID but `is_stacked=false` (corrupt state — somehow created as a regular Aggregate). Idempotency MUST NOT short-circuit; recreate as proper Multi-Output. R-W.3 mitigation in idempotency code. |
| 9 | `looks_like_blackhole_uid_handles_uid_and_name_variants` | **Sentinel** — UID matcher coverage: `BlackHole2ch_UID`, `BlackHole2ch_UID_Variant`, `blackhole2ch` (lowercase), `BLACKHOLE 2CH` (uppercase name) all match; `BuiltInSpeakerDevice` + `FocusriteScarlettUID` do not. |

Test seams:

- **`MockCreator::queue_ok(id)` / `queue_err(status)`** — FIFO response queue. Empty queue defaults to `Ok(900)` so tests that don't care about the returned ID stay terse.
- **`MockProbe::empty()` / `with_aggregates(Vec<AggregateInfo>)`** — only `enumerate_aggregates` is exercised; the other two `CoreAudioProbe` methods are stubbed for trait completeness.
- **`expect_string` / `expect_integer` / `expect_sub_uid_list`** — helpers that pattern-match through `DictValue` so test bodies stay readable.

---

## 4. Diff Plan

| File | Verb | Diff |
|---|---|---|
| `crates/audio-capture/src/multi_output.rs` | NEW | ~430 LOC: 12 `pub const` (5 dict keys + 1 sub-key + 2 IsStacked constants + 2 brand constants + 2 unused-but-public type aliases), 4 `pub` types (`DictValue` enum, `DeviceDict` alias, `ConfigureError` enum, `AggregateDeviceCreator` trait), 1 `RealAggregateDeviceCreator` production stub, 4 `pub fn` (`create_multi_output`, `build_aggregate_dict`, `find_existing_multi_out`, `looks_like_blackhole_uid`), 9 `#[test]`. |
| `crates/audio-capture/src/lib.rs` | EDIT | +`pub mod multi_output;` and +14-symbol `pub use` block. No removals, no reordering of existing modules. |
| `crates/audio-capture/Cargo.toml` | UNCHANGED | No new deps — `thiserror` already pinned; `coreaudio-sys` + `core-foundation` + `core-foundation-sys` added at T-W.2 (macOS-gated) for T-W.7 FFI fill-in to consume. |
| `docs/tasks/blackhole-wizard/T-W.4-configure.md` | NEW | This file. |
| `docs/tasks/blackhole-wizard/T-W.4-review.md` | NEW | Review checklist (sibling file). |
| `docs/tasks/blackhole-wizard/INDEX.md` | EDIT | T-W.4 row checkbox `[ ]` → `[x]` with outcome line. |

Total: 1 NEW Rust source + 2 NEW docs + 2 EDITs (lib.rs, INDEX). ~430 LOC Rust + ~280 LOC markdown.

---

## 5. Risk Notes

| Risk | Mitigation in T-W.4 | Defer to |
|---|---|---|
| **R-W.1** Aggregate Device transience (lost at reboot). | Idempotency contract: `find_existing_multi_out` returns the existing ID without creating; on every cold-start, the wizard re-runs detect → create_multi_output, which is a no-op when the device persists and a clean recreate when it doesn't. Test #2 covers the persisted path; test #4 + #1 cover the recreate path. | T-W.7 wizard startup integration calls this on every cold-start. |
| **R-W.3** `IsStacked=1 vs 0` Multi-Output vs Aggregate confusion. CRITICAL silent failure. | Test #4 BLOCKING. Asserts `KEY_IS_STACKED` integer == 1 from the dict the creator received, NOT EQUAL to `IS_STACKED_AGGREGATE` (0), and that `IS_STACKED_MULTI_OUTPUT` constant has not drifted. Constants are public so any flip is caught at link time AND test time. | — (lands fully here) |
| **R-W.6** macOS API drift — `kAudioAggregateDeviceIsStackedKey` may be deprecated in macOS 14+. | T-W.4 uses public macOS 13+ APIs only. The constant table can be re-mapped centrally in `RealAggregateDeviceCreator::create` (T-W.7) without touching the safe core. The test seam is OS-version-agnostic. | T-W.6 wizard renders the error pane on `CoreAudioFailed`; T-W.10 release notes document tested macOS range. |
| Loop sandbox lacks `cargo` toolchain (T-W.2 + T-W.3 carry-forward). | Same as T-W.2/T-W.3 — tests are structurally complete; runtime verify deferred to PHASE-MANUAL-VERIFY (host re-run). The trait-seam architecture means test logic does NOT depend on the macOS toolchain (sync, std-only API surface in the safe core; FFI body is the only macOS-gated bit and lives in T-W.7). | T-W.10 PHASE-MANUAL-VERIFY checklist. |
| Premature FFI implementation. The `RealAggregateDeviceCreator` is structurally complete but the `unsafe` body is intentionally a sentinel `Err(-1)` until T-W.7. | Documented in module header + struct docstring + this spec §1 item 2. The sentinel ensures any accidental call from `cargo test` trips fast (typed error) instead of silently calling out to CoreAudio on a CI host. | T-W.7 FFI fill-in (shares `cfStringForProperty` plumbing with `RealCoreAudioProbe::enumerate_*` per T-W.2 deferred-FFI note in `blackhole.rs:153`). |
| Caller passes a sub-list with built-in output AT THE END (e.g. `[bh, built_in]`) — master would then default to BlackHole, which has no internal clock. | Test #5's reversal sanity check documents the contract: first slice entry IS the master, regardless of which device it is. The wizard's caller-side convention (Tauri command in T-W.7) MUST always pass `[built_in, bh]`. Cross-referenced in T-W.4-review.md §"Hand-Off Notes for T-W.7". | T-W.7 Tauri command construction. |

---

## 6. Verification Trail

- `crates/audio-capture/src/multi_output.rs` exists (this commit).
- `crates/audio-capture/src/lib.rs` declares `pub mod multi_output;` + 14-symbol `pub use` block.
- 9 `#[test]` declarations grep-able via `grep -c "^    #\[test\]" crates/audio-capture/src/multi_output.rs`.
- Sibling review file `T-W.4-review.md` ticks all checkboxes.
- `INDEX.md` row T-W.4 flips `[ ]` → `[x]` with outcome `9 tests defined (5 INDEX-mandated + 4 sentinels); IsStacked=1 BLOCKING regression guard with multi-assertion defence in depth; idempotency rejects is_stacked=false aggregates; zero new deps; cargo re-verify deferred to PHASE-MANUAL-VERIFY`.
- Commit subject `feat(setup): T-W.4 CoreAudio Multi-Output configurator`.

---

## 7. Permission UX Hand-Off (design §5 row #3)

The Configure step in the wizard (T-W.6) does NOT trigger any macOS modal — `AudioHardwareCreateAggregateDevice` does not require TCC nor admin privileges (it operates on the user's own CoreAudio session). However the wizard's "Verify" step (T-W.5) WILL trigger the Microphone TCC modal the first time it captures from the new Multi-Output Device. The Configure step's pre-warning copy stays brief:

> "This creates a virtual audio device named `Meeting Copilot Multi-Output` that combines your speakers with BlackHole. macOS won't ask for any permissions for this step. The next step (Verify) may ask for microphone access."

The optional default-output flip (design §3 footnote — making the new Multi-Output the system default output) is OUT OF SCOPE for T-W.4. If T-W.6 wires it up, the call site is `AudioObjectSetPropertyData(kAudioHardwarePropertyDefaultSystemOutputDevice)` — same pattern as T-W.4's CFDictionary write but a different selector.

T-W.6 unit test `configure_step_pre_warning_copy_present` will assert this rationale renders.

---

## 8. Out of Scope (intentional)

- **Real `unsafe` FFI body** for `RealAggregateDeviceCreator::create` — lands T-W.7 alongside the matching `RealCoreAudioProbe::enumerate_devices` / `enumerate_aggregates` FFI bodies (shared `cfStringForProperty` helper per `blackhole.rs:153` deferred-FFI note).
- **Tauri command `setup_configure_multi_output`** — lands T-W.7 (`src-tauri/src/lib.rs`); wraps `create_multi_output(RealAggregateDeviceCreator::default(), RealCoreAudioProbe::default(), ...)`.
- **Default-output flip** (`AudioObjectSetPropertyData(kAudioHardwarePropertyDefaultSystemOutputDevice)`) — design §3 footnote stretch goal; lands T-W.6 if scope allows, otherwise documented in T-W.8 SETUP.md.
- **Wizard Configure step React component** — lands T-W.6 (`src/components/SetupWizard/Configure.tsx`).
- **Aggregate destroy + recreate** when the existing device's sub-list mismatches. Design §3 lists this as a "step 3" path, but T-W.4 ships only the simpler "create new" branch — the destroyed-vs-misconfigured state is rare (would require the user to manually edit the device in Audio MIDI Setup) and recreating with the same UID is permitted by CoreAudio. T-W.7 may upgrade to explicit destroy if the host verify reveals a duplicate-device class of bug.
- **Per-device volume / channel-map config** — Multi-Output Devices accept a `kAudioAggregateDeviceClockDeviceKey` and per-sub-device gain settings; T-W.4 leaves these at defaults. The wizard's purpose is "audio reaches both legs," not "audio engineering." Documented as future work in T-W.8.
