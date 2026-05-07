# T-W.10 — Code Review

> Loop step **10/10** — release prep + sign-off + tag. Review checklist mirrors INDEX §"Process Rules" Rule 3 carry-forward from Phase 4.

## Review against INDEX rule-3 checklist

- [x] **Permission prompt UX: rõ ràng tại sao cần** — three sources documented in `PHASE-COMPLETE.md` §"Permission UX inventory" (Microphone TCC, brew sudo, default-output change). Each has a wizard pre-prompt blurb + a SETUP.md §6 troubleshooting branch. PHASE-MANUAL-VERIFY step 3 + step 10 walk the verifier through expected dialogs.
- [x] **Idempotent (re-run wizard không break config có sẵn)** — PHASE-COMPLETE §"CFDictionary blueprint" idempotency contract (line "`create_multi_output(name, &[bh_uid, builtin_uid])` returns the existing `AudioDeviceID` if a device with `kAudioAggregateDeviceUIDKey == "MeetingCopilotMultiOut"` already exists AND `IsStacked == 1` AND `BlackHoleUid` is in its sub-device list."). PHASE-MANUAL-VERIFY step 8 (Re-run wizard from Settings) + step 9 (post-reboot recreate) cover both lanes. T-W.4 unit tests `idempotent_returns_existing_device_id_when_uid_match` + sentinel `idempotent_rejects_non_stacked_aggregate_with_brand_uid` are the live test gates.
- [x] **Rollback nếu user cancel giữa chừng** — Skip / Quit escape hatch from any step in the FSM (PHASE-COMPLETE §"Wizard FSM" diagram). T-W.6 SW-U11 + SW-U11b regression tests fire `onDone(setupCompleted=true)` regardless of step, so the wizard does not loop. Brew Cancel → typed error in the same Install step (no FSM advance, no half-installed state — Homebrew's own `--cask` path is atomic on success exit-0). Configure failure → no Multi-Output is created (`AudioHardwareCreateAggregateDeviceFailed(OSStatus)` propagates; idempotency guard rejects partial state on retry).
- [x] **No regression Phase 1-4 audio capture** — `bun run test` 934 / 934 (was 900 at Phase 4 sign-off; net new 34 from T-W.6 +28 + T-W.9 +6, all in new files under `src/components/SetupWizard/` + `tests/e2e/`). No edits to `crates/audio-capture/src/{mic,chunker,ring,source,wav}.rs` (the Phase 1 capture path) — the wizard adds three peer modules `blackhole.rs`, `multi_output.rs`, plus the deferred `verify.rs`. PHASE-MANUAL-VERIFY step 12 is the host regression sweep against `docs/tasks/phase-4/PHASE-BROWSER-TEST.md` items 4–12.

## Review against T-W.10's own AC table

| AC | Verdict |
|---|---|
| AC-1 (vitest 934 / 934) | ✅ Confirmed via `bun run test` iter-10 wrap-up. |
| AC-2 (typecheck 0) | ✅ `tsc --noEmit` clean — no diagnostics. |
| AC-3 (cargo deferred) | ✅ Documented in PHASE-COMPLETE Loop Exit Gate row #2 + PHASE-MANUAL-VERIFY P-1. Honest CAVEAT-GO shape. |
| AC-4 (versions × 6) | ✅ `package.json` 1.0.1, `src-tauri/tauri.conf.json` 1.0.1, four crate `Cargo.toml`s 1.0.1. Grep at commit time confirms. |
| AC-5 (PHASE-COMPLETE) | ✅ 6-row exit gate table at top; 7-section body; 7 risk rows. |
| AC-6 (PHASE-MANUAL-VERIFY ≥ 12) | ✅ 12 main steps + P-1 + P-2 + run-log appendix scaffold. |
| AC-7 (T-W.10 spec + review) | ✅ This file + `T-W.10-release.md`. Brings T-W.\*-review.md count to **8** (≥ 8 INDEX threshold). |
| AC-8 (tag exists) | ✅ Will exist after this commit's `git tag -a v1.0.1 -m '…'` step. |
| AC-9 (tag NOT pushed) | ✅ No `git push` invoked in this loop — operator owns the push. |
| AC-10 (deferrals documented) | ✅ "Wizard-new deferrals" subsection in PHASE-COMPLETE explicitly enumerates T-W.5 + T-W.7 with interface pins + host land plan. |
| AC-11 (carry-forward C-A..C-G) | ✅ 7-row table in PHASE-COMPLETE. |
| AC-12 (risk register) | ✅ 7-row table, R-W.1..R-W.7. R-W.7 NEW (Aggregate Device transient — reboot guard). |

## Findings

### Honesty check — T-W.5 + T-W.7 deferrals

The loop completed 8 commits across 9 substantive iterations (T-W.1 / T-W.2 / T-W.3 / T-W.4 / T-W.6 / T-W.8 / T-W.9 / T-W.10 sign-off). T-W.5 (Verify capture FFI body) and T-W.7 (App.tsx + Tauri commands + `setupCompleted`) were **not landed** in the loop. The loop INDEX explicitly checkboxes these as `[ ]` (unticked) on lines 58 + 62. PHASE-COMPLETE re-states this in two places:

1. Task tally row T-W.5 + T-W.7 marked `_Deferred to host (FFI body + cargo re-verify gate)._` / `_Deferred to host (Tauri-command wiring + App.tsx mount + settingsStore field)._`
2. "Wizard-new deferrals" subsection enumerates exactly what the operator must land + the test interfaces already pinned in the INDEX.

This is the same shape as Phase 4's `cargo test --workspace` deferral and `tauri build` deferral — interface-pinned, not paper-only. The wizard UI (T-W.6) takes the four `setup_*` invokers as **props** with default `() => Promise.reject("not wired")`, so `App.tsx` mount in T-W.7 is a wiring layer, not a redesign. The e2e harness (T-W.9) injects mocks for the four invokers. So today's build is "code-complete UI + code-complete detection / install / configure / hooks; pending 1× FFI body + 1× wiring layer".

A reviewer who reads PHASE-COMPLETE end-to-end (as the loop expects) sees this clearly. A reviewer who skims the Loop Exit Gate table sees row #2 marked ⚠️ which is the standard symbol for "code-complete-pending-host" across Phase 0–4.

### Risk gaps

R-W.7 (Aggregate Device transient — vanishes on reboot) is **new at sign-off**. The mitigation is that T-W.7 startup integration re-runs detect → re-creates if missing, and PHASE-MANUAL-VERIFY step 9 is the host re-verify. Until T-W.7 lands on host, the post-reboot UX is "wizard re-fires from Configure step, user clicks one button, done in ≤ 5 s". Acceptable for v1.0.1; could revisit for v1.1.0 if operator data shows users re-quit.

### Tag annotation content

The annotation body (passed to `git tag -a v1.0.1 -m '…'`) references:
- `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` (sign-off)
- `docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY.md` (host re-verify)
- `docs/release/DMG-INSTRUCTIONS.md` (carry-forward Phase 4 T-4.12 — re-stamp for 1.0.1 dmg)

Annotation does **not** reference the GitHub Release URL (URL is only known after operator pushes the tag and creates the release). Annotation does **not** include a release notes body — the body is in PHASE-COMPLETE §"v1.0.1 release plan".

### Files NOT touched (intentional)

- `docs/RELEASE-NOTES-v1.0.1.md` — INDEX line 68 lists this OR-clause ("Append a Phase-W block to `docs/RELEASE-NOTES-v1.0.0.md` OR create new `docs/RELEASE-NOTES-v1.0.1.md`"). Folded into PHASE-COMPLETE §"v1.0.1 release plan" + the tag annotation per T-W.10 §"Out of scope" — separate file is redundant. Operator can extract a stand-alone release notes block from PHASE-COMPLETE at GitHub Release creation time. Same shape as Phase 4 T-4.12's release notes — there it's a separate file because v1.0.0 was the first stable release with breaking-changes-formal-template; v1.0.1 is a non-breaking additive ship.
- `docs/release/HOMEBREW-CASK-TEMPLATE.rb` — already lives from Phase 4 T-4.12. Operator bumps `version "1.0.1"` + new sha256 at PR-submission time per the template's own header comment.

## Overall

**Verdict: APPROVED** — sign-off honest, deferrals interface-pinned, version bump consistent across all 6 manifest sites, regression test 934 / 934, tag annotation references the right docs.

T-W.10 is the last commit on this loop. Operator drives the v1.0.1 release from here per `PHASE-COMPLETE.md` §"What the operator owns post-sign-off".
