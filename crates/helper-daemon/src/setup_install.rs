// T-W.3 — BlackHole auto-install helper. Phase-W BlackHole Setup Wizard.
//
// Surfaces the install half of `docs/blackhole-wizard-design.md` §2 "Install path tree":
//
//   1. probe Homebrew at /opt/homebrew/bin/brew (Apple Silicon, priority 1) and
//      /usr/local/bin/brew (Intel, priority 2);
//   2. fall back to `which brew` for user-PATH custom prefixes (linuxbrew /
//      `/Users/<x>/.brew`, etc);
//   3. if any of the three resolves: invoke `brew install --cask blackhole-2ch`
//      via `std::process::Command` with **argv array form** (NEVER a shell string —
//      Phase 4 R-2 deeplink-injection guardrail reused here as
//      `install_command_argv_array_form_no_shell` regression test);
//   4. if Homebrew is unavailable: return a typed `BrewNotFound` carrying the
//      manual `.pkg` download URL so the wizard renders an "Open in browser"
//      fallback link per design §2.
//
// Test seam: `FilesystemCheck` (does this path exist?) + `ProcessRunner` (run a
// program with argv). Production impls use `std::path::Path::exists` +
// `std::process::Command`; tests inject mocks so no real subprocess fires under
// `cargo test`.
//
// Streaming stdout/stderr to the wizard UI is a T-W.7 concern (the Tauri command
// wrapper runs this on `tokio::task::spawn_blocking` and pumps lines to React via
// the existing event bridge). T-W.3 ships a synchronous capture API so unit tests
// drive deterministic outcomes — captured stdout is returned in `InstallReport`.

use std::path::Path;
use std::process::Command;

use thiserror::Error;

/// Apple Silicon Homebrew prefix. Probe priority 1 per design §2 (R-W.2 mitigation).
pub const BREW_PATH_APPLE_SILICON: &str = "/opt/homebrew/bin/brew";

/// Intel Homebrew prefix. Probe priority 2 per design §2 (R-W.2 mitigation).
pub const BREW_PATH_INTEL: &str = "/usr/local/bin/brew";

/// Manual `.pkg` download URL — Existential Audio's official BlackHole landing page.
/// Returned with `BrewNotFound` so the wizard can render a `target="_blank" rel="noopener"`
/// fallback link per design §2 right column.
pub const MANUAL_INSTALL_URL: &str = "https://existential.audio/blackhole/";

/// Argv passed to `brew` when installing BlackHole. Hoisted as a `pub const` so the
/// `install_command_argv_array_form_no_shell` regression test asserts against the
/// same value the production path uses (single source of truth).
pub const BREW_INSTALL_ARGS: &[&str] = &["install", "--cask", "blackhole-2ch"];

/// Captured output from a child process. Cross-platform, std-only.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessOutput {
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Successful install. Returned from `install_via_brew` on `brew` exit 0.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallReport {
    pub brew_path: String,
    pub stdout: String,
}

#[derive(Debug, Error, PartialEq)]
pub enum InstallError {
    /// No Homebrew binary detected at any of the probed prefixes nor via `which brew`.
    /// Wizard surfaces `manual_url` as a fallback link + an "I've installed, retry" button.
    #[error("homebrew not found — fallback URL: {manual_url}")]
    BrewNotFound { manual_url: &'static str },

    /// Brew was found but `brew install --cask blackhole-2ch` exited non-zero.
    /// `stderr` is surfaced verbatim so the wizard can render the failure message
    /// to the user (R-W.5 sudo-cancel-race mitigation per design §6).
    #[error("brew exited {exit_code:?}: {stderr}")]
    BrewFailed {
        exit_code: Option<i32>,
        stderr: String,
    },

    /// `Command::output` failed to spawn the child (e.g. EACCES on the brew binary,
    /// or the binary disappeared between probe and exec). Distinct surface from
    /// `BrewFailed` because the cause is the runner itself, not the command output.
    #[error("failed to run brew: {message}")]
    SpawnFailed { message: String },
}

/// Test seam #1 — does this filesystem path exist? Production: `Path::new(p).exists()`.
pub trait FilesystemCheck {
    fn exists(&self, path: &str) -> bool;
}

/// Test seam #2 — run a program with argv and capture stdout/stderr/status.
/// Production: `std::process::Command::new(prog).args(args).output()`.
pub trait ProcessRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, std::io::Error>;
}

