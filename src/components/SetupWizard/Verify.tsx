// T-W.6 — Verify step. Calls `setup_verify_capture` (5s capture from
// BlackHole sub-device); renders a peak-amplitude meter and gates the
// "All set" success panel off `signal_present`. On a silent capture
// (BlackHolePresentButSilent — Swift exit 8 mirror), surfaces an error +
// "Try again" button (retry is bounded by the parent — design notes 3
// attempts but the reducer is unconstrained; the App-level wiring caps it).

import type { VerifyReport } from "./useSetupWizard";

interface VerifyProps {
  pending: boolean;
  error: string | null;
  report: VerifyReport | null;
  onVerify: () => void;
  onRetry: () => void;
  onQuit: () => void;
}

export function Verify({
  pending,
  error,
  report,
  onVerify,
  onRetry,
  onQuit,
}: VerifyProps) {
  const peak = report?.peak_amplitude ?? 0;
  const peakPct = Math.min(100, Math.max(0, Math.round(peak * 1000) / 10));
  const showRetry = error != null && report != null;

  return (
    <section
      className="setup-wizard__step"
      data-testid="setup-wizard-step-verify"
      aria-label="Verify audio capture"
      aria-busy={pending}
    >
      <h2 className="setup-wizard__title">Test audio capture</h2>
      <p className="setup-wizard__body">
        We'll record 5 seconds from the Multi-Output Device to confirm
        BlackHole is routing audio correctly. Play any audio (a YouTube
        video, music, your meeting app) while the test runs.
      </p>
      <p className="setup-wizard__body setup-wizard__body--muted">
        macOS will ask for microphone access in a moment. We need this to
        capture audio (mic + system) — both go through the microphone TCC
        bucket on macOS 14+.
      </p>

      {report ? (
        <div
          className="setup-wizard__meter"
          data-testid="setup-wizard-peak-meter"
          data-signal-present={report.signal_present ? "true" : "false"}
        >
          <div
            className="setup-wizard__meter-fill"
            style={{ width: `${peakPct}%` }}
            aria-hidden="true"
          />
          <span data-testid="setup-wizard-peak-value">
            Peak: {peak.toFixed(4)} ({report.callback_count} samples)
          </span>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          data-testid="setup-wizard-error"
          className="setup-wizard__error"
        >
          {error}
        </div>
      ) : null}

      <div className="setup-wizard__actions">
        {showRetry ? (
          <button
            type="button"
            data-testid="setup-wizard-verify-retry-button"
            onClick={onRetry}
            disabled={pending}
            className="setup-wizard__button setup-wizard__button--primary"
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            data-testid="setup-wizard-verify-button"
            onClick={onVerify}
            disabled={pending}
            className="setup-wizard__button setup-wizard__button--primary"
          >
            {pending ? "Recording 5s…" : "Test capture"}
          </button>
        )}
        <button
          type="button"
          data-testid="setup-wizard-quit-link"
          onClick={onQuit}
          className="setup-wizard__link"
        >
          Skip wizard
        </button>
      </div>
    </section>
  );
}
