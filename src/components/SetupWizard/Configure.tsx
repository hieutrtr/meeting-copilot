// T-W.6 — Configure step. Calls `setup_configure_multi_output` to create
// the Multi-Output Device combining built-in output + BlackHole 2ch
// (atomic CFDictionary write per design §3, idempotent re-create per
// `crates/audio-capture/src/multi_output.rs`). No permission prompt; the
// only failure mode is `ConfigureError` from T-W.4.

interface ConfigureProps {
  pending: boolean;
  error: string | null;
  onConfigure: () => void;
  onQuit: () => void;
}

export function Configure({
  pending,
  error,
  onConfigure,
  onQuit,
}: ConfigureProps) {
  return (
    <section
      className="setup-wizard__step"
      data-testid="setup-wizard-step-configure"
      aria-label="Configure Multi-Output Device"
      aria-busy={pending}
    >
      <h2 className="setup-wizard__title">Create Multi-Output Device</h2>
      <p className="setup-wizard__body">
        This creates a virtual audio device named{" "}
        <strong>Meeting Copilot Multi-Output</strong> that fans out system
        audio to both your speakers (so you keep hearing the meeting) and
        BlackHole (so we can capture it).
      </p>
      <p className="setup-wizard__body setup-wizard__body--muted">
        No password prompt is needed for this step. If a device with the
        same name already exists, we'll reuse it — re-running the wizard is
        safe.
      </p>

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
        <button
          type="button"
          data-testid="setup-wizard-configure-button"
          onClick={onConfigure}
          disabled={pending}
          className="setup-wizard__button setup-wizard__button--primary"
        >
          {pending ? "Creating…" : "Create Multi-Output Device"}
        </button>
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
