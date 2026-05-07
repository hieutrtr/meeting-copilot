# T-W.3 — Auto-Install Helper (Homebrew + .pkg Fallback) — Spec

> **Phase**: post-v1.0 (becomes v1.0.1) — BlackHole Setup Wizard.
> **Reference**: `docs/tasks/blackhole-wizard/INDEX.md` task row T-W.3.
> **Locks against**: `docs/blackhole-wizard-design.md` §2 "Install path tree" (brew-cask first, manual `.pkg` fallback) and §5 "Permission UX" row #2 (sudo / osascript admin dialog).
> **Reference impl**: `crates/helper-daemon/src/context.rs` (sync, std-only module shape with `thiserror` typed errors — same convention).
> **Depends on**: T-W.2 (`crates/audio-capture/src/blackhole.rs` `detect_blackhole` polled by the wizard between install start and install end).
> **Blocks**: T-W.6 wizard UI Install step (consumes `InstallError` + `InstallReport` shape), T-W.7 Tauri command `setup_install_blackhole` (wraps `install_via_brew` on `tokio::task::spawn_blocking`).

---

## 1. Goal

Ship the **install layer** for the BlackHole Setup Wizard:

1. A 3-arm Homebrew probe (`/opt/homebrew/bin/brew` → `/usr/local/bin/brew` → `which brew`) returning the resolved binary path or `None`.
2. A typed `InstallError` enum with three failure surfaces — `BrewNotFound`, `BrewFailed`, `SpawnFailed` — each carrying the data the wizard needs to render an actionable error message.
3. A typed `InstallReport` carrying the resolved `brew_path` + captured stdout (so the wizard can show the user the lines Homebrew printed).
4. Two test seams — `FilesystemCheck` and `ProcessRunner` — letting unit tests inject mocks so no real brew/`which`/sudo subprocess fires under `cargo test`.
5. The argv-array form regression guard (Phase 4 R-2 reused): brew args are passed as a `&[&str]` slice, never a shell string.
6. A constant `MANUAL_INSTALL_URL = "https://existential.audio/blackhole/"` + thin accessor `build_manual_install_url()` for the wizard's brew-not-found fallback link.
7. 7 unit tests — the 5 INDEX-mandated cases plus 2 sentinels (`which`-fallback explicit + spawn-failure typed).

---

## 2. Acceptance Criteria

| # | Criterion | Verdict |
|---|---|---|
| AC-1 | `crates/helper-daemon/src/setup_install.rs` exists; `lib.rs` declares `pub mod setup_install;` and re-exports `build_manual_install_url`, `detect_brew_path`, `install_via_brew`, `FilesystemCheck`, `InstallError`, `InstallReport`, `ProcessOutput`, `ProcessRunner`, `RealFilesystem`, `RealProcessRunner`, `BREW_INSTALL_ARGS`, `BREW_PATH_APPLE_SILICON`, `BREW_PATH_INTEL`, `MANUAL_INSTALL_URL`. | ✅ landed this commit |
| AC-2 | `InstallError` enum has 3 variants — `BrewNotFound { manual_url: &'static str }`, `BrewFailed { exit_code: Option<i32>, stderr: String }`, `SpawnFailed { message: String }`. Derives `Debug`, `Error` (thiserror), `PartialEq`. | ✅ |
| AC-3 | `FilesystemCheck` trait declares `fn exists(&self, path: &str) -> bool`. `ProcessRunner` declares `fn run(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, std::io::Error>`. Production impls `RealFilesystem` + `RealProcessRunner` use `Path::exists` and `Command::new(p).args(a).output()`. | ✅ |
| AC-4 | 7 `#[test]` functions in `mod tests` — all using `MockFilesystem` + `MockProcessRunner`. Zero real subprocess + zero real disk touches under `cargo test`. | ✅ |
| AC-5 | The 5 INDEX-mandated cases are covered (test names): `brew_detected_apple_silicon_prefix`, `brew_detected_intel_prefix`, `brew_not_found_returns_manual_url`, `install_command_argv_array_form_no_shell` (BLOCKING), `install_aborted_when_brew_exit_nonzero_surfaces_stderr`. | ✅ |
| AC-6 | 2 additional sentinels: `brew_detected_via_which_when_neither_prefix_exists` (third-arm probe coverage) + `spawn_failure_surfaces_typed_error` (R-2 distinct error surface for EACCES/etc). | ✅ |
| AC-7 | `Cargo.toml` adds **zero** new deps — `thiserror` is already a workspace pin (used by `repo.rs`, `auth.rs`, `bridge.rs`). std-only otherwise. | ✅ verified by `git diff -- crates/helper-daemon/Cargo.toml` (no diff this task) |
| AC-8 | No regression in Phase 1–4: `crates/helper-daemon/src/{auth,bridge,context,embed_http,mcp_rpc,repo}.rs` byte-identical to pre-commit. | ✅ verified by `git diff --stat` (only `lib.rs` `pub mod` + `pub use` block + the NEW `setup_install.rs`) |
| AC-9 | `BREW_INSTALL_ARGS = &["install", "--cask", "blackhole-2ch"]` is a single `pub const` referenced by both production `install_via_brew` and the regression test `install_command_argv_array_form_no_shell` — single source of truth. | ✅ |
| AC-10 | `RealFilesystem` + `RealProcessRunner` derive `Default` (zero-cost construction at the Tauri command boundary in T-W.7). | ✅ |

