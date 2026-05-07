# T-W.10 — Phase test + sign-off + v1.0.1 tag

> Loop step **10/10** (final). Reference: `docs/tasks/blackhole-wizard/INDEX.md` line 68. Companion: `PHASE-COMPLETE.md`, `PHASE-MANUAL-VERIFY.md`. Mirrors Phase 4 T-4.12 (release prep) shape — version bumps + sign-off + local annotated tag + release notes + carry-forward of operator-owned items.

## Goal

Land the v1.0.1 tag locally, document the gate evidence in a sign-off table, and hand the host re-verify procedure to the operator. **No `git push`** per loop Rule 4.

## Acceptance criteria

| # | AC | Evidence |
|---|---|---|
| AC-1 | `bun run test` (vitest) green — 934 / 934 across 60 files | `Test Files 60 passed (60) / Tests 934 passed (934) / Duration 2.54s` from iter-10 wrap-up. Phase 4 baseline 900 + wizard net new 34. |
| AC-2 | `bun run typecheck` exits 0 | `tsc --noEmit` clean (no diagnostics). |
| AC-3 | `cargo test --workspace` deferred per carry-forward C-C (Phase 0 → 4 chain) | Documented in `PHASE-MANUAL-VERIFY.md` P-1; re-state in `PHASE-COMPLETE.md` Loop Exit Gate row #2. |
| AC-4 | Version bumped 1.0.0 → 1.0.1 across all 6 manifest sites | `package.json#version`, `src-tauri/Cargo.toml#version`, `crates/helper-daemon/Cargo.toml#version`, `crates/audio-capture/Cargo.toml#version`, `crates/stt-mlx/Cargo.toml#version`, `src-tauri/tauri.conf.json#version`. Confirmed via grep at commit time. |
| AC-5 | `PHASE-COMPLETE.md` sign-off committed with all 6 exit-gate rows ticked | Present at `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md`. |
| AC-6 | `PHASE-MANUAL-VERIFY.md` enumerates ≥ 12 host re-verify steps (parallel to Phase 4 PHASE-BROWSER-TEST.md) | 12 main steps + 2 P-prereqs (P-1 cargo, P-2 vitest re-run) + run-log appendix scaffold. |
| AC-7 | T-W.10 task spec + review committed under `docs/tasks/blackhole-wizard/` | This file + `T-W.10-review.md`. Brings T-W.\*-review.md count to 8 (≥ 8 INDEX threshold). |
| AC-8 | Local annotated tag `v1.0.1` exists | `git tag -l v1.0.1` non-empty after this commit; tag annotation references `PHASE-COMPLETE.md` by relative path. |
| AC-9 | Tag NOT pushed | No `git push origin v1.0.1` invocation in this loop's bash history. Operator owns the push (PHASE-COMPLETE §"What the operator owns post-sign-off" item 1). |
| AC-10 | Wizard-new deferrals (T-W.5 + T-W.7) honestly documented in PHASE-COMPLETE | Two-paragraph "Wizard-new deferrals" subsection in `PHASE-COMPLETE.md` enumerates the interface-pinned contracts and the operator land plan. |
| AC-11 | Carry-forward Phase 0–4 blockers re-stated (C-A through C-G) | Table in `PHASE-COMPLETE.md` §"Carry-forward blocked user-actions" with one row per blocker. |
| AC-12 | Risk register final state captured | Table in `PHASE-COMPLETE.md` §"Risk register" with R-W.1 through R-W.7. R-W.7 is NEW at sign-off (Aggregate Device transient — vanishes on reboot). |

## Files touched

- `package.json` — version bump.
- `src-tauri/Cargo.toml` — version bump.
- `crates/helper-daemon/Cargo.toml` — version bump.
- `crates/audio-capture/Cargo.toml` — version bump.
- `crates/stt-mlx/Cargo.toml` — version bump.
- `src-tauri/tauri.conf.json` — version bump.
- `docs/tasks/blackhole-wizard/PHASE-COMPLETE.md` — NEW.
- `docs/tasks/blackhole-wizard/PHASE-MANUAL-VERIFY.md` — NEW.
- `docs/tasks/blackhole-wizard/T-W.10-release.md` — NEW (this file).
- `docs/tasks/blackhole-wizard/T-W.10-review.md` — NEW.

## Out of scope (for this commit, not the loop)

- T-W.5 (Verify capture FFI body) — deferred to host land (PHASE-COMPLETE §"Wizard-new deferrals" T-W.5 paragraph). Interface pinned in INDEX line 58.
- T-W.7 (App.tsx + Tauri-command wrappers + `setupCompleted` settings field) — deferred to host land (PHASE-COMPLETE §"Wizard-new deferrals" T-W.7 paragraph). Interface pinned in INDEX line 62.
- `bun tauri build` + DMG notarization — operator owns post-sign-off (PHASE-COMPLETE §"What the operator owns post-sign-off" item 3).
- Homebrew cask submission — operator owns (item 5).
- `git push origin main && git push origin v1.0.1` — operator owns (item 1).
- New `docs/RELEASE-NOTES-v1.0.1.md` — folded into PHASE-COMPLETE §"v1.0.1 release plan" + the tag annotation. Separate file is redundant; if the operator wants a stand-alone release notes for the GitHub Release body, they extract from PHASE-COMPLETE at push time.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-T-W.10-1 | Premature tag — sign-off committed but `cargo test --workspace` regression on host shakes out post-tag | `PHASE-COMPLETE.md` Loop Exit Gate row #2 explicitly marks cargo as **CODE-COMPLETE-PENDING-HOST-VERIFY**. The tag annotation references this gate row. If host re-run fails, the operator deletes the tag (`git tag -d v1.0.1`) and re-cuts post-fix. Same shape as Phase 4 v1.0.0 carry-forward. |
| R-T-W.10-2 | Version bump skips a manifest site → drift between wire format `package.json` and bundled `Info.plist` | Explicit grep at commit time over all 6 sites (see AC-4 evidence). Reproducible in `PHASE-MANUAL-VERIFY.md` P-2 via `bun run typecheck` (TS picks up `package.json#version` via `import meta`) + post-`tauri build` `defaults read` on the bundled `Info.plist`. |
| R-T-W.10-3 | Sign-off lands while T-W.5 + T-W.7 are unmistakably "not done" — reviewer reads it as "lying" | The "Wizard-new deferrals" subsection is **explicitly named and scoped** with task references and host land plans, mirroring Phase 4's cargo-test deferral pattern. Reviewers are expected to read PHASE-COMPLETE end-to-end; the deferrals are not buried. |

## Process compliance

- **Rule 1** (per-task file) — this file lives at `docs/tasks/blackhole-wizard/T-W.10-release.md`, mirroring T-W.1..T-W.9.
- **Rule 2** (TDD) — N/A for sign-off / tag step. Vitest baseline 934 / 934 carries; no new tests.
- **Rule 3** (review doc) — `T-W.10-review.md` committed alongside this file.
- **Rule 4** (per-task git commit, no `git push`) — single commit `chore(release): T-W.10 v1.0.1 BlackHole wizard sign-off` covering this file + sign-off doc + manual-verify doc + review + version bumps. **NO `git push`.**
- **Rule 5** (phase test + sign-off) — mirrored as Loop Exit Gate table in `PHASE-COMPLETE.md`.
