// T-W.6 — Welcome step. First impression for the BlackHole Setup Wizard.
//
// Render-only: displays the rationale ("why we need BlackHole") + Continue
// button + Quit-wizard escape link. The Continue button dispatches
// `{ type: "continue" }` which advances the FSM to `detect`. The escape
// link dispatches `{ type: "quit" }` (handled at the container level —
// this component just calls onQuit).

interface WelcomeProps {
  onContinue: () => void;
  onQuit: () => void;
}

export function Welcome({ onContinue, onQuit }: WelcomeProps) {
  return (
    <section
      className="setup-wizard__step"
      data-testid="setup-wizard-step-welcome"
      aria-label="Welcome to setup"
    >
      <h2 className="setup-wizard__title">Set up audio capture</h2>
      <p className="setup-wizard__body">
        Meeting Copilot needs to capture both your microphone and the audio
        coming from your meeting (the other participants). On macOS, the
        latter requires a small free utility called <strong>BlackHole 2ch</strong>.
        This wizard installs and configures it for you.
      </p>
      <p className="setup-wizard__body setup-wizard__body--muted">
        You'll keep hearing the meeting on your speakers — BlackHole just
        adds a parallel "tap" so we can transcribe what's said.
      </p>
      <div className="setup-wizard__actions">
        <button
          type="button"
          data-testid="setup-wizard-continue-button"
          onClick={onContinue}
          className="setup-wizard__button setup-wizard__button--primary"
        >
          Continue
        </button>
        <button
          type="button"
          data-testid="setup-wizard-quit-link"
          onClick={onQuit}
          className="setup-wizard__link"
        >
          Skip — I have a custom audio setup
        </button>
      </div>
    </section>
  );
}
