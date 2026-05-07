// T-W.6 — Install step. Triggers `setup_install_blackhole`; streams brew
// stdout/stderr lines into a `<pre>` log; on `brew_found=false` shows the
// .pkg manual fallback URL with `target="_blank" rel="noopener"`.
//
// Pre-warning copy mirrors design §5 R-W.5 — the user may see a macOS
// password dialog (osascript admin) when brew shells out to install the
// .pkg into `/Library/Audio/Plug-Ins/HAL/`. The wizard pre-announces it so
// the prompt isn't a surprise.

import type { InstallReport } from "./useSetupWizard";

interface InstallProps {
  pending: boolean;
  error: string | null;
  log: string[];
  report: InstallReport | null;
  onInstall: () => void;
  onRetryDetect: () => void;
  onQuit: () => void;
}

export function Install({
  pending,
  error,
  log,
  report,
  onInstall,
  onRetryDetect,
  onQuit,
}: InstallProps) {
  const showManualFallback = report != null && report.brew_found === false;

  return (
    <section
      className="setup-wizard__step"
      data-testid="setup-wizard-step-install"
      aria-label="Install BlackHole"
      aria-busy={pending}
    >
      <h2 className="setup-wizard__title">Install BlackHole 2ch</h2>
      <p className="setup-wizard__body">
        BlackHole 2ch is a free virtual audio device. We'll install it via
        Homebrew if available; otherwise we'll point you at the official
        installer.
      </p>
      <p className="setup-wizard__body setup-wizard__body--muted">
        You may see a macOS password prompt — that's Homebrew running the
        BlackHole installer. Type your login password to continue.
      </p>

      {showManualFallback ? (
        <div
          className="setup-wizard__manual"
          data-testid="setup-wizard-manual-fallback"
        >
          <p>
            Homebrew isn't installed on your Mac. Download the installer
            directly from the official site:
          </p>
          <a
            href={report!.manual_url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="setup-wizard-manual-url"
            className="setup-wizard__link"
          >
            {report!.manual_url}
          </a>
          <button
            type="button"
            data-testid="setup-wizard-retry-detect-button"
            onClick={onRetryDetect}
            className="setup-wizard__button"
          >
            I've installed it, re-check
          </button>
        </div>
      ) : null}

      {log.length > 0 ? (
        <pre
          className="setup-wizard__log"
          data-testid="setup-wizard-install-log"
          aria-live="polite"
        >
          {log.join("\n")}
        </pre>
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
        <button
          type="button"
          data-testid="setup-wizard-install-button"
          onClick={onInstall}
          disabled={pending}
          className="setup-wizard__button setup-wizard__button--primary"
        >
          {pending ? "Installing…" : "Install via Homebrew"}
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
