// T-W.6 — Detect step. Auto-runs `setup_detect_blackhole` on mount and
// renders the 4-row checklist UI per design §4 ASCII diagram. Short-circuit
// branch (Configured / Verified → skip ahead) is in the reducer; this
// component is render-only against `state.detectStatus`.

import type { BlackHoleStatus } from "./useSetupWizard";

interface DetectProps {
  pending: boolean;
  error: string | null;
  status: BlackHoleStatus | null;
  onRetry: () => void;
  onQuit: () => void;
}

interface ChecklistRow {
  label: string;
  done: boolean;
}

function checklistRowsFor(status: BlackHoleStatus | null): ChecklistRow[] {
  // Three rows mirror probes (a)+(b)+(c) per design §1. The fourth row
  // (verify) is the next step's responsibility.
  if (!status) {
    return [
      { label: "BlackHole driver installed", done: false },
      { label: "BlackHole device visible to macOS", done: false },
      { label: "Multi-Output Device configured", done: false },
    ];
  }
  switch (status.kind) {
    case "not_installed":
      return [
        { label: "BlackHole driver installed", done: false },
        { label: "BlackHole device visible to macOS", done: false },
        { label: "Multi-Output Device configured", done: false },
      ];
    case "installed_not_configured":
      return [
        { label: "BlackHole driver installed", done: true },
        { label: "BlackHole device visible to macOS", done: true },
        { label: "Multi-Output Device configured", done: false },
      ];
    case "configured":
    case "verified":
      return [
        { label: "BlackHole driver installed", done: true },
        { label: "BlackHole device visible to macOS", done: true },
        { label: "Multi-Output Device configured", done: true },
      ];
  }
}

export function Detect({
  pending,
  error,
  status,
  onRetry,
  onQuit,
}: DetectProps) {
  const rows = checklistRowsFor(status);
  return (
    <section
      className="setup-wizard__step"
      data-testid="setup-wizard-step-detect"
      aria-label="Detect existing audio setup"
      aria-busy={pending}
    >
      <h2 className="setup-wizard__title">Checking your audio setup…</h2>
      <ul className="setup-wizard__checklist" data-testid="detect-checklist">
        {rows.map((row, idx) => (
          <li
            key={row.label}
            className="setup-wizard__checklist-row"
            data-testid={`detect-row-${idx}`}
            data-done={row.done ? "true" : "false"}
          >
            <span aria-hidden="true">{row.done ? "✓" : "·"}</span>
            <span>{row.label}</span>
          </li>
        ))}
      </ul>
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
          data-testid="setup-wizard-retry-button"
          onClick={onRetry}
          disabled={pending}
          className="setup-wizard__button"
        >
          {pending ? "Checking…" : "Re-check"}
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
