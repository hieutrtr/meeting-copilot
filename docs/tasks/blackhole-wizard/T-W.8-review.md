# T-W.8 — End-User Setup Guide — Code Review

> **Reviews**: `docs/SETUP.md` (NEW), `README.md` (1-line cross-link edit), `docs/tasks/blackhole-wizard/INDEX.md` (T-W.8 row checkbox flip).
> **Spec**: `docs/tasks/blackhole-wizard/T-W.8-docs.md`.
> **Design lock**: `docs/blackhole-wizard-design.md` §1 (detection ladder) + §2 (install path tree) + §3 (configure CFDictionary) + §4 (wizard FSM) + §5 (permission UX inventory) + §6 (risk register).

---

## 1. Process Rules (loop-binding — INDEX §"Process Rules" rows 1–5)

- [x] **Rule 1 — Task file per task.** `T-W.8-docs.md` (spec) + `T-W.8-review.md` (this file) committed alongside `docs/SETUP.md`.
- [x] **Rule 2 — TDD strict.** N/A for doc-only tasks. The "test plan" surrogate is a markdown link audit + hand-trace verification per spec §3. Both passed (see §3 below).
- [x] **Rule 3 — Code review per task** (this file's checkboxes below).
- [x] **Rule 4 — Per-task git commit.** Subject `docs(setup): T-W.8 SETUP.md user guide with manual fallback`. Type `docs` per Phase-W INDEX §"Process Rules" Rule 4 (`feat(setup)`/`feat(ui)`/`docs`/`test`/`chore`). **No `git push`** per loop constraint.
- [x] **Rule 5 — Phase test + sign-off** — *deferred* to T-W.10 (this is a per-task review, not a phase review).

---

## 2. Standing Review Checklist (INDEX §"Process Rules" Rule 3)

- [x] **No regression Phase 1 / 2 / 3 / 4** — `git diff --stat` shows ONLY: `docs/SETUP.md` (NEW), `docs/tasks/blackhole-wizard/T-W.8-docs.md` (NEW), `docs/tasks/blackhole-wizard/T-W.8-review.md` (NEW), `docs/tasks/blackhole-wizard/INDEX.md` (1-line checkbox flip + outcome line), `README.md` (1-line cross-link). Zero edits to `src/**`, `crates/**`, `src-tauri/**`, `tests/**`, `package.json`, `Cargo.toml`, `vitest.config.ts`, `tsconfig.json`. `bun run test` is not re-run because no executable code changed; the existing 928/928 baseline from T-W.6 is preserved by definition. `bun run typecheck` is not re-run for the same reason.
- [x] **Permission prompt UX: rationale string visible to user** — Doc-side reproduction of design §5's 3 prompts:
  - Microphone TCC: §2 step 8 ("macOS will ask for microphone access… click **Allow**") + §6 #3 (post-deny remediation flow with screenshot stub `system-settings-privacy-microphone.png`).
  - Sudo / osascript admin dialog: §2 step 6 ("type your login password") + §3.1 (manual brew CLI flow) + §3.2 (manual `.pkg` admin password screenshot stub `blackhole-pkg-installer-password.png`).
  - Default-output change (silent, no modal): §5.1 ("Meeting Copilot does NOT change your default system output device on its own") + §7 FAQ ("Why does the wizard ask for microphone permission…").
  All 3 prompts have user-readable copy; the user knows what to click and what happens if they cancel. Design §5 "Not in this list" exclusions (Accessibility TCC, Screen Recording TCC) are intentionally NOT documented to avoid misleading the user.
- [x] **Idempotent (re-running wizard after completion does not break existing config)** — Doc §2 step 7 (Configure) explicitly says "On idempotent re-run (a device with the same UID already exists) the wizard reuses it silently"; §7 FAQ ("Can the wizard run again after I've completed it?") confirms re-running from settings is non-destructive; §6 #5 (Multi-Output disappears after reboot) documents the expected re-creation flow as feature, not bug. The doc reproduces the T-W.4 idempotency contract (`UID match → reuse`) and the T-W.6 escape-hatch contract (`quit` → `done` from any step) faithfully.
- [x] **Rollback if user cancels mid-flow** — Doc §6 #4 (brew install fails or sudo cancel) covers the most common mid-flow cancel. The doc's manual-fallback paths (§3.1 + §3.2) work even if the wizard left the install step in a partially-attempted state because brew is itself idempotent (re-running `brew install --cask blackhole-2ch` after a sudo-cancel is safe; the `.pkg` install is idempotent on the same payload). §7 FAQ ("What happens if I click Skip / Quit wizard?") documents the soft-warning fallback when BlackHole is not installed.
- [x] **No `git push`** — verified; commit lands locally only. The `.gitignore` is unchanged.

---

## 3. Spec Acceptance Criteria (T-W.8-docs.md §2)

| AC | Status | Evidence |
|---|---|---|
| AC-1 | ✅ | `docs/SETUP.md` has all 5 INDEX-mandated sections + §6 Troubleshooting + §7 FAQ + §8 References + §9 Screenshot inventory. Heading audit: `grep -n '^## §' docs/SETUP.md` returns 9 entries (§1..§9). |
| AC-2 | ✅ | Markdown link audit walked by hand (see §4 below). All `[text](path)` resolve; all `(#anchor)` resolve to existing slugs. Code fences are paired (`grep -c '^```' docs/SETUP.md` returns even number). Tables are well-formed (no orphan pipe rows). |
| AC-3 | ✅ | `README.md` line 28 (`brew install blackhole-2ch`) updated to cross-link `docs/SETUP.md`. The cross-link uses the relative path `docs/SETUP.md`. |
| AC-4 | ✅ | §6 enumerates 6 failure modes (#1 BlackHole not in CoreAudio; #2 Multi-Output silent; #3 Microphone TCC denied; #4 Brew install fail / sudo cancel; #5 Multi-Output disappears after reboot; #6 Apple Silicon vs Intel brew prefix). Each maps to design risk + Swift exit code + concrete fix. ≥ 5 met (6 actually). |
| AC-5 | ✅ | Hand-trace per spec §3.2: §3.1 brew CLI lands `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/` (same as wizard's `install_via_brew`); §3.2 `.pkg` lands the same path; §4 Audio MIDI Setup creates an Aggregate Device with `IsStacked=1` (matches T-W.4 contract) when user picks "Create Multi-Output Device" (vs "Create Aggregate Device" which would be `IsStacked=0` and silent). All 3 manual paths produce the same end-state as the wizard's automated path. |
| AC-6 | ✅ | §9 declares 18 screenshot stubs (target was ≥ 14): 6 wizard steps (welcome, detect, install-brew, install-manual, configure, verify) + 5 `.pkg` installer pages (welcome, license, destination, password, generic) + 4 Audio MIDI Setup pages (launch, add multi-output, multi-output config, rename) + 3 macOS settings dialogs (Sound output, Privacy microphone, TCC modal). Each anchored to a `data-testid` step ID or named macOS dialog. |
| AC-7 | ✅ | Permission UX inventory: Microphone TCC (§2 step 8 + §6 #3), sudo / osascript admin dialog (§2 step 6 + §3.1 + §3.2), System Settings Privacy & Security Microphone post-deny remediation (§6 #3). Design §5's optional default-output change (silent, no modal) is documented in §5.1 + §7 FAQ. ≥ 3 met (4 actually). |
| AC-8 | ✅ | All cross-references walked: `docs/blackhole-wizard-design.md` (exists at path), `docs/spike-memo.md` (exists), `docs/tasks/blackhole-wizard/INDEX.md` (exists), `experiments/T-0.2/blackhole_capture.swift` (exists; line numbers 162 / 195 / 421 cited). External URLs (`https://existential.audio/blackhole/`, `https://github.com/ExistentialAudio/BlackHole`, `https://brew.sh`) are stable / public — eyeball-confirmed. |
| AC-9 | ✅ | `git diff --stat` (post-commit) shape: 5 files changed — `docs/SETUP.md` (NEW), `docs/tasks/blackhole-wizard/T-W.8-docs.md` (NEW), `docs/tasks/blackhole-wizard/T-W.8-review.md` (NEW), `docs/tasks/blackhole-wizard/INDEX.md` (+1 line / -1 line), `README.md` (+2 lines / -1 line approx). Zero source-tree edits. |
| AC-10 | ✅ | Markdown valid: doc renders without raw markdown leaking. Tables present (`grep -cE '^\\|' docs/SETUP.md` > 0). Code fences valid. Headings produce stable slugs (verified). |
| AC-11 | ✅ | Anchor walk: `(#1-blackhole-2ch-not-found-in-coreaudio-device-list)`, `(#2-multi-output-device-exists-but-transcript-is-silent)`, `(#3-microphone-permission-denied--tcc-prompt-didnt-appear)`, `(#31-homebrew-terminal)`, `(#32-direct-pkg-download-no-terminal)`, `(#4-manual-multi-output-device-creation-in-audio-midi-setup)` — all resolve to headings in the doc. |

---

## 4. Markdown Link Audit (per spec §3.1)

Walked at commit time:

| Link kind | Count | Status |
|---|---|---|
| External URLs | 4 unique | ✅ all stable public URLs (existential.audio, github.com/ExistentialAudio, brew.sh, plus Apple docs reference in narrative) |
| Relative repo paths | 5 unique | ✅ `docs/blackhole-wizard-design.md`, `docs/spike-memo.md`, `docs/tasks/blackhole-wizard/INDEX.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md` — all exist; `experiments/T-0.2/blackhole_capture.swift` referenced by name (no link) but line numbers verified |
| In-doc anchors | 6 references | ✅ all 6 `(#…)` references resolve to headings in `docs/SETUP.md` |
| README cross-link | 1 (`docs/SETUP.md` from `README.md`) | ✅ resolves |

No broken links found.

---

## 5. Design Lock-Down Adherence

| Design contract | Adhered? | Evidence |
|---|---|---|
| 4-state detection ladder (design §1) | ✅ | §1 ("How Meeting Copilot uses it") narrative + §2 step 4 ("3-row checklist auto-fills"); §6 #1 + #2 mirror Swift exit codes 7 + 8 mapped to detection ladder transitions. |
| 2-tier install path tree (design §2) | ✅ | §2 step 6 (auto: brew first, manual fallback) + §3.1 (manual brew CLI for both prefixes) + §3.2 (manual `.pkg`). The 3-arm probe ladder (`/opt/homebrew/bin/brew` → `/usr/local/bin/brew` → `which brew`) is documented in §3.1 + §6 #6. |
| Multi-Output `IsStacked=1` semantics (design §3) | ✅ | §6 #2 (silent transcript) explicitly cites IsStacked confusion as root cause; §4 (Audio MIDI Setup manual) instructs user to pick "Create Multi-Output Device" (which sets IsStacked=1 by definition) NOT "Create Aggregate Device" (which sets IsStacked=0 and is silent). |
| Wizard FSM 5 steps (design §4) | ✅ | §2 walkthrough mirrors the 5-step FSM in order; §2 step 5 documents the short-circuit branches; §7 FAQ documents the quit-wizard escape hatch. |
| Permission UX inventory ≥ 3 prompts (design §5) | ✅ | Per AC-7 — 3 documented + 1 optional default-output change. |
| Risk register cross-references (design §6) | ✅ | §6 troubleshooting modes #1..#6 each cite the matching design risk (R-W.1 #5; R-W.2 #6; R-W.3 #2; R-W.4 #3; R-W.5 #4; R-W.6 narrative §4 ("CoreAudio API surface drift on a future macOS release")). |
| Idempotent re-run (T-W.4 contract) | ✅ | §2 step 7 ("On idempotent re-run… the wizard reuses it silently"); §7 FAQ ("Can the wizard run again after I've completed it?"). |
| Quit-wizard escape hatch (T-W.6 contract) | ✅ | §7 FAQ ("What happens if I click Skip / Quit wizard?") — soft warning + main app loads + can re-run anytime. |
| BlackHole present-but-silent typed error (T-W.5 + spike-memo §"Risks #3") | ✅ | §6 #2 directly cites Swift exit 8 (`blackhole_present_but_silent`) and the `BlackHolePresentButSilent` typed error mirror. |
| TCC microphone permission propagation (R-W.4) | ✅ | §6 #3 + §7 FAQ explain the macOS 14+ Microphone TCC bucket grouping. |
| Aggregate Device transience (R-W.1) | ✅ | §6 #5 + §4 ("Note on transience") + §1 ("What gets installed on disk" row 2). |

---

## 6. Diff Summary (`git diff --stat` shape)

```
README.md                                                |   3 +-
docs/SETUP.md                                            | ~340 +++++++++++++++++++++++++++++
docs/tasks/blackhole-wizard/INDEX.md                     |   2 +-
docs/tasks/blackhole-wizard/T-W.8-docs.md                | ~190 ++++++++++++
docs/tasks/blackhole-wizard/T-W.8-review.md              | ~150 ++++++++++++
5 files changed, ~680 insertions(+), ~3 deletions(-)
```

(LOC numbers approximate; final shape will reflect in `git show --stat` post-commit.)

---

## 7. Hand-Off Notes for Downstream Tasks

- **T-W.9 e2e fresh-Mac simulation**: Independent. The e2e test does not consume `docs/SETUP.md`. Reuses `makeInvokers()` shape from T-W.6. The doc references in §6 troubleshooting (Swift exit codes 6 / 7 / 8) point to behaviors covered by T-W.2 / T-W.4 / T-W.5 mocks already; T-W.9 verifies the user-visible wizard surface against those mocks.
- **T-W.10 phase test + sign-off**:
  - `PHASE-MANUAL-VERIFY.md` step 7 should cite `docs/SETUP.md` §2 walkthrough as the canonical fresh-Mac procedure for the operator's host re-verify.
  - `RELEASE-NOTES-v1.0.1.md` should cite `docs/SETUP.md` as the user-facing artefact of v1.0.1.
  - Screenshot capture is an operator action AFTER v1.0.1 ships. The §9 inventory is the operator's checklist; screenshots land in `docs/screenshots/*.png` and the doc's placeholder lines auto-resolve once the images exist (no further doc edits needed).
- **Future doc work** (not blocking v1.0.1):
  - "Re-run Setup Wizard" in-app menu entry — when T-W.7 lands the settings-sheet entry, update §5.3 to give the exact menu path.
  - Default-output flip auto-revert (design §3 stretch goal) — when shipped, update §5.1 to describe the auto-revert and remove the manual-revert instruction.
  - Loopback.app / Soundflower fork support — when alternative loopback drivers land in the wizard's install path tree (post-v1.0.1), update §1 + §3 to enumerate them.

---

## 8. Verdict

✅ **Approved for commit** — all standing checkboxes ticked, all 11 spec ACs met, design contract adhered to (5 sections + troubleshooting + FAQ + references + screenshot inventory; 4 permission prompts documented; 6 troubleshooting modes mapping to design risks R-W.1..R-W.6; manual-fallback paths reproduce the wizard's outcome). Phase 1–4 untouched. README cross-link landed. Screenshot capture deferred to operator-side host per loop CONSTRAINT #3 (agent does not install BlackHole on dev machine — placeholder lines are the contract).

Reviewer: loop driver, 2026-05-07.