/// Production filesystem check.
#[derive(Debug, Default)]
pub struct RealFilesystem;
impl FilesystemCheck for RealFilesystem {
    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }
}

/// Production process runner.
#[derive(Debug, Default)]
pub struct RealProcessRunner;
impl ProcessRunner for RealProcessRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, std::io::Error> {
        let output = Command::new(program).args(args).output()?;
        Ok(ProcessOutput {
            status_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Locate the `brew` binary by probing the two well-known prefixes, then falling
/// back to `which brew`. Returns `None` if no Homebrew is installed.
///
/// Probe order — first match wins:
/// 1. `/opt/homebrew/bin/brew` (Apple Silicon — most common for new Macs)
/// 2. `/usr/local/bin/brew`   (Intel — older Macs, also Rosetta installs)
/// 3. `which brew`            (custom prefix in user PATH)
pub fn detect_brew_path<F: FilesystemCheck, P: ProcessRunner>(
    fs: &F,
    runner: &P,
) -> Option<String> {
    if fs.exists(BREW_PATH_APPLE_SILICON) {
        return Some(BREW_PATH_APPLE_SILICON.to_string());
    }
    if fs.exists(BREW_PATH_INTEL) {
        return Some(BREW_PATH_INTEL.to_string());
    }
    // Fallback: `which brew`. Honours user-customised PATH (linuxbrew, custom prefix).
    match runner.run("which", &["brew"]) {
        Ok(out) if out.status_code == Some(0) => {
            let trimmed = out.stdout.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

/// Invoke `brew install --cask blackhole-2ch` via the supplied runner.
///
/// Argv is the slice form `["install", "--cask", "blackhole-2ch"]` — never a shell
/// string. The Phase 4 R-2 review (deeplink-injection guard) is reused here as a
/// regression checkbox in `T-W.3-review.md` §2; the unit test
/// `install_command_argv_array_form_no_shell` asserts that the runner saw the slice
/// intact.
///
/// On `brew` exit 0 → `Ok(InstallReport { brew_path, stdout })`.
/// On Homebrew missing → `Err(BrewNotFound { manual_url: MANUAL_INSTALL_URL })`.
/// On `brew` exit non-zero → `Err(BrewFailed { exit_code, stderr })` with stderr verbatim.
/// On spawn failure (EACCES etc) → `Err(SpawnFailed { message })`.
pub fn install_via_brew<F: FilesystemCheck, P: ProcessRunner>(
    fs: &F,
    runner: &P,
) -> Result<InstallReport, InstallError> {
    let brew = detect_brew_path(fs, runner).ok_or(InstallError::BrewNotFound {
        manual_url: MANUAL_INSTALL_URL,
    })?;
    let output = runner
        .run(&brew, BREW_INSTALL_ARGS)
        .map_err(|e| InstallError::SpawnFailed {
            message: e.to_string(),
        })?;
    match output.status_code {
        Some(0) => Ok(InstallReport {
            brew_path: brew,
            stdout: output.stdout,
        }),
        _ => Err(InstallError::BrewFailed {
            exit_code: output.status_code,
            stderr: output.stderr,
        }),
    }
}

/// Manual `.pkg` install URL — convenience accessor for the Tauri command in T-W.7
/// + the wizard Install step in T-W.6 so neither has to import the `pub const`.
pub fn build_manual_install_url() -> &'static str {
    MANUAL_INSTALL_URL
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;

    /// Filesystem mock — any path queued via `with_paths` returns `true` from
    /// `exists`; everything else returns `false`. Zero real disk touches under test.
    struct MockFilesystem {
        present: HashSet<String>,
    }

    impl MockFilesystem {
        fn with_paths(paths: &[&str]) -> Self {
            Self {
                present: paths.iter().map(|s| s.to_string()).collect(),
            }
        }
        fn empty() -> Self {
            Self {
                present: HashSet::new(),
            }
        }
    }

    impl FilesystemCheck for MockFilesystem {
        fn exists(&self, path: &str) -> bool {
            self.present.contains(path)
        }
    }

    /// Process mock — records every (program, args) call for assertion; pops queued
    /// responses in FIFO order. Empty queue defaults to `Ok` exit 0 with empty
    /// stdout/stderr.
    struct MockProcessRunner {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        responses: RefCell<Vec<Result<ProcessOutput, std::io::ErrorKind>>>,
    }

    impl MockProcessRunner {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                responses: RefCell::new(Vec::new()),
            }
        }
        fn queue_ok(&self, status: i32, stdout: &str, stderr: &str) -> &Self {
            self.responses.borrow_mut().push(Ok(ProcessOutput {
                status_code: Some(status),
                stdout: stdout.to_string(),
                stderr: stderr.to_string(),
            }));
            self
        }
        fn queue_spawn_err(&self, kind: std::io::ErrorKind) -> &Self {
            self.responses.borrow_mut().push(Err(kind));
            self
        }
        fn last_call(&self) -> Option<(String, Vec<String>)> {
            self.calls.borrow().last().cloned()
        }
        fn call_count(&self) -> usize {
            self.calls.borrow().len()
        }
    }

    impl ProcessRunner for MockProcessRunner {
        fn run(&self, program: &str, args: &[&str]) -> Result<ProcessOutput, std::io::Error> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
            ));
            let mut responses = self.responses.borrow_mut();
            if responses.is_empty() {
                return Ok(ProcessOutput {
                    status_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                });
            }
            match responses.remove(0) {
                Ok(out) => Ok(out),
                Err(kind) => Err(std::io::Error::from(kind)),
            }
        }
    }

