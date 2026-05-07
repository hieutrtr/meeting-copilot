// T-W.9 — Fresh-Mac E2E fixtures for the BlackHole Setup Wizard.
//
// Each fixture is a *deterministic* response sequence for the four
// `SetupWizardInvokers` slots (detect / install / configure / verify). The
// e2e harness in `blackhole-wizard.e2e.test.ts` builds invokers backed by
// these fixtures so every run pulls the same responses in the same order
// — the 3/3 deterministic-runs gate from INDEX T-W.9 AC.
//
// These are *typed mirrors* of the Tauri command response shapes from
// `src/components/SetupWizard/useSetupWizard.ts`. T-W.7 will wire the live
// Tauri commands; the schema declared here is the contract that wiring
// must produce.

import type {
  BlackHoleStatus,
  InstallReport,
  VerifyReport,
} from "../../../src/components/SetupWizard/useSetupWizard";

// ── Detect responses ─────────────────────────────────────────────────────────

/** Fresh Mac: BlackHole HAL plug-in absent, no device, no Multi-Output. */
export const DETECT_FRESH_MAC: BlackHoleStatus = { kind: "not_installed" };

/** Post-install: device visible but Multi-Output not yet created. */
export const DETECT_INSTALLED_NOT_CONFIGURED: BlackHoleStatus = {
  kind: "installed_not_configured",
  blackhole_uid: "BlackHole2ch_UID",
};

/** Returning user: everything already wired. Wizard should short-circuit. */
export const DETECT_ALREADY_CONFIGURED: BlackHoleStatus = {
  kind: "configured",
  blackhole_uid: "BlackHole2ch_UID",
  multi_output_uid: "MeetingCopilotMultiOut",
  multi_output_id: 137,
};

// ── Install responses ────────────────────────────────────────────────────────

/** Apple-Silicon brew install — exit 0; 4 streamed stdout lines. */
export const INSTALL_BREW_SUCCESS: InstallReport = {
  brew_found: true,
  manual_url: "",
  exit_code: 0,
};

/** Streamed stdout lines for the happy-path brew install (deterministic). */
export const INSTALL_BREW_STDOUT_LINES: ReadonlyArray<string> = [
  "==> Downloading https://github.com/ExistentialAudio/BlackHole/releases/download/v0.6.0/BlackHole2ch.v0.6.0.pkg",
  "==> Verifying SHA-256 checksum for Cask 'blackhole-2ch'.",
  "==> Installing Cask blackhole-2ch",
  "🍺  blackhole-2ch was successfully installed!",
];

/** Brew not on PATH — wizard surfaces the .pkg manual fallback. */
export const INSTALL_BREW_NOT_FOUND: InstallReport = {
  brew_found: false,
  manual_url: "https://existential.audio/blackhole/",
};

// ── Configure response ───────────────────────────────────────────────────────

/** Multi-Output created with a deterministic AudioDeviceID. */
export const CONFIGURE_RESULT: { deviceId: number } = { deviceId: 137 };

// ── Verify responses ─────────────────────────────────────────────────────────

/** Healthy capture: peak well above the 1e-3 threshold; signal_present=true. */
export const VERIFY_SIGNAL_OK: VerifyReport = {
  peak_amplitude: 0.42,
  signal_present: true,
  duration_ms_actual: 5000,
  callback_count: 250,
};

/** BlackHole present but silent (Swift exit 8 mirror). signal_present=false. */
export const VERIFY_SILENT: VerifyReport = {
  peak_amplitude: 0.00009,
  signal_present: false,
  duration_ms_actual: 5000,
  callback_count: 250,
};

// ── Composite scenarios ──────────────────────────────────────────────────────
//
// Each scenario describes the *full sequence* of invoker responses the
// wizard pulls during a single deterministic run. The harness consumes
// these in FIFO order; an empty queue throws (catches drift between
// scenario expectations and actual invoker calls).

export interface WizardScenario {
  /** Human-readable name; appears in test failure messages. */
  name: string;
  /** Detect responses, one per detect call (mount + retry re-fires). */
  detect: ReadonlyArray<BlackHoleStatus | Error>;
  /** Install responses, one per install click. */
  install: ReadonlyArray<{
    report: InstallReport;
    stdout: ReadonlyArray<string>;
  }>;
  /** Configure responses, one per configure click. */
  configure: ReadonlyArray<{ deviceId: number } | Error>;
  /** Verify responses, one per verify click (incl. retries). */
  verify: ReadonlyArray<VerifyReport | Error>;
}

/**
 * Happy path: fresh Mac → install via brew → configure → verify → done.
 * 4 invoker calls in this exact order.
 */
export const SCENARIO_FRESH_MAC_HAPPY: WizardScenario = {
  name: "fresh-mac-happy-path",
  detect: [DETECT_FRESH_MAC],
  install: [
    {
      report: INSTALL_BREW_SUCCESS,
      stdout: INSTALL_BREW_STDOUT_LINES,
    },
  ],
  configure: [CONFIGURE_RESULT],
  verify: [VERIFY_SIGNAL_OK],
};

/**
 * Error path A: brew not found → manual URL link rendered; FSM stays on
 * install. The user clicks "I've installed" (re-runs detect), which now
 * returns InstalledNotConfigured (the .pkg installer ran out-of-band).
 * Configure + verify then proceed normally to done.
 */
export const SCENARIO_BREW_NOT_FOUND: WizardScenario = {
  name: "brew-not-found-manual-fallback",
  detect: [DETECT_FRESH_MAC, DETECT_INSTALLED_NOT_CONFIGURED],
  install: [
    {
      report: INSTALL_BREW_NOT_FOUND,
      stdout: [],
    },
  ],
  configure: [CONFIGURE_RESULT],
  verify: [VERIFY_SIGNAL_OK],
};

/**
 * Error path B: BlackHole already configured (returning user), but the
 * verify smoke test returns silent 3 times in a row (e.g., user forgot to
 * play audio). Each silent result keeps the wizard on `verify` with the
 * error pane visible — the operator-supervised retry-bound is asserted by
 * the test (3 attempts then stop).
 */
export const SCENARIO_VERIFY_SILENT_RETRY: WizardScenario = {
  name: "verify-silent-retry-bounded-3",
  detect: [DETECT_ALREADY_CONFIGURED],
  install: [],
  configure: [],
  verify: [VERIFY_SILENT, VERIFY_SILENT, VERIFY_SILENT],
};
