// T-W.6 — Reducer-isolation tests for the Setup Wizard FSM.
//
// AC traceability (see docs/tasks/blackhole-wizard/T-W.6-wizard.md):
//   SW-R1  → AC-R initial state shape
//   SW-R2  → AC-T welcome → detect on `continue`
//   SW-R3  → AC-T detect_result NotInstalled → install
//   SW-R4  → AC-T detect_result InstalledNotConfigured → configure
//   SW-R5  → AC-T detect_result Configured → verify (short-circuit)
//   SW-R6  → AC-T install_completed brew_found=true → configure
//   SW-R7  → AC-T install_completed brew_found=false → STAY install + manual URL
//   SW-R8  → AC-T configure_completed → verify (carries deviceId)
//   SW-R9  → AC-T verify_completed signal_present=true → done
//   SW-R10 → AC-T verify_completed signal_present=false → STAY verify + error
//   SW-R11 → AC-T quit from any step → done (escape hatch)
//   SW-R12 → AC-T retry bumps retryCount + clears error
//   SW-R13 → AC-T action ignored when step doesn't match (no-op)
//   SW-R14 → AC-T install_started clears prior log + report (re-attempt scope)

import { describe, expect, it } from "vitest";

import {
  INITIAL_WIZARD_STATE,
  nextStepForDetect,
  setupWizardReducer,
  type BlackHoleStatus,
  type WizardState,
} from "./useSetupWizard";

const NOT_INSTALLED: BlackHoleStatus = { kind: "not_installed" };
const INSTALLED_NOT_CONFIGURED: BlackHoleStatus = {
  kind: "installed_not_configured",
  blackhole_uid: "BlackHole2ch_UID",
};
const CONFIGURED: BlackHoleStatus = {
  kind: "configured",
  blackhole_uid: "BlackHole2ch_UID",
  multi_output_uid: "MeetingCopilotMultiOut",
  multi_output_id: 137,
};

