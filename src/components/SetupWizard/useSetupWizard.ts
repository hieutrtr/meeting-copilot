// T-W.6 — Setup Wizard FSM hook. Phase-W BlackHole Setup Wizard.
//
// Pure-reducer state machine per `docs/blackhole-wizard-design.md` §4. The
// reducer takes a `WizardState` + `WizardAction` and returns the next
// `WizardState` — no Tauri invokes, no I/O, no timers. Side effects (the
// four `invoke<>(setup_*)` round-trips) live in the parent component as
// `useEffect`s keyed off `state.step`. This shape mirrors Phase 2's
// `meetingStore` reducer-isolation test pattern: a closed action union, a
// pure transition table, 12 RTL/reducer cases asserting transitions in
// isolation.
//
// State machine (5 steps + 1 terminal):
//
//   welcome → detect → install → configure → verify → done
//
// Short-circuit branch: when `detect` returns a status that already implies
// `Configured` or `Verified`, jump straight to `verify` (skip install +
// configure). When `detect` returns `NotInstalled`, follow the normal path
// `install → configure → verify`. When `detect` returns
// `InstalledNotConfigured`, jump to `configure` (skip install).
//
// Quit-wizard escape hatch: a `quit` action transitions to `done` from any
// step (escape valve when the user has a custom audio routing setup the
// wizard doesn't recognize, e.g. Loopback.app, Aggregate Device for studio
// recording). The parent component flips `settingsStore.setupCompleted=true`
// when state.step === "done".
//
// The reducer is exhaustive — TypeScript's `never` tail in the default arm
// guarantees compile-time coverage of all `WizardAction` variants. Adding a
// variant requires adding a transition case OR letting the action no-op
// for steps where it doesn't apply (per Phase 2 store convention).

import { useReducer } from "react";

// ── Public types — shared with step components and tests ─────────────────────

/// Mirror of Rust `BlackHoleStatus` (`crates/audio-capture/src/blackhole.rs`),
/// flattened to a discriminated union over `kind`. Tauri command
/// `setup_detect_blackhole` returns this shape (T-W.7 wires the
/// serialization via `serde::Serialize` rename_all = "snake_case").
export type BlackHoleStatus =
  | { kind: "not_installed" }
  | { kind: "installed_not_configured"; blackhole_uid: string }
  | {
      kind: "configured";
      blackhole_uid: string;
      multi_output_uid: string;
      multi_output_id: number;
    }
  | { kind: "verified"; peak: number; callback_count: number };

/// Mirror of Rust `VerifyReport` (T-W.5 spec, INDEX row T-W.5). The wizard's
/// Verify step renders the peak meter and gates the "All set" success panel
/// off `signal_present`.
export interface VerifyReport {
  peak_amplitude: number;
  signal_present: boolean;
  duration_ms_actual: number;
  callback_count: number;
}

/// Install report from `setup_install_blackhole`. The brew path streams
/// stdout/stderr lines through `progress` (each line surfaces in the UI
/// pre-completion); the manual path returns `manual_url` and a brew_found=false
/// signal so the UI renders the .pkg link instead.
export interface InstallReport {
  brew_found: boolean;
  manual_url: string;
  exit_code?: number;
  stderr_tail?: string;
}

// ── Reducer state + action surface ───────────────────────────────────────────

export type WizardStep =
  | "welcome"
  | "detect"
  | "install"
  | "configure"
  | "verify"
  | "done";

/// The reducer holds: which step is rendered, which step's invoke is
/// in-flight (`pending`), the most-recent error (`error`, scoped to the
/// current step — cleared on advance), the streaming install log
/// (`installLog`, append-only — cleared when re-entering install via retry),
/// the device id from configure (consumed by verify), and the verify report
/// (rendered in the success panel).
export interface WizardState {
  step: WizardStep;
  pending: boolean;
  error: string | null;
  detectStatus: BlackHoleStatus | null;
  installLog: string[];
  installReport: InstallReport | null;
  multiOutputDeviceId: number | null;
  verifyReport: VerifyReport | null;
  retryCount: number;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  step: "welcome",
  pending: false,
  error: null,
  detectStatus: null,
  installLog: [],
  installReport: null,
  multiOutputDeviceId: null,
  verifyReport: null,
  retryCount: 0,
};

export type WizardAction =
  | { type: "continue" } // welcome → detect (auto-runs detect on mount)
  | { type: "detect_started" } // detect: pending=true, clear error
  | { type: "detect_result"; status: BlackHoleStatus }
  | { type: "detect_failed"; error: string }
  | { type: "install_started" }
  | { type: "install_progress"; line: string }
  | { type: "install_completed"; report: InstallReport }
  | { type: "install_failed"; error: string }
  | { type: "configure_started" }
  | { type: "configure_completed"; deviceId: number }
  | { type: "configure_failed"; error: string }
  | { type: "verify_started" }
  | { type: "verify_completed"; report: VerifyReport }
  | { type: "verify_failed"; error: string }
  | { type: "retry" } // retry from any error: re-enter step that just failed
  | { type: "back" } // back: previous step; no-op from welcome
  | { type: "quit" }; // escape hatch: any step → done

// ── Pure reducer ─────────────────────────────────────────────────────────────

