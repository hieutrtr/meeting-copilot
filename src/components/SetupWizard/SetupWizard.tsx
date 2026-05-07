// T-W.6 — SetupWizard container. Wires the pure reducer
// (`useSetupWizard`) to side effects via prop-injected invokers so the
// component is testable without a Tauri runtime. T-W.7 swaps the default
// invokers for real `@tauri-apps/api/core::invoke` calls.
//
// State flows: container subscribes to reducer state, hands the relevant
// slice + a typed `dispatch` shim to each step. Effects are keyed off
// `state.step` + `state.pending` so re-entries (retry, back) re-fire.

import { useCallback, useEffect, useRef } from "react";

import { Configure } from "./Configure";
import { Detect } from "./Detect";
import { Install } from "./Install";
import { Verify } from "./Verify";
import { Welcome } from "./Welcome";
import {
  useSetupWizard,
  type BlackHoleStatus,
  type InstallReport,
  type VerifyReport,
  type WizardState,
} from "./useSetupWizard";

// ── Prop-injected invokers — Tauri command surface boundary ──────────────────

export interface SetupWizardInvokers {
  detect(): Promise<BlackHoleStatus>;
  install(onLine: (line: string) => void): Promise<InstallReport>;
  configure(): Promise<{ deviceId: number }>;
  verify(deviceId: number | null): Promise<VerifyReport>;
}

export interface SetupWizardProps {
  invokers: SetupWizardInvokers;
  onDone: () => void;
  initialState?: WizardState;
}

export function SetupWizard({
  invokers,
  onDone,
  initialState,
}: SetupWizardProps) {
  const { state, dispatch } = useSetupWizard({ initialState });

  // Notify parent when the FSM lands on done. Calling onDone in render
  // would loop; useEffect debounces to mount + step transition.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (state.step === "done") {
      onDoneRef.current();
    }
  }, [state.step]);

  // Detect: auto-runs on entry. Re-fires on retry (retryCount bump).
  const detectInFlight = useRef(false);
  useEffect(() => {
    if (state.step !== "detect") return;
    if (state.pending) return;
    if (detectInFlight.current) return;
    detectInFlight.current = true;
    dispatch({ type: "detect_started" });
    invokers
      .detect()
      .then((status) => {
        dispatch({ type: "detect_result", status });
      })
      .catch((err: unknown) => {
        dispatch({
          type: "detect_failed",
          error: errorMessage(err),
        });
      })
      .finally(() => {
        detectInFlight.current = false;
      });
    // We deliberately key on step + retryCount so a retry re-runs detect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.retryCount]);

  // Install: explicit user click (NOT auto). Streams brew lines via the
  // onLine callback the invoker accepts.
  const installInFlight = useRef(false);
  const onInstall = useCallback(() => {
    if (installInFlight.current) return;
    installInFlight.current = true;
    dispatch({ type: "install_started" });
    invokers
      .install((line) => dispatch({ type: "install_progress", line }))
      .then((report) => {
        dispatch({ type: "install_completed", report });
      })
      .catch((err: unknown) => {
        dispatch({ type: "install_failed", error: errorMessage(err) });
      })
      .finally(() => {
        installInFlight.current = false;
      });
  }, [invokers, dispatch]);

  // After a manual-fallback install, the user clicks "I've installed" which
  // re-runs detect from scratch.
  const onRetryDetect = useCallback(() => {
    dispatch({ type: "back" });
  }, [dispatch]);

  // Configure: explicit user click.
  const configureInFlight = useRef(false);
  const onConfigure = useCallback(() => {
    if (configureInFlight.current) return;
    configureInFlight.current = true;
    dispatch({ type: "configure_started" });
    invokers
      .configure()
      .then(({ deviceId }) => {
        dispatch({ type: "configure_completed", deviceId });
      })
      .catch((err: unknown) => {
        dispatch({ type: "configure_failed", error: errorMessage(err) });
      })
      .finally(() => {
        configureInFlight.current = false;
      });
  }, [invokers, dispatch]);

  // Verify: explicit user click.
  const verifyInFlight = useRef(false);
  const onVerify = useCallback(() => {
    if (verifyInFlight.current) return;
    verifyInFlight.current = true;
    dispatch({ type: "verify_started" });
    invokers
      .verify(state.multiOutputDeviceId)
      .then((report) => {
        dispatch({ type: "verify_completed", report });
      })
      .catch((err: unknown) => {
        dispatch({ type: "verify_failed", error: errorMessage(err) });
      })
      .finally(() => {
        verifyInFlight.current = false;
      });
  }, [invokers, dispatch, state.multiOutputDeviceId]);

  const onQuit = useCallback(() => {
    dispatch({ type: "quit" });
  }, [dispatch]);

  const onRetry = useCallback(() => {
    dispatch({ type: "retry" });
  }, [dispatch]);

  // Done state renders nothing — the parent unmounts after onDone fires.
  if (state.step === "done") {
    return (
      <div
        className="setup-wizard"
        data-testid="setup-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-wizard-done-title"
      >
        <section
          className="setup-wizard__step"
          data-testid="setup-wizard-step-done"
        >
          <h2 className="setup-wizard__title" id="setup-wizard-done-title">
            All set!
          </h2>
          <p className="setup-wizard__body">
            Audio capture is configured. You can change these settings any
            time from the Settings panel.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div
      className="setup-wizard"
      data-testid="setup-wizard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-wizard-step-title"
    >
      {state.step === "welcome" ? (
        <Welcome
          onContinue={() => dispatch({ type: "continue" })}
          onQuit={onQuit}
        />
      ) : null}
      {state.step === "detect" ? (
        <Detect
          pending={state.pending}
          error={state.error}
          status={state.detectStatus}
          onRetry={onRetry}
          onQuit={onQuit}
        />
      ) : null}
      {state.step === "install" ? (
        <Install
          pending={state.pending}
          error={state.error}
          log={state.installLog}
          report={state.installReport}
          onInstall={onInstall}
          onRetryDetect={onRetryDetect}
          onQuit={onQuit}
        />
      ) : null}
      {state.step === "configure" ? (
        <Configure
          pending={state.pending}
          error={state.error}
          onConfigure={onConfigure}
          onQuit={onQuit}
        />
      ) : null}
      {state.step === "verify" ? (
        <Verify
          pending={state.pending}
          error={state.error}
          report={state.verifyReport}
          onVerify={onVerify}
          onRetry={onRetry}
          onQuit={onQuit}
        />
      ) : null}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}