describe("setupWizardReducer — state transitions", () => {
  it("SW-R1: initial state is welcome / not pending / no error", () => {
    expect(INITIAL_WIZARD_STATE.step).toBe("welcome");
    expect(INITIAL_WIZARD_STATE.pending).toBe(false);
    expect(INITIAL_WIZARD_STATE.error).toBeNull();
    expect(INITIAL_WIZARD_STATE.detectStatus).toBeNull();
    expect(INITIAL_WIZARD_STATE.installLog).toEqual([]);
    expect(INITIAL_WIZARD_STATE.installReport).toBeNull();
    expect(INITIAL_WIZARD_STATE.multiOutputDeviceId).toBeNull();
    expect(INITIAL_WIZARD_STATE.verifyReport).toBeNull();
    expect(INITIAL_WIZARD_STATE.retryCount).toBe(0);
  });

  it("SW-R2: continue from welcome advances to detect", () => {
    const next = setupWizardReducer(INITIAL_WIZARD_STATE, { type: "continue" });
    expect(next.step).toBe("detect");
    expect(next.pending).toBe(false);
  });

  it("SW-R3: detect_result NotInstalled → install", () => {
    const detect = setupWizardReducer(INITIAL_WIZARD_STATE, {
      type: "continue",
    });
    const next = setupWizardReducer(detect, {
      type: "detect_result",
      status: NOT_INSTALLED,
    });
    expect(next.step).toBe("install");
    expect(next.detectStatus).toEqual(NOT_INSTALLED);
  });

  it("SW-R4: detect_result InstalledNotConfigured → configure (skips install)", () => {
    const detect = setupWizardReducer(INITIAL_WIZARD_STATE, {
      type: "continue",
    });
    const next = setupWizardReducer(detect, {
      type: "detect_result",
      status: INSTALLED_NOT_CONFIGURED,
    });
    expect(next.step).toBe("configure");
  });

  it("SW-R5: detect_result Configured → verify (short-circuit; lifts deviceId)", () => {
    const detect = setupWizardReducer(INITIAL_WIZARD_STATE, {
      type: "continue",
    });
    const next = setupWizardReducer(detect, {
      type: "detect_result",
      status: CONFIGURED,
    });
    expect(next.step).toBe("verify");
    expect(next.multiOutputDeviceId).toBe(137);
  });

  it("SW-R6: install_completed brew_found=true → configure", () => {
    const at = installStep();
    const next = setupWizardReducer(at, {
      type: "install_completed",
      report: { brew_found: true, manual_url: "" },
    });
    expect(next.step).toBe("configure");
    expect(next.installReport?.brew_found).toBe(true);
  });

  it("SW-R7: install_completed brew_found=false → stay install + surface manual URL", () => {
    const at = installStep();
    const next = setupWizardReducer(at, {
      type: "install_completed",
      report: { brew_found: false, manual_url: "https://existential.audio/blackhole/" },
    });
    expect(next.step).toBe("install");
    expect(next.pending).toBe(false);
    expect(next.installReport?.brew_found).toBe(false);
    expect(next.installReport?.manual_url).toBe(
      "https://existential.audio/blackhole/",
    );
  });

  it("SW-R8: configure_completed → verify (carries deviceId)", () => {
    const at = configureStep();
    const next = setupWizardReducer(at, {
      type: "configure_completed",
      deviceId: 42,
    });
    expect(next.step).toBe("verify");
    expect(next.multiOutputDeviceId).toBe(42);
  });

  it("SW-R9: verify_completed signal_present=true → done", () => {
    const at = verifyStep();
    const next = setupWizardReducer(at, {
      type: "verify_completed",
      report: {
        peak_amplitude: 0.42,
        signal_present: true,
        duration_ms_actual: 5000,
        callback_count: 250,
      },
    });
    expect(next.step).toBe("done");
    expect(next.verifyReport?.signal_present).toBe(true);
    expect(next.error).toBeNull();
  });

  it("SW-R10: verify_completed signal_present=false → stay verify + error", () => {
    const at = verifyStep();
    const next = setupWizardReducer(at, {
      type: "verify_completed",
      report: {
        peak_amplitude: 0.00009,
        signal_present: false,
        duration_ms_actual: 5000,
        callback_count: 250,
      },
    });
    expect(next.step).toBe("verify");
    expect(next.error).toBeTruthy();
    expect(next.verifyReport?.signal_present).toBe(false);
  });

  it("SW-R11: quit from welcome / detect / install / configure / verify all → done (escape hatch)", () => {
    const steps: WizardState[] = [
      INITIAL_WIZARD_STATE,
      detectStep(),
      installStep(),
      configureStep(),
      verifyStep(),
    ];
    for (const s of steps) {
      const next = setupWizardReducer(s, { type: "quit" });
      expect(next.step).toBe("done");
      expect(next.pending).toBe(false);
      expect(next.error).toBeNull();
    }
  });

  it("SW-R12: retry clears error + bumps retryCount", () => {
    const errored: WizardState = {
      ...detectStep(),
      error: "boom",
      retryCount: 0,
    };
    const next = setupWizardReducer(errored, { type: "retry" });
    expect(next.error).toBeNull();
    expect(next.retryCount).toBe(1);
    expect(next.step).toBe("detect"); // retry stays on the current step
  });

  it("SW-R13: actions are ignored when step doesn't match (defensive no-op)", () => {
    // Trying to apply install_completed while in welcome must NOT
    // teleport to configure — the reducer guards against off-step
    // dispatches that could come from late-arriving promises.
    const next = setupWizardReducer(INITIAL_WIZARD_STATE, {
      type: "install_completed",
      report: { brew_found: true, manual_url: "" },
    });
    expect(next).toBe(INITIAL_WIZARD_STATE); // identity — no state change
  });

  it("SW-R14: install_started clears prior log + report (per-attempt scope)", () => {
    const fromRetry: WizardState = {
      ...installStep(),
      installLog: ["stale brew line 1", "stale brew line 2"],
      installReport: { brew_found: false, manual_url: "stale" },
      error: "earlier failure",
    };
    const next = setupWizardReducer(fromRetry, { type: "install_started" });
    expect(next.installLog).toEqual([]);
    expect(next.installReport).toBeNull();
    expect(next.error).toBeNull();
    expect(next.pending).toBe(true);
  });
});

describe("nextStepForDetect (pure)", () => {
  it("maps every BlackHoleStatus variant to a single step", () => {
    expect(nextStepForDetect(NOT_INSTALLED)).toBe("install");
    expect(nextStepForDetect(INSTALLED_NOT_CONFIGURED)).toBe("configure");
    expect(nextStepForDetect(CONFIGURED)).toBe("verify");
    expect(
      nextStepForDetect({ kind: "verified", peak: 0.3, callback_count: 100 }),
    ).toBe("verify");
  });
});

// ── Helpers — produce reducer states at canonical step entry points ──────────

function detectStep(): WizardState {
  return setupWizardReducer(INITIAL_WIZARD_STATE, { type: "continue" });
}

function installStep(): WizardState {
  const detect = detectStep();
  return setupWizardReducer(detect, {
    type: "detect_result",
    status: NOT_INSTALLED,
  });
}

function configureStep(): WizardState {
  const detect = detectStep();
  return setupWizardReducer(detect, {
    type: "detect_result",
    status: INSTALLED_NOT_CONFIGURED,
  });
}

function verifyStep(): WizardState {
  const cfg = configureStep();
  return setupWizardReducer(cfg, {
    type: "configure_completed",
    deviceId: 99,
  });
}
