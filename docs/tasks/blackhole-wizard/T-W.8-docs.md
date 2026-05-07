# T-W.8 — End-User Setup Guide (`docs/SETUP.md`) — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.8.
> **Locks against**: `docs/blackhole-wizard-design.md` §1 (detection ladder), §2 (install path tree), §3 (configure CFDictionary), §4 (wizard FSM), §5 (permission UX inventory), §6 (risk register). The doc reproduces the *user-facing surface* of these contracts; it does NOT re-derive them.
> **Reference impl**: `docs/RELEASE-NOTES-v1.0.0.md` (Phase 4 T-4.12 — release notes structure: TL;DR, sections, footnotes); `docs/release/DMG-INSTRUCTIONS.md` (operator-action placeholder pattern); `docs/spike-memo.md` lines 81–88 (Phase 0 Risks #1 / #3 — original observations driving this wizard).
> **Depends on**: T-W.1 (`docs/blackhole-wizard-design.md` design memo — cross-referenced by section number), T-W.2 (`BlackHoleStatus` 4-variant enum + Swift exit code mapping — referenced in troubleshooting #1, #2, #3), T-W.3 (`InstallReport.brew_found` + manual URL `https://existential.audio/blackhole/` — referenced in §3.2), T-W.4 (`AudioHardwareCreateAggregateDevice` + `kAudioAggregateDeviceIsStackedKey=1` semantics — referenced in §1 + troubleshooting #2), T-W.6 (wizard step `data-testid` IDs `setup-wizard-step-{welcome,detect,install,configure,verify,done}` — anchor the screenshot stubs).
> **Blocks**: T-W.9 e2e fresh-Mac simulation (independent — runs against the wizard's prop-injected invoker surface, not the doc), T-W.10 phase test + sign-off (consumes the SETUP.md path in `PHASE-MANUAL-VERIFY.md` step 7).

---

## 1. Goal

Ship the **end-user setup guide** for the BlackHole Setup Wizard at `docs/SETUP.md`. The doc must:

1. Explain *why* BlackHole is needed (system audio capture, the macOS loopback gap).
2. Walk the user through the wizard's 5 steps + decision branches.
3. Reproduce the wizard's outcome via two manual fallback paths (Homebrew CLI; direct `.pkg` download).
4. Document the manual Multi-Output Device creation flow in Audio MIDI Setup for users whose wizard's Configure step fails.
5. Cover ≥ 5 troubleshooting modes mapped to the spike-memo Risk register and the wizard's typed errors.
6. Cross-link from `README.md` Quickstart (line 28: `brew install blackhole-2ch`) to `docs/SETUP.md`.
7. Land WITHOUT real screenshot images — declare 14+ screenshot stubs as filenames anchored to wizard `data-testid` IDs (image capture deferred to operator-side host post-release per loop CONSTRAINT #3).
8. Document the 3 macOS permission prompts the wizard surfaces (Microphone TCC, sudo / osascript admin dialog, optional default-output change) per design §5.

The doc is **markdown-only**; no code changes, no test changes. README gets one line edited (the brew install line in the Quickstart → cross-link to SETUP.md).

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | `docs/SETUP.md` exists with all 5 INDEX-mandated sections: (1) Why BlackHole, (2) Auto-install via wizard, (3) Manual install (Homebrew + .pkg), (4) Manual Multi-Output Device creation in Audio MIDI Setup, (5) Verifying audio routing. Plus mandatory §6 Troubleshooting (≥ 5 failure modes). | ✅ landed this commit |
| AC-2 | Markdown is valid: no broken anchors (`#section-name` references resolve to existing headings), no malformed code fences, no orphan list items. | ✅ |
| AC-3 | `README.md` line 28 (currently `brew install blackhole-2ch`) is updated to cross-link to `docs/SETUP.md`. The cross-link uses a relative path (`docs/SETUP.md`), not an absolute URL. | ✅ |
| AC-4 | Troubleshooting section enumerates ≥ 5 failure modes. Each is mapped to (a) the spike-memo / Swift exit code shape it mirrors, (b) the design-memo risk register entry (R-W.1..R-W.6), (c) a concrete user-actionable fix. | ✅ |
| AC-5 | Manual-fallback steps in §3 + §4 reproduce the wizard's outcome. Verified by hand-trace against T-W.2 detect logic + T-W.4 configure logic: §3 ends with the same on-disk state as the wizard's Install step (HAL plug-in present); §4 ends with the same CoreAudio device list state as Configure (Multi-Output Device with BlackHole + Built-in Output sub-list). | ✅ |
| AC-6 | Screenshot stubs declared as filenames in `docs/screenshots/` with each stub anchored to its wizard `data-testid` step ID OR the named macOS dialog. ≥ 14 stubs total: 6 wizard steps + 5 .pkg installer pages + 4 Audio MIDI Setup pages + 3 macOS settings dialogs. | ✅ |
| AC-7 | Permission UX inventory (≥ 3 prompts) reproduced in §1 + §6: (1) Microphone TCC, (2) sudo / osascript admin dialog, (3) System Settings → Privacy & Security → Microphone (the post-deny remediation flow). Each is documented with: where it appears, what to type / click, what happens if you cancel. | ✅ |
| AC-8 | Cross-references resolve: every `[link](path)` to design memo / spike memo / INDEX / experiments points to a real file at the path declared. Verified by walking each link manually against the repo file tree. | ✅ |
| AC-9 | No regression Phase 1–4: `git diff --stat` shows ONLY new docs (`docs/SETUP.md`, `docs/tasks/blackhole-wizard/T-W.8-docs.md`, `docs/tasks/blackhole-wizard/T-W.8-review.md`) + INDEX checkbox flip + 1-line README edit. Zero edits to source files (`src/**`, `crates/**`, `src-tauri/**`, `tests/**`). | ✅ |
| AC-10 | Doc-renders-valid invariant: opening `docs/SETUP.md` in any markdown renderer (GitHub web, VS Code preview, Cursor preview) shows headings, tables, code fences, and inline code without raw markdown leaking through. Verified by manual eyeball + `grep -nE '^\\s*\\|.*\\|.*\\|' docs/SETUP.md | wc -l` returning > 0 (tables present). | ✅ |
| AC-11 | TOC-friendly anchors: every `## §N Title` heading produces a stable lowercase-hyphenated anchor (`#1-blackhole-2ch-not-found-in-coreaudio-device-list`, etc.) so the in-doc cross-references (e.g. "see [§Troubleshooting #2](#2-multi-output-device-exists-but-transcript-is-silent)") resolve. Verified by walking each `#…` reference. | ✅ |

---

## 3. TDD Plan

T-W.8 is **doc-only**. There are no unit / RTL / integration tests because there is no executable surface. The "test plan" is a **markdown link audit** + a **hand-trace verification** that the manual-fallback steps reproduce the wizard's outcome.

### 3.1 Markdown link audit (manual)

Walk each `[text](path)` link and `(#anchor)` reference in the new doc:

| Link kind | Audit step |
|---|---|
| External URL (`https://existential.audio/blackhole/`, `https://github.com/ExistentialAudio/BlackHole`, `https://brew.sh`) | Eyeball — the URLs are stable, public, well-known; no fetching required. |
| Relative repo path (`docs/blackhole-wizard-design.md`, `docs/spike-memo.md`, `docs/tasks/blackhole-wizard/INDEX.md`, `experiments/T-0.2/blackhole_capture.swift`) | `ls <path>` confirms file exists. |
| In-doc anchor (`#section-title-slug`) | Confirm a heading at the named slug exists in `docs/SETUP.md`. Slugs are GitHub-flavored (lowercase, hyphenated, special chars stripped). |
| README cross-link (`docs/SETUP.md` from `README.md`) | Confirm the link resolves: `ls docs/SETUP.md`. |

### 3.2 Hand-trace manual fallback against wizard logic

Verify the manual-fallback steps in §3 + §4 of the doc produce the same on-disk + CoreAudio state as the wizard:

| Wizard step | Doc fallback section | On-disk / CoreAudio state | Match? |
|---|---|---|---|
| Install (T-W.3 `install_via_brew` + `build_manual_install_url`) | §3.1 (Homebrew CLI) + §3.2 (.pkg) | `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver/` exists | ✅ both paths drop the same `.pkg` payload |
| Configure (T-W.4 `create_multi_output` with `IsStacked=1`) | §4 (Audio MIDI Setup → Create Multi-Output Device) | CoreAudio enumerates Aggregate Device with `IsStacked=1`, sub-list = [BlackHole, Built-in Output] | ✅ Audio MIDI Setup's "Create Multi-Output Device" menu item creates an `IsStacked=1` device by definition (vs "Create Aggregate Device" which creates `IsStacked=0`). Drift Correction tick is documented as the same shape T-W.4's wizard sets. |
| Verify (T-W.5 `verify_capture`) | §5.2 (play YouTube → check transcript) | 5s capture peak > 0.001 from BlackHole device | ✅ end-to-end check: if transcript shows YouTube speech, peak > 0 |
| Detect short-circuit (T-W.2 `detect_blackhole`) | (no manual fallback — auto-runs on wizard mount) | n/a | n/a — Detect is read-only, no manual flow needed |

### 3.3 Cross-reference exhaustiveness

Confirm the doc references every Phase-W task's user-visible surface:

| Task | Wizard surface | Doc reference |
|---|---|---|
| T-W.1 | Design memo | §1 (TL;DR row 1), §6 (each troubleshooting cites design risk #), §8 (References) |
| T-W.2 | `BlackHoleStatus` 4-variant + Swift exit code mapping | §6 #1 (Swift exit 7), §6 #2 (Swift exit 8), §6 #3 (Swift exit 6) |
| T-W.3 | `install_via_brew` + manual URL | §3.1 (brew CLI), §3.2 (.pkg manual), §6 #4 (sudo cancel) |
| T-W.4 | `AudioHardwareCreateAggregateDevice` + IsStacked=1 | §1 ("How Meeting Copilot uses it" diagram), §4 (Audio MIDI Setup mirror), §6 #2 (IsStacked confusion) |
| T-W.5 | `verify_capture` peak measurement | §2 step 8 (Verify), §5.2 (transcript check), §5.3 (re-run from settings) |
| T-W.6 | Wizard FSM 5 steps + data-testids | §2 walkthrough, §9 screenshot stubs anchor to step IDs |
| T-W.7 | App-startup integration + `setupCompleted` settings | §1 ("What gets installed" row 3), §7 FAQ ("Can the wizard run again?") |
| T-W.9 | E2E simulation | (independent — not user-facing) |
| T-W.10 | v1.0.1 release | §0 header version line |

### 3.4 No code changes

`grep -E "^\\+\\+\\+ b/(src|crates|src-tauri|tests|package\\.json|Cargo\\.toml)/" <commit-diff>` returns empty (verified at commit time). The only `package.json` / `Cargo.toml` / source-tree edits in this loop happen in T-W.10 (version bump).

---

## 4. Diff Plan

| File | Verb | Diff |
|---|---|---|
| `docs/SETUP.md` | NEW | ~3 500 words / ~340 lines: §1 Why, §2 Auto-install walkthrough, §3 Manual install (brew + .pkg), §4 Manual Multi-Output in Audio MIDI Setup, §5 Verifying audio routing, §6 Troubleshooting (6 modes), §7 FAQ, §8 References, §9 Screenshot inventory. |
| `README.md` | EDIT | 1 line edit: line 28 `brew install blackhole-2ch` becomes a cross-link block to `docs/SETUP.md` with the brew command preserved as the inline default. Optional: add a 1-line note "(or run the in-app wizard on first launch — see [docs/SETUP.md](docs/SETUP.md))" next to existing Quickstart text. |
| `docs/tasks/blackhole-wizard/INDEX.md` | EDIT | T-W.8 row checkbox `[ ]` → `[x]` with outcome line. |
| `docs/tasks/blackhole-wizard/T-W.8-docs.md` | NEW | This file. |
| `docs/tasks/blackhole-wizard/T-W.8-review.md` | NEW | Review checklist (sibling file). |

**No edits to**: `package.json`, `Cargo.toml`, any `crates/**`, any `src-tauri/**`, any `src/**`, any `tests/**`, `vitest.config.ts`, `tsconfig.json`. Doc-only commit.

---

## 5. Permission UX Inventory (this task's contribution to design §5)

The doc reproduces all 3 design §5 prompts in user-readable language:

| # | Prompt | Doc location | User instruction |
|---|---|---|---|
| 1 | Microphone (TCC) modal | §2 step 8 (wizard walkthrough); §6 #3 (post-deny remediation) | "Click **Allow**." / If denied previously: System Settings → Privacy & Security → Microphone → toggle ON. |
| 2 | Sudo / osascript admin dialog | §2 step 6 (wizard install); §3.1 (manual brew); §3.2 (manual .pkg) | "Type your login password." Cancellation → fall through to manual `.pkg`. |
| 3 | Default-output change confirm (silent — no modal) | §5.1 (per-meeting routing); §7 FAQ | "System Settings → Sound → Output → click Multi-Output Device." Reversion is a click on the original device. |

The doc explicitly **excludes** Accessibility TCC and Screen Recording TCC (matching design §5 "Not in this list" rationale) — the wizard does not use those permission buckets, so documenting them would mislead.

---

## 6. Risk Posture (this task's contribution)

T-W.8 mitigates two risks directly:

- **Doc drift**. By writing T-W.8 *late* in the sequence (after T-W.6 has landed and T-W.7 has not yet), the doc reflects landed behaviour rather than aspirations. The screenshot stubs anchor to T-W.6's `data-testid` IDs (which are stable post-T-W.6 commit), so the operator capturing screenshots later won't have to chase ephemeral selectors.
- **Onboarding cliff**. A user whose wizard fails has historically had nowhere to turn except IRC / GitHub issues. The 6-mode troubleshooting section + manual-fallback paths cover the failure space identified in the design risk register (R-W.1..R-W.6) plus the spike-memo Risks #1 / #3. A user can self-serve a fix without filing an issue.

Plus one task-specific risk:

- **Screenshot capture deferred**. The doc renders complete without images; the placeholder lines are the contract. The operator captures them on a host with BlackHole installed (loop CONSTRAINT #3 — agent does not install BlackHole on dev machine). Risk = doc lands without imagery and the 14 placeholders look unprofessional. Mitigation: screenshot inventory in §9 + the placeholders explicitly call themselves out as "Screenshot placeholder" so a reader knows to ignore them rather than assume the doc is broken.

---

## 7. Hand-Off Notes for Downstream Tasks

- **T-W.9 e2e fresh-Mac simulation**: Independent. The e2e test does not consume the doc. T-W.9 drives the wizard's `SetupWizardInvokers` prop boundary (T-W.6 seam); doc references in §6 troubleshooting (Swift exit codes 6 / 7 / 8) point to tests that already cover those failure modes via T-W.2 / T-W.4 / T-W.5 mocks.
- **T-W.10 phase test + sign-off**:
  - `PHASE-MANUAL-VERIFY.md` step 7 (host re-verify on a fresh Mac) cites `docs/SETUP.md` §2 walkthrough as the canonical procedure. Operator should use the doc to walk the install on a clean macOS install.
  - Screenshot capture lands as a separate operator action AFTER v1.0.1 ships — the doc's §9 inventory is the operator's checklist. Expected location: `docs/screenshots/*.png`. Doc does NOT block on screenshot capture.
  - `RELEASE-NOTES-v1.0.1.md` (T-W.10) cites `docs/SETUP.md` as the primary user-facing artefact of v1.0.1.
- **Future work** (not blocking v1.0.1):
  - Auto-recreate Multi-Output on launch when only Configure regresses (R-W.1 — Aggregate Device transience). Doc §6 #5 documents the manual workaround; future version may hide the wizard re-mount when only Configure needs to re-run.
  - In-app **Settings → Audio → Re-run Setup Wizard** menu item. Doc §5.3 + §7 FAQ both reference this; T-W.7 may land it as a settings-sheet entry pointing to the same `<SetupWizard />` mount.
  - Default-output flip auto-revert on app quit (design §3 stretch goal). Doc §5.1 documents the manual revert as the current behaviour; future version may auto-revert.

---

## 8. Word Count + Anchor

T-W.8-docs.md: ~1 200 words (this spec). `docs/SETUP.md`: ~3 500 words (the deliverable). Total Phase-W docs landed by this task: ~4 700 words of markdown.

This spec is the lock-down point for T-W.8 — T-W.10 sign-off cites this spec by section number when ticking the per-task checkbox in `PHASE-COMPLETE.md`.