---

## 3. TDD Plan

T-W.3 ships 7 unit tests against the `(FilesystemCheck, ProcessRunner)` seam pair. Tests #1, #2, #4, #5, #6 are the 5 INDEX-mandated cases; tests #3 and #7 are the boundary sentinels.

| # | Test | Branch covered |
|---|---|---|
| 1 | `brew_detected_apple_silicon_prefix` | Both Apple Silicon + Intel prefixes "exist" → Apple Silicon wins (priority 1); `which` is NOT invoked (assert call_count == 0). |
| 2 | `brew_detected_intel_prefix` | Only Intel prefix exists → fall through from Apple Silicon → settle on Intel; `which` is NOT invoked. |
| 3 | `brew_detected_via_which_when_neither_prefix_exists` | **Sentinel**: third-arm probe — neither prefix exists, `which brew` returns `/Users/alice/.brew/bin/brew\n` (with trailing newline trimmed). Asserts `which` was called with `["brew"]`. R-W.2 user-PATH custom prefix. |
| 4 | `brew_not_found_returns_manual_url` | No prefixes + `which` non-zero ⇒ `install_via_brew` → `BrewNotFound { manual_url: MANUAL_INSTALL_URL }`. Asserts URL matches the literal `https://existential.audio/blackhole/`. Also re-asserts `build_manual_install_url()` returns the same constant. |
| 5 | `install_command_argv_array_form_no_shell` | **BLOCKING** (Phase 4 R-2 reused). Apple Silicon prefix present, brew exits 0. Asserts: (a) program == BREW_PATH_APPLE_SILICON (NOT `sh`/`bash`/`zsh`), (b) args slice == `["install", "--cask", "blackhole-2ch"]`, (c) no individual arg contains whitespace, (d) `BREW_INSTALL_ARGS` constant matches what was passed. |
| 6 | `install_aborted_when_brew_exit_nonzero_surfaces_stderr` | Intel prefix present, brew exits 1 with realistic sudo-cancel stderr → `BrewFailed { exit_code: Some(1), stderr }` with stderr verbatim. R-W.5 sudo-cancel-race regression guard. |
| 7 | `spawn_failure_surfaces_typed_error` | **Sentinel**: brew binary "exists" per probe but spawn yields `ErrorKind::PermissionDenied` → `SpawnFailed { message }` with permission/denied phrasing. Distinct from `BrewFailed` (no stderr — brew never started). |

Test seams:

- **`MockFilesystem::with_paths(&[&str])`** — sets which paths return `true` from `exists()`.
- **`MockProcessRunner`** — records every (program, args) tuple via `RefCell<Vec<_>>`; pops queued responses FIFO. Empty queue defaults to `Ok` exit 0. Provides `last_call()` and `call_count()` for assertions.

---

## 4. Diff Plan

| File | Verb | Diff |
|---|---|---|
| `crates/helper-daemon/src/setup_install.rs` | NEW | ~370 LOC: 3 `pub const` (`BREW_PATH_APPLE_SILICON`, `BREW_PATH_INTEL`, `MANUAL_INSTALL_URL`, `BREW_INSTALL_ARGS`), 4 `pub` types (`ProcessOutput`, `InstallReport`, `InstallError`, `FilesystemCheck`/`ProcessRunner` traits), 2 production impls (`RealFilesystem`, `RealProcessRunner`), 3 `pub fn` (`detect_brew_path`, `install_via_brew`, `build_manual_install_url`), 7 `#[test]`. |
| `crates/helper-daemon/src/lib.rs` | EDIT | +`pub mod setup_install;` and +14-symbol `pub use` block. No removals, no reordering of existing modules. |
| `crates/helper-daemon/Cargo.toml` | UNCHANGED | No new deps — `thiserror` already pinned for `repo.rs`/`auth.rs`/`bridge.rs`; std-only otherwise. |
| `docs/tasks/blackhole-wizard/T-W.3-install.md` | NEW | This file. |
| `docs/tasks/blackhole-wizard/T-W.3-review.md` | NEW | Review checklist (sibling file). |
| `docs/tasks/blackhole-wizard/INDEX.md` | EDIT | T-W.3 row checkbox `[ ]` → `[x]` with outcome line. |

Total: 1 NEW Rust source + 2 NEW docs + 2 EDITs (lib.rs, INDEX). ~370 LOC Rust + ~250 LOC markdown.

---

## 5. Risk Notes

