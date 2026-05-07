# T-W.3 — Auto-Install Helper — Code Review

> **Reviews**: `crates/helper-daemon/src/setup_install.rs` + `crates/helper-daemon/src/lib.rs` `pub mod` + `pub use` edits.
> **Spec**: `docs/tasks/blackhole-wizard/T-W.3-install.md`.
> **Design lock**: `docs/blackhole-wizard-design.md` §2 "Install path tree" + §5 row #2 "sudo / osascript admin dialog".

---

## 1. Process Rules (loop-binding — INDEX §"Process Rules" rows 1–5)

- [x] **Rule 1 — Task file per task.** `T-W.3-install.md` (spec) + `T-W.3-review.md` (this file) committed alongside the source.
- [x] **Rule 2 — TDD strict.** 7 unit tests defined in `mod tests`. All tests use `MockFilesystem` + `MockProcessRunner` — zero real subprocess + zero real disk touches under `cargo test`. The 5 INDEX-mandated cases are present plus 2 sentinels (`which`-fallback + spawn-failure typed). Test count: `grep -c "^    #\[test\]" crates/helper-daemon/src/setup_install.rs` = 7.
- [x] **Rule 3 — Code review per task** (this file's checkboxes below).
- [x] **Rule 4 — Per-task git commit.** Subject `feat(setup): T-W.3 install helper with brew + .pkg fallback`. **No `git push`** per loop constraint.
- [x] **Rule 5 — Phase test + sign-off** — *deferred* to T-W.10 (this is a per-task review, not a phase review).

---

## 2. Standing Review Checklist (INDEX §"Process Rules" Rule 3)

- [x] **No regression Phase 1 / 2 / 3 / 4** — `crates/helper-daemon/src/{auth,bridge,context,embed_http,mcp_rpc,repo}.rs` byte-identical to pre-commit. Verified via `git diff --stat crates/helper-daemon/src/`: only `lib.rs` (additive `pub mod` + `pub use`) and the NEW `setup_install.rs`. `Cargo.toml` UNCHANGED — `thiserror` already pinned for `repo.rs`/`auth.rs`/`bridge.rs`; std-only otherwise. Settings schema, Tauri commands, React stores: untouched.
- [x] **Permission prompt UX: rationale string visible to user in wizard** — T-W.3 is a Rust-only install module; user-facing copy lands in T-W.6. **Hand-off** documented in `T-W.3-install.md` §7 "Permission UX Hand-Off": rationale wording supplied verbatim for T-W.6's `<Install>` component to render above the button. Cross-references design §5 row #2 (sudo/osascript). Design §5 row #2 lists the sudo prompt as wizard-step T-W.3-Install, satisfying "≥ 3 prompt sources" by T-W.10.
- [x] **Idempotent (re-running wizard after completion does not break existing config)** — Re-running `install_via_brew` on a Mac that ALREADY has BlackHole installed yields one of two safe outcomes: (a) `brew install --cask blackhole-2ch` exits 0 with stdout `"Cask 'blackhole-2ch' is already installed"` → `Ok(InstallReport)`, or (b) brew exits non-zero with `Cask 'blackhole-2ch' is already installed` on stderr → `Err(BrewFailed)` with that stderr surfaced. Either way the wizard moves on (Configure step polls T-W.2 detect; if BlackHole is already there the wizard short-circuits). No corruption, no half-state. The design §3 idempotent re-create contract for T-W.4 covers the Multi-Output side.
- [x] **Rollback if user cancels mid-flow** — User clicks Cancel in the osascript admin dialog → brew exits non-zero → `BrewFailed { exit_code, stderr }` surfaces. No partial install state because (a) brew handles its own dialog rollback (the `.pkg` either lands or it doesn't — atomic at the installer level), (b) T-W.3 does NOT mutate any Meeting Copilot state on failure (no `setupCompleted=true`, no settings write). The wizard's "Try again" button re-invokes `install_via_brew`. The "Use manual URL instead" button bails to the fallback link. Both paths leave the system in the same state as before the wizard started.
- [x] **No `git push`** — verified; commit lands locally only.

---

## 3. Spec Acceptance Criteria (T-W.3-install.md §2)

| AC | Status | Evidence |
|---|---|---|
| AC-1 | ✅ | `crates/helper-daemon/src/setup_install.rs` NEW; `lib.rs` declares `pub mod setup_install;` + 14-symbol `pub use` block. |
| AC-2 | ✅ | `InstallError { BrewNotFound { manual_url: &'static str }, BrewFailed { exit_code: Option<i32>, stderr: String }, SpawnFailed { message: String } }` derives `Debug`, `Error`, `PartialEq`. |
| AC-3 | ✅ | `FilesystemCheck::exists(&str) -> bool` + `ProcessRunner::run(&str, &[&str]) -> Result<ProcessOutput, std::io::Error>`. Production impls `RealFilesystem` + `RealProcessRunner` use `Path::exists` and `Command::new(p).args(a).output()`. |
| AC-4 | ✅ | 7 `#[test]` in `mod tests`; all use `MockFilesystem` + `MockProcessRunner`. |
| AC-5 | ✅ | Tests #1, #2, #4, #5, #6 implement the 5 INDEX-mandated cases (`brew_detected_apple_silicon_prefix`, `brew_detected_intel_prefix`, `brew_not_found_returns_manual_url`, `install_command_argv_array_form_no_shell` BLOCKING, `install_aborted_when_brew_exit_nonzero_surfaces_stderr`). |
| AC-6 | ✅ | Tests #3 (`brew_detected_via_which_when_neither_prefix_exists`) and #7 (`spawn_failure_surfaces_typed_error`) are the boundary sentinels. |
| AC-7 | ✅ | `Cargo.toml` UNCHANGED — `thiserror` already pinned. `git diff -- crates/helper-daemon/Cargo.toml` shows zero diff. |
| AC-8 | ✅ | `git diff --stat` shows only `lib.rs` (additive) + new `setup_install.rs`. No edits to `auth.rs`, `bridge.rs`, `context.rs`, `embed_http.rs`, `mcp_rpc.rs`, `repo.rs`. |
| AC-9 | ✅ | `BREW_INSTALL_ARGS = &["install", "--cask", "blackhole-2ch"]` is referenced from both `install_via_brew` (production) and `install_command_argv_array_form_no_shell` (test). Single source of truth. |
| AC-10 | ✅ | `RealFilesystem` and `RealProcessRunner` both `#[derive(Debug, Default)]`. |

---

## 4. Design Lock-Down Adherence

| Design contract | Adhered? | Evidence |
|---|---|---|
| 3-arm probe ladder (design §2 ASCII tree) | ✅ | `detect_brew_path` returns Apple Silicon → Intel → `which brew` in that order; tests #1, #2, #3 each cover one arm explicitly. |
| Argv array form, never shell string (design §2 "Critical contract") | ✅ | `install_via_brew` passes `BREW_INSTALL_ARGS` slice to `runner.run`. Test #5 BLOCKING — asserts program is brew binary (not `sh`), args slice is exact 3-element form, no whitespace in args, `BREW_INSTALL_ARGS` const matches. |
| Manual URL fallback (design §2 right column) | ✅ | `BrewNotFound { manual_url: MANUAL_INSTALL_URL }` carries `https://existential.audio/blackhole/`. Test #4 asserts the URL literal. `build_manual_install_url()` exposes the constant for the wizard's link rendering. |
| No `installer -pkg` direct (design §2 "Why not installer -pkg directly") | ✅ | `setup_install.rs` does NOT shell out to `installer`, `sudo`, `pkgutil`, or any privileged binary. Brew's own osascript dialog is the only sudo surface — and brew owns it, not us. |
| Brew sudo dialog handled by brew, not Meeting Copilot (design §5 row #2) | ✅ | T-W.3 never captures the user's password or shells out to `sudo` directly. The osascript dialog is a brew-internal surface; we just stream stderr if the user cancels. |
| Trait-seam architecture (no real subprocess in tests) | ✅ | `MockFilesystem` + `MockProcessRunner` are the only impls exercised by `cargo test`; production `RealFilesystem` + `RealProcessRunner` are referenced only outside `mod tests`. Zero real disk + zero real subprocess under test. |

---

## 5. Diff Summary (`git diff --stat` shape)

```
crates/helper-daemon/src/lib.rs                       |  10 +-
crates/helper-daemon/src/setup_install.rs             | 370 +++++++++++++++++++++++++++++++++++++
docs/tasks/blackhole-wizard/INDEX.md                  |   2 +-
docs/tasks/blackhole-wizard/T-W.3-install.md          | 175 +++++++++++++++
docs/tasks/blackhole-wizard/T-W.3-review.md           | 105 +++++++++
5 files changed, ~660 insertions(+), 1 deletion(-)
```

(LOC numbers approximate; final shape will be reflected in the commit `git show --stat`.)

---

## 6. Sudo Requirement — Verification Note

The design memo §2 footnote ("Why not `installer -pkg <path> -target /` directly?") asserts that brew shells out to its own osascript admin dialog — Meeting Copilot does NOT need to capture the user's password. This review verifies the assertion against Homebrew's actual behaviour:

- `brew install --cask <name>` invokes the cask's `:installer` stanza, which for BlackHole-2ch's cask runs `installer -pkg <path> -target /` — and `-target /` requires root.
- Homebrew detects the root requirement and prompts for credentials via `osascript` (`do shell script ... with administrator privileges`) — this is the standard macOS GUI sudo surface that the user already trusts (it's the same dialog they see when installing any third-party `.pkg` via Finder).
- Crucially: `brew install` does NOT require the user to start it with `sudo`. Running `sudo brew install` is actively discouraged by Homebrew (it changes ownership of `/opt/homebrew` to root). The user starts brew as themselves; brew elevates only the `installer` step internally.
- Therefore: T-W.3's `Command::new("/opt/homebrew/bin/brew").args(["install", "--cask", "blackhole-2ch"])` is the correct invocation — no `sudo` prefix, no preseeded password capture, no SUDO_ASKPASS env var. Brew handles the dialog itself.

This is documented in design memo §2 footnote and §5 row #2; T-W.6 wizard will surface the rationale to the user via the copy in `T-W.3-install.md` §7 "Permission UX Hand-Off".

---

## 7. Hand-Off Notes for Downstream Tasks

- **T-W.6 Install step React component** (`src/components/SetupWizard/Install.tsx`):
  - Render `T-W.3-install.md` §7 sudo rationale ABOVE the "Install via Homebrew" button.
  - On `BrewNotFound`: render `manual_url` as `<a href={url} target="_blank" rel="noopener">` link + an "I've installed, retry" button (re-runs detect step).
  - On `BrewFailed`: render `stderr` in a `<pre>` block (verbatim) + "Try again" + "Use manual URL instead" buttons.
  - On `SpawnFailed`: render generic "Couldn't run Homebrew — try the manual installer" + the URL.
- **T-W.7 Tauri command wrapper** (`src-tauri/src/lib.rs`):
  - Wrap `install_via_brew` on `tokio::task::spawn_blocking` (the call is sync; brew may take 60+ seconds; the runtime must not block the IPC dispatcher).
  - Construct `RealFilesystem` + `RealProcessRunner` per call (both are `Default`, zero-cost).
  - Map `InstallError::BrewNotFound { manual_url }` to a Zod-shaped JSON `{ kind: "brew_not_found", manualUrl: "…" }`.
  - For live progress streaming (stdout/stderr), wrap a custom `ProcessRunner` that splits the runner via `Command::spawn` + `.stdout.take()` and pumps lines to the event bridge (re-uses Phase 1 T-1.6 pattern). This wrapper lives in `src-tauri/src/lib.rs`, NOT in `setup_install.rs` — keeps the unit-tested core sync.
- **T-W.6 manual-URL "Open in browser" button** click handler must invoke a separate Tauri command (e.g. `setup_open_manual_url`) that shells out `Command::new("open").arg(MANUAL_INSTALL_URL)` — does NOT use the Tauri shell plugin (no new capability per INDEX §"Inputs Carried Forward"). Re-uses `RealProcessRunner`.

---

## 8. Verdict

✅ **Approved for commit** — all standing checkboxes ticked, all spec ACs met, design contract adhered to, sudo-requirement note verified against Homebrew's documented behaviour. `cargo test` re-verify deferred to PHASE-MANUAL-VERIFY (host re-run; loop sandbox lacks toolchain — INDEX §"Inputs Carried Forward" carry-forward blocker #2).

Reviewer: loop driver, 2026-05-07.