export function setupWizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  // Quit is an unconditional escape — handled outside the per-step switches.
  if (action.type === "quit") {
    return {
      ...state,
      step: "done",
      pending: false,
      error: null,
    };
  }

  switch (action.type) {
    case "continue": {
      if (state.step !== "welcome") return state;
      return {
        ...state,
        step: "detect",
        pending: false,
        error: null,
      };
    }

    case "detect_started": {
      if (state.step !== "detect") return state;
      return { ...state, pending: true, error: null };
    }

    case "detect_result": {
      if (state.step !== "detect") return state;
      // Short-circuit branch per design §4: status determines next step.
      const next = nextStepForDetect(action.status);
      return {
        ...state,
        step: next,
        pending: false,
        error: null,
        detectStatus: action.status,
        // If detect already saw a Configured Multi-Output, lift the device id
        // so the verify step can reuse it without going through configure.
        multiOutputDeviceId:
          action.status.kind === "configured"
            ? action.status.multi_output_id
            : state.multiOutputDeviceId,
      };
    }

    case "detect_failed": {
      if (state.step !== "detect") return state;
      return { ...state, pending: false, error: action.error };
    }

    case "install_started": {
      if (state.step !== "install") return state;
      // Clearing installLog on re-entry to keep the streamed log scoped to
      // the current attempt — retry after failure should not show stale
      // brew output from the prior attempt.
      return {
        ...state,
        pending: true,
        error: null,
        installLog: [],
        installReport: null,
      };
    }

    case "install_progress": {
      if (state.step !== "install") return state;
      return {
        ...state,
        installLog: [...state.installLog, action.line],
      };
    }

    case "install_completed": {
      if (state.step !== "install") return state;
      // brew_found=false is the manual-fallback path: surface the URL but
      // STAY in the install step until the user clicks "I've installed,
      // retry" (which re-runs detect).
      if (!action.report.brew_found) {
        return {
          ...state,
          pending: false,
          error: null,
          installReport: action.report,
        };
      }
      return {
        ...state,
        step: "configure",
        pending: false,
        error: null,
        installReport: action.report,
      };
    }

    case "install_failed": {
      if (state.step !== "install") return state;
      return { ...state, pending: false, error: action.error };
    }

    case "configure_started": {
      if (state.step !== "configure") return state;
      return { ...state, pending: true, error: null };
    }

    case "configure_completed": {
      if (state.step !== "configure") return state;
      return {
        ...state,
        step: "verify",
        pending: false,
        error: null,
        multiOutputDeviceId: action.deviceId,
      };
    }

    case "configure_failed": {
      if (state.step !== "configure") return state;
      return { ...state, pending: false, error: action.error };
    }

    case "verify_started": {
      if (state.step !== "verify") return state;
      return { ...state, pending: true, error: null };
    }

    case "verify_completed": {
      if (state.step !== "verify") return state;
      // signal_present=false is "BlackHole present but silent" (Swift exit 8)
      // — stay in verify and surface a retry button. The reducer does NOT
      // auto-advance to done unless the signal is real.
      if (!action.report.signal_present) {
        return {
          ...state,
          pending: false,
          error: "No audio signal detected. Try playing audio and retrying.",
          verifyReport: action.report,
        };
      }
      return {
        ...state,
        step: "done",
        pending: false,
        error: null,
        verifyReport: action.report,
      };
    }

    case "verify_failed": {
      if (state.step !== "verify") return state;
      return { ...state, pending: false, error: action.error };
    }

    case "retry": {
      // Retry re-enters the current step with cleared error + bumped count.
      // For `verify` after a silent capture we keep the prior report so the
      // peak meter doesn't flash empty between retries.
      return {
        ...state,
        pending: false,
        error: null,
        retryCount: state.retryCount + 1,
      };
    }

    case "back": {
      const prev = previousStep(state.step);
      if (prev === state.step) return state;
      return {
        ...state,
        step: prev,
        pending: false,
        error: null,
      };
    }

    default: {
      // Exhaustiveness — `quit` is handled above; all other variants in
      // `WizardAction` matched above. Adding a new variant without a case
      // here is a compile error.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/// Map a detect result to the next wizard step. Exported so step
/// components + tests can reason about the short-circuit branch directly.
export function nextStepForDetect(status: BlackHoleStatus): WizardStep {
  switch (status.kind) {
    case "not_installed":
      return "install";
    case "installed_not_configured":
      return "configure";
    case "configured":
    case "verified":
      return "verify";
  }
}

function previousStep(step: WizardStep): WizardStep {
  switch (step) {
    case "welcome":
      return "welcome";
    case "detect":
      return "welcome";
    case "install":
      return "detect";
    case "configure":
      return "detect";
    case "verify":
      // Going back from verify is ambiguous — could be configure or detect
      // depending on the short-circuit. Land on detect, the canonical
      // ancestor; the next forward action will re-derive the path.
      return "detect";
    case "done":
      return "verify";
  }
}

// ── React hook ───────────────────────────────────────────────────────────────

export interface UseSetupWizardOptions {
  initialState?: WizardState;
}

export function useSetupWizard(opts: UseSetupWizardOptions = {}) {
  const [state, dispatch] = useReducer(
    setupWizardReducer,
    opts.initialState ?? INITIAL_WIZARD_STATE,
  );
  return { state, dispatch };
}