| Risk | Mitigation in T-W.3 | Defer to |
|---|---|---|
| **R-W.2** Apple Silicon vs Intel Homebrew prefix split. Hardcoding one path → silent install failure on the other architecture. | 3-arm probe ladder: `/opt/homebrew/bin/brew` → `/usr/local/bin/brew` → `which brew`. Tests #1, #2, #3 each cover one arm explicitly. | — (lands fully here) |
| **R-W.5** Brew sudo-cancel race. User clicks Cancel in the osascript admin dialog → brew exits non-zero with confusing stderr → install step appears "frozen" then errors. | `BrewFailed { exit_code, stderr }` carries stderr verbatim; test #6 asserts the realistic stderr shape (`Failure while executing; /usr/bin/sudo …`). Wizard surfaces the error inline + offers manual URL fallback within the same step (no wizard restart). | T-W.6 renders the error pane; T-W.7 streams stdout/stderr lines via mpsc to the wizard during the install. |
| **Phase 4 R-2** shell-string injection regression. Someone refactors `Command::new("brew").args([…])` into `Command::new("sh").arg("-c").arg("brew install …")` → opens cmdline injection surface. | `install_command_argv_array_form_no_shell` is BLOCKING. Asserts program is the brew binary (NOT `sh`), args is the exact 3-element slice, no arg contains whitespace, `BREW_INSTALL_ARGS` const matches. | — |
| Loop sandbox lacks `cargo` toolchain (T-W.2 carry-forward). | Tests are structurally complete; runtime verify deferred to PHASE-MANUAL-VERIFY (host re-run). The trait-seam architecture means the test logic does NOT depend on the macOS toolchain — sync, std-only. | T-W.10 PHASE-MANUAL-VERIFY checklist. |
| Streaming stdout/stderr to wizard UI for live-progress rendering. | Out of T-W.3 scope. T-W.3 ships the sync capture API (`InstallReport.stdout`); T-W.7's Tauri command wraps this on `tokio::task::spawn_blocking` and pumps lines into the existing event bridge. The sync interface is unit-testable; the streaming wrapper is integration-tested at T-W.7. | T-W.7 (`setup_install_blackhole` Tauri command) |
| `which brew` returns trailing newline on macOS — breaking string equality with the reported path. | `detect_brew_path` calls `.trim()` on stdout before returning; test #3 verifies the trim by passing `"/Users/alice/.brew/bin/brew\n"` and asserting equality without the newline. | — |

---

## 6. Verification Trail

- `crates/helper-daemon/src/setup_install.rs` exists (this commit).
- `crates/helper-daemon/src/lib.rs` declares `pub mod setup_install;` + 14-symbol `pub use` block.
- 7 `#[test]` declarations grep-able via `grep -c "^    #\[test\]" crates/helper-daemon/src/setup_install.rs`.
- Sibling review file `T-W.3-review.md` ticks all checkboxes.
- `INDEX.md` row T-W.3 flips `[ ]` → `[x]` with outcome `7 tests defined (5 INDEX-mandated + 2 sentinels); argv-array regression guard (Phase 4 R-2 reused) BLOCKING; zero new deps; cargo re-verify deferred to PHASE-MANUAL-VERIFY`.
- Commit subject `feat(setup): T-W.3 install helper with brew + .pkg fallback`.

---

## 7. Permission UX Hand-Off (design §5 row #2)

The Install step in the wizard (T-W.6) MUST render this rationale string ABOVE the "Install via Homebrew" button — the wizard implementer pulls the wording from this file verbatim:

> "You may see a macOS password prompt — that's Homebrew running the BlackHole installer. Type your login password to continue. If you cancel, we'll show you a manual download link instead."

The wording explains: (a) WHY a password is needed (brew shells out to `osascript` admin dialog because the `.pkg` writes to `/Library/Audio/Plug-Ins/HAL/`, a system path), (b) WHO owns the dialog (Homebrew, NOT Meeting Copilot — so the user shouldn't type their password into our window), (c) WHAT happens on Cancel (graceful fallback to the manual URL — not a dead-end).

T-W.6 unit test `install_step_shows_sudo_rationale_above_button` will assert the copy is rendered.

---

*Out of scope for T-W.3 (and intentionally not implemented):*

- Streaming stdout/stderr to the wizard UI live (line-by-line) — lands T-W.7 (`tokio::task::spawn_blocking` + mpsc into the event bridge).
- The Tauri command `setup_install_blackhole` wrapper — lands T-W.7 (`src-tauri/src/lib.rs`).
- The wizard Install step React component — lands T-W.6 (`src/components/SetupWizard/Install.tsx`).
- The "Open in browser" button click handler that shells out `open <url>` — lands T-W.6 (Tauri shell-plugin not used; Rust-side `Command::new("open").arg(MANUAL_INSTALL_URL)` invoked from a separate Tauri command in T-W.7).
- `brew uninstall` — explicitly NOT shipped. The wizard installs only; rollback on user cancel is a no-op (per T-W.3 review checklist row "Rollback if user cancels mid-flow"; brew's own dialog handles its own rollback).