    // ── Test 1 ───────────────────────────────────────────────────────────────────────
    #[test]
    fn brew_detected_apple_silicon_prefix() {
        // Both prefixes "exist" — Apple Silicon must win (priority 1) and `which`
        // must NOT be invoked (no fallback fire on fast path).
        let fs = MockFilesystem::with_paths(&[BREW_PATH_APPLE_SILICON, BREW_PATH_INTEL]);
        let runner = MockProcessRunner::new();
        let path = detect_brew_path(&fs, &runner).expect("brew should be detected");
        assert_eq!(path, BREW_PATH_APPLE_SILICON);
        assert_eq!(
            runner.call_count(),
            0,
            "fast-path detection must not fire `which`"
        );
    }

    // ── Test 2 ───────────────────────────────────────────────────────────────────────
    #[test]
    fn brew_detected_intel_prefix() {
        // Only the Intel prefix exists — fall through from Apple Silicon, settle here.
        let fs = MockFilesystem::with_paths(&[BREW_PATH_INTEL]);
        let runner = MockProcessRunner::new();
        let path = detect_brew_path(&fs, &runner).expect("brew should be detected");
        assert_eq!(path, BREW_PATH_INTEL);
        assert_eq!(runner.call_count(), 0);
    }

    // ── Test 3 ───────────────────────────────────────────────────────────────────────
    #[test]
    fn brew_detected_via_which_when_neither_prefix_exists() {
        // Neither well-known prefix exists; `which brew` returns a custom path.
        // Tests the third arm of the probe ladder (R-W.2 user-PATH custom prefix).
        let fs = MockFilesystem::empty();
        let runner = MockProcessRunner::new();
        runner.queue_ok(0, "/Users/alice/.brew/bin/brew\n", "");
        let path = detect_brew_path(&fs, &runner).expect("which fallback should detect");
        assert_eq!(path, "/Users/alice/.brew/bin/brew");
        let (prog, args) = runner.last_call().expect("which should have been called");
        assert_eq!(prog, "which");
        assert_eq!(args, vec!["brew".to_string()]);
    }

    // ── Test 4 ───────────────────────────────────────────────────────────────────────
    #[test]
    fn brew_not_found_returns_manual_url() {
        // No prefixes + `which` returns non-zero ⇒ install_via_brew yields BrewNotFound
        // carrying the manual URL constant.
        let fs = MockFilesystem::empty();
        let runner = MockProcessRunner::new();
        runner.queue_ok(1, "", "brew not found\n");
        let err = install_via_brew(&fs, &runner).expect_err("expected BrewNotFound");
        match err {
            InstallError::BrewNotFound { manual_url } => {
                assert_eq!(manual_url, MANUAL_INSTALL_URL);
                assert_eq!(manual_url, "https://existential.audio/blackhole/");
            }
            other => panic!("expected BrewNotFound, got {other:?}"),
        }
        // build_manual_install_url() returns the same constant — single source of truth.
        assert_eq!(build_manual_install_url(), MANUAL_INSTALL_URL);
    }

