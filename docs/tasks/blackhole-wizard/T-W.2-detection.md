# T-W.2 — BlackHole Detection Module — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.2.
> **Locks against**: `docs/blackhole-wizard-design.md` §1 "Detection ladder" (4-state `BlackHoleStatus` enum, 4 promotion probes a/b/c/d — this task ships a/b/c; d ships in T-W.5).
> **Reference impl**: `experiments/T-0.2/blackhole_capture.swift:98-167` — Swift `enumerateDevices()` + `findBlackHole(_:)` ported into Rust verbatim except for language idiom.
> **Depends on**: T-W.1 (design memo + INDEX landed in `81fe701`).
> **Blocks**: T-W.3 (install caller polls `detect_blackhole()` to know when to stop), T-W.4 (configure module re-uses `find_blackhole` to look up sub-device UID), T-W.5 (verify reuses `BlackHoleStatus::Verified` variant), T-W.7 (Tauri command `setup_detect_blackhole` wraps this module).

---

## 1. Goal

Ship the **detection layer** for the BlackHole Setup Wizard:

1. A 4-variant `BlackHoleStatus` enum mirroring the 4-state ladder from design §1.
2. A 3-method `CoreAudioProbe` trait that abstracts CoreAudio + filesystem so tests run with zero real `AudioObject*` calls.
3. A `detect_blackhole(probe)` free function that runs probes (a)+(b)+(c) and returns a `BlackHoleStatus` short of `Verified` (which is T-W.5's promotion).
4. Helper free functions `find_blackhole`, `find_multi_output_with_blackhole` mirroring the Swift originals.
5. A `RealCoreAudioProbe` skeleton with HAL-path filesystem probe wired and CoreAudio FFI bodies stubbed for T-W.4 fill-in (the `cfStringForProperty` plumbing is shared with the `AudioHardwareCreateAggregateDevice` path and lands as one block in T-W.4).
6. 8 unit tests using a `MockCoreAudio` struct — covering each branch of the promotion ladder + 2 idempotency / regression sentinels.

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | `crates/audio-capture/src/blackhole.rs` exists; `crates/audio-capture/src/lib.rs` declares `pub mod blackhole;` and re-exports `BlackHoleStatus`, `DeviceInfo`, `AggregateInfo`, `CoreAudioProbe`, `RealCoreAudioProbe`, `detect_blackhole`, `find_blackhole`, `find_multi_output_with_blackhole`. | ✅ landed this commit |
| AC-2 | `BlackHoleStatus` is a 4-variant enum: `NotInstalled`, `InstalledNotConfigured`, `Configured`, `Verified` — derives `Debug`, `Clone`, `PartialEq`. | ✅ verified by `git diff` |
| AC-3 | `CoreAudioProbe` trait declares 3 methods: `hal_plugin_present` (probe a), `enumerate_devices` (probe b source), `enumerate_aggregates` (probe c source). | ✅ |
| AC-4 | 8 `#[test]` functions in `mod tests` — all using `MockCoreAudio` (zero real CoreAudio calls). | ✅ |
| AC-5 | The 6 INDEX-mandated cases are covered: `not_installed_when_neither_hal_nor_device`, `installed_when_hal_present_but_not_in_device_list`, `configured_when_multi_output_includes_bh_uid`, `find_blackhole_matches_name_case_insensitive`, `find_blackhole_matches_uid_when_name_unfamiliar` (UID-prefix variant), `find_multi_output_rejects_aggregate_without_bh`. | ✅ |
| AC-6 | 2 additional regression sentinels: `detect_is_pure_no_state_mutation_across_calls` (idempotency for R-W.1 cold-start re-run), `installed_not_configured_when_device_visible_but_no_multi_output`. | ✅ |
| AC-7 | `Cargo.toml` adds macOS-gated CoreAudio FFI deps (`coreaudio-sys`, `core-foundation`, `core-foundation-sys`) so T-W.4 can fill in the FFI bodies without a follow-up dep bump. | ✅ |
| AC-8 | No regression in Phase 1–4: `crates/audio-capture/src/{mic,wav,chunker,ring,source}.rs` untouched. | ✅ verified by `git diff --stat` (only `blackhole.rs` NEW + `lib.rs` `pub use` block + `Cargo.toml` macOS-gated dep block) |
| AC-9 | `RealCoreAudioProbe::hal_plugin_present` uses `std::fs::Path::new(HAL_PLUGIN_PATH).exists()` — production path immediately functional for probe (a) without any FFI. | ✅ |

---

## 3. TDD Plan

T-W.2 ships 8 unit tests against the `CoreAudioProbe` trait via a `MockCoreAudio` mock. The 6 INDEX-required cases are tests #1–#6; the 2 extras are belt-and-braces sentinels for the loop's R-W.1 mitigation (cold-start idempotent re-run) and the design §1 promotion ladder boundary (`InstalledNotConfigured` when device visible but no Multi-Output).

| # | Test | Branch covered |
|---|---|---|
| 1 | `not_installed_when_neither_hal_nor_device` | HAL absent + device list lacks BlackHole → `NotInstalled` (covers Swift exit 7) |
| 2 | `installed_when_hal_present_but_not_in_device_list` | HAL present, device list does NOT yet show BlackHole (transient post-install / pre-reboot). Promotes to `InstalledNotConfigured` with empty UID. Wizard's "I've installed, retry" branch then re-runs detect. |
| 3 | `configured_when_multi_output_includes_bh_uid` | Full happy path: HAL present + device shows BlackHole + `is_stacked=1` Aggregate sub-list contains BH UID → `Configured`. |
| 4 | `find_blackhole_matches_name_case_insensitive` | Locale variant (`BLACKHOLE 2CH` upper-case) — `find_blackhole` lower-cases the name before substring match. |
| 5 | `find_blackhole_matches_uid_when_name_unfamiliar` | User renamed BlackHole in Audio MIDI Setup; UID `BlackHole2ch_UID` substring still wins (covers INDEX wording "matches uid prefix"). |
| 6 | `find_multi_output_rejects_aggregate_without_bh` | Two negative cases: (a) `is_stacked=true` Multi-Output that does NOT include BH UID, (b) `is_stacked=false` regular Aggregate that DOES include BH UID. Both must NOT promote to `Configured`. Plus a positive sentinel ensuring a proper `is_stacked=true` Multi-Output WITH BH does match. |
| 7 | `detect_is_pure_no_state_mutation_across_calls` | Calling `detect_blackhole` twice with the same probe yields identical results. Required for R-W.1 (Aggregate Device transience) cold-start re-run mitigation. |
| 8 | `installed_not_configured_when_device_visible_but_no_multi_output` | Device list contains BH but `enumerate_aggregates()` returns `[]` — must promote to `InstalledNotConfigured { blackhole_uid }`, NOT `Configured`. Wizard then drives Configure step. |

---

## 4. Diff Plan

| File | Verb | Diff |
|---|---|---|
| `crates/audio-capture/src/blackhole.rs` | NEW | ~330 LOC: 5 `pub` types (`BlackHoleStatus`, `DeviceInfo`, `AggregateInfo`, `CoreAudioProbe` trait, `RealCoreAudioProbe`), 3 `pub fn` (`detect_blackhole`, `find_blackhole`, `find_multi_output_with_blackhole`), 3 `pub const` (HAL_PLUGIN_PATH, BLACKHOLE_UID_HINT, BLACKHOLE_NAME_HINT_LOWER), 8 `#[test]`. |
| `crates/audio-capture/src/lib.rs` | EDIT | +`pub mod blackhole;` and +9-symbol `pub use` block. No removals, no reordering of existing modules. |
| `crates/audio-capture/Cargo.toml` | EDIT | +`[target.'cfg(target_os = "macos")'.dependencies]` block with `coreaudio-sys 0.2`, `core-foundation 0.9`, `core-foundation-sys 0.8`. macOS-gated so cross-platform `cargo check` (CI on Linux runners, the loop sandbox) does not require the toolchain. |
| `docs/tasks/blackhole-wizard/T-W.2-detection.md` | NEW | This file. |
| `docs/tasks/blackhole-wizard/T-W.2-review.md` | NEW | Review checklist (sibling file). |
| `docs/tasks/blackhole-wizard/INDEX.md` | EDIT | T-W.2 row checkbox `[ ]` → `[x]` with outcome line. |

Total: 1 NEW Rust source + 2 NEW docs + 3 EDITs (lib.rs, Cargo.toml, INDEX). ~330 LOC Rust + ~250 LOC markdown.

---

## 5. Risk Notes

| Risk | Mitigation in T-W.2 | Defer to |
|---|---|---|
| `coreaudio-sys` FFI body in `RealCoreAudioProbe::enumerate_devices` is stub (returns `Vec::new()`) — production probe (b)+(c) does not yet read CoreAudio. | Stub is documented in module-level rustdoc + `RealCoreAudioProbe` rustdoc. Probe (a) (filesystem) IS functional immediately; mock tests cover the trait surface. | T-W.4 fills the FFI body alongside `AudioHardwareCreateAggregateDevice` — they share a `cfStringForProperty` helper, so keeping the unsafe block in one module avoids two parallel implementations of the same plumbing. |
| `kAudioAggregateDeviceIsStackedKey=1 vs 0` confusion (R-W.3 BLOCKING). | `find_multi_output_with_blackhole` rejects `is_stacked=false`. Test #6 has explicit positive + negative `is_stacked` cases. | T-W.4 has the symmetric test (`is_stacked_key_is_1_for_multi_output_not_0`) on the *creation* side — this T-W.2 test guards the *detection* side. |
| Loop sandbox lacks `cargo` toolchain. | Tests are structurally complete; runtime verify deferred to PHASE-MANUAL-VERIFY (host re-run). The trait-seam architecture means the test logic itself does NOT depend on the macOS toolchain. | T-W.10 PHASE-MANUAL-VERIFY checklist. |
| FFI deps could break cross-platform builds. | `[target.'cfg(target_os = "macos")'.dependencies]` gating: non-macOS hosts skip the FFI crates entirely. Trait impl `RealCoreAudioProbe` compiles on any OS (the FFI bodies that need gating land in T-W.4). | T-W.4 may add `#[cfg(target_os = "macos")]` on the FFI calls themselves; `RealCoreAudioProbe` stays cross-platform-buildable. |

---

## 6. Verification Trail

- `crates/audio-capture/src/blackhole.rs` exists (this commit).
- `crates/audio-capture/src/lib.rs` declares `pub mod blackhole;` with 9-symbol re-export block.
- `crates/audio-capture/Cargo.toml` adds macOS-gated FFI deps.
- 8 `#[test]` declarations grep-able via `grep -c "^    #\[test\]" crates/audio-capture/src/blackhole.rs`.
- Sibling review file `T-W.2-review.md` ticks all checkboxes.
- `INDEX.md` row T-W.2 flips `[ ]` → `[x]` with outcome `8 tests defined; FFI body deferred to T-W.4 per design §3`.
- Commit subject `feat(setup): T-W.2 BlackHole detection module + tests`.

---

*Out of scope for T-W.2 (and intentionally not implemented):*

- Real CoreAudio FFI body in `RealCoreAudioProbe::enumerate_devices` / `enumerate_aggregates` — lands T-W.4 (shared `cfStringForProperty` helper).
- The `Verified` promotion (probe d) — lands T-W.5 (`crates/audio-capture/src/verify.rs`).
- The Tauri command wrapper `setup_detect_blackhole` — lands T-W.7 (`src-tauri/src/lib.rs`).
- Wizard UI surfacing the `BlackHoleStatus` to the user — lands T-W.6 (`src/components/SetupWizard/Detect.tsx`).