    // ── Test 5 — BLOCKING (Phase 4 R-2 reused) ───────────────────────────────────────
    #[test]
    fn install_command_argv_array_form_no_shell() {
        // BLOCKING regression guard: brew args MUST be passed as an argv array, not a
        // shell string. If anyone ever rewrites this to use
        // `Command::new("sh").arg("-c").arg("brew install --cask blackhole-2ch")` the
        // assertions below catch it (program name + arg whitespace + slice equality).
        let fs = MockFilesystem::with_paths(&[BREW_PATH_APPLE_SILICON]);
        let runner = MockProcessRunner::new();
        runner.queue_ok(0, "==> Installed blackhole-2ch\n", "");
        let report = install_via_brew(&fs, &runner).expect("install should succeed");
        let (prog, args) = runner.last_call().expect("brew should have been invoked");
        // (1) Program is the literal brew binary path — NOT `sh` / `bash` / `zsh`.
        assert_eq!(prog, BREW_PATH_APPLE_SILICON);
        assert!(
            !prog.ends_with("sh"),
            "program `{prog}` ends with `sh` — likely a shell-wrapping regression"
        );
        // (2) Args is the exact 3-element argv — NOT a single concatenated shell string.
        assert_eq!(
            args,
            vec![
                "install".to_string(),
                "--cask".to_string(),
                "blackhole-2ch".to_string(),
            ]
        );
        // (3) Defence-in-depth: no individual arg contains whitespace (would suggest
        // a smushed shell-string regression like ["install --cask blackhole-2ch"]).
        for a in &args {
            assert!(
                !a.contains(' '),
                "arg `{a}` contains a space — shell-string regression"
            );
        }
        // (4) The public BREW_INSTALL_ARGS constant matches what the call site passed.
        assert_eq!(BREW_INSTALL_ARGS, &["install", "--cask", "blackhole-2ch"]);
        assert_eq!(report.brew_path, BREW_PATH_APPLE_SILICON);
        assert!(report.stdout.contains("Installed"));
    }

    // ── Test 6 ───────────────────────────────────────────────────────────────────────
    #[test]
    fn install_aborted_when_brew_exit_nonzero_surfaces_stderr() {
        // R-W.5 sudo-cancel-race: user clicks Cancel in the osascript admin dialog
        // → brew exits non-zero → InstallError::BrewFailed must carry stderr verbatim
        // so the wizard can render the failure to the user (and offer manual URL).
        let fs = MockFilesystem::with_paths(&[BREW_PATH_INTEL]);
        let runner = MockProcessRunner::new();
        runner.queue_ok(
            1,
            "",
            "Error: Failure while executing; `/usr/bin/sudo -E -- ...` exited with 1.\n",
        );
        let err = install_via_brew(&fs, &runner).expect_err("expected BrewFailed");
        match err {
            InstallError::BrewFailed { exit_code, stderr } => {
                assert_eq!(exit_code, Some(1));
                assert!(stderr.contains("Failure while executing"));
                assert!(stderr.contains("sudo"));
            }
            other => panic!("expected BrewFailed, got {other:?}"),
        }
    }

    // ── Test 7 (boundary sentinel) ───────────────────────────────────────────────────
    #[test]
    fn spawn_failure_surfaces_typed_error() {
        // The brew prefix probe was positive (filesystem says exists) but the runner
        // failed to spawn (e.g. EACCES on the binary). Distinct error variant from
        // BrewFailed so the wizard renders a different message — there is no stderr
        // because brew never started.
        let fs = MockFilesystem::with_paths(&[BREW_PATH_APPLE_SILICON]);
        let runner = MockProcessRunner::new();
        runner.queue_spawn_err(std::io::ErrorKind::PermissionDenied);
        let err = install_via_brew(&fs, &runner).expect_err("expected SpawnFailed");
        match err {
            InstallError::SpawnFailed { message } => {
                let lc = message.to_lowercase();
                assert!(
                    lc.contains("permission") || lc.contains("denied"),
                    "expected permission-denied phrasing, got `{message}`"
                );
            }
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }
}
