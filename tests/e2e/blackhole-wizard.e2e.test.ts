// @vitest-environment jsdom
//
// T-W.9 — Fresh-Mac E2E simulation for the BlackHole Setup Wizard.
//
// Drives the production `<SetupWizard />` container end-to-end with all 4
// Tauri commands replaced by deterministic fixtures from
// `__fixtures__/wizard-states.ts`. No real CoreAudio enumeration, no real
// `brew install`, no real `cpal` capture stream — but every reducer
// transition, every step component, every prop wiring runs exactly as it
// will in production once T-W.7 swaps in `@tauri-apps/api/core::invoke`.
//
// AC traceability (see docs/tasks/blackhole-wizard/T-W.9-e2e.md):
//   E2E-1 → Happy path: fresh Mac → install → configure → verify → done
//   E2E-2 → Spy assertions: no real native calls leaked (every invoker is
//           the fixture-backed mock; counters match scenario length)
//   E2E-3 → 3/3 deterministic re-runs of E2E-1 (same fixture, same output)
//   E2E-4 → Error path A: brew-not-found → manual URL link rendered →
//           re-detect after manual install → flow resumes to done
//   E2E-5 → Error path B: verify silent → retry bounded to 3 attempts;
//           after 3rd silent result the wizard is still on verify, error
//           pane visible, no auto-advance to done
//
// Determinism notes:
//   - Fake timers (`vi.useFakeTimers()`) are installed in beforeEach to
//     remove wall-clock dependencies in any internal debounces. The
//     wizard reducer is sync; the only async surface is the invoker
//     promises themselves which we resolve immediately.
//   - The fixture queues are popped FIFO; an under-supply throws and
//     surfaces as a test failure with the scenario name.
//   - `cleanup()` after every `it` un-mounts and resets the JSDOM tree.

import "@testing-library/jest-dom/vitest";

import { createElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SetupWizard,
  type SetupWizardInvokers,
} from "../../src/components/SetupWizard/SetupWizard";

// Note: this file is `.e2e.test.ts` (not `.tsx`) per INDEX T-W.9 declared
// filename; JSX is unavailable, so component construction uses
// `React.createElement` directly. Same component contract, same render
// path, no behavioral difference vs the JSX form used in
// `src/components/SetupWizard/SetupWizard.test.tsx`.
import type {
  BlackHoleStatus,
  InstallReport,
  VerifyReport,
} from "../../src/components/SetupWizard/useSetupWizard";
import {
  SCENARIO_BREW_NOT_FOUND,
  SCENARIO_FRESH_MAC_HAPPY,
  SCENARIO_VERIFY_SILENT_RETRY,
  type WizardScenario,
} from "./__fixtures__/wizard-states";

// ── Test harness — fixture-backed invokers ───────────────────────────────────

interface ScenarioHandle {
  invokers: SetupWizardInvokers;
  detectMock: Mock<() => Promise<BlackHoleStatus>>;
  installMock: Mock<
    (onLine: (line: string) => void) => Promise<InstallReport>
  >;
  configureMock: Mock<() => Promise<{ deviceId: number }>>;
  verifyMock: Mock<(deviceId: number | null) => Promise<VerifyReport>>;
  /** Throws if any queue is under-supplied — surfaces fixture drift. */
  remaining(): {
    detect: number;
    install: number;
    configure: number;
    verify: number;
  };
}

function fromQueue<T>(label: string, queue: T[]): T {
  if (queue.length === 0) {
    throw new Error(
      `[T-W.9 fixture] ${label} queue empty — scenario expected fewer calls than the wizard made`,
    );
  }
  return queue.shift() as T;
}

function makeScenarioInvokers(scenario: WizardScenario): ScenarioHandle {
  // Mutable copies — each call drains FIFO.
  const detectQueue: Array<BlackHoleStatus | Error> = [...scenario.detect];
  const installQueue: Array<{
    report: InstallReport;
    stdout: ReadonlyArray<string>;
  }> = [...scenario.install];
  const configureQueue: Array<{ deviceId: number } | Error> = [
    ...scenario.configure,
  ];
  const verifyQueue: Array<VerifyReport | Error> = [...scenario.verify];

  const detectMock = vi.fn<() => Promise<BlackHoleStatus>>(async () => {
    const next = fromQueue("detect", detectQueue);
    if (next instanceof Error) throw next;
    return next;
  });

  const installMock = vi.fn<
    (onLine: (line: string) => void) => Promise<InstallReport>
  >(async (onLine) => {
    const next = fromQueue("install", installQueue);
    for (const line of next.stdout) onLine(line);
    return next.report;
  });

  const configureMock = vi.fn<() => Promise<{ deviceId: number }>>(async () => {
    const next = fromQueue("configure", configureQueue);
    if (next instanceof Error) throw next;
    return next;
  });

  const verifyMock = vi.fn<
    (deviceId: number | null) => Promise<VerifyReport>
  >(async () => {
    const next = fromQueue("verify", verifyQueue);
    if (next instanceof Error) throw next;
    return next;
  });

  const invokers: SetupWizardInvokers = {
    detect: () => detectMock(),
    install: (onLine) => installMock(onLine),
    configure: () => configureMock(),
    verify: (deviceId) => verifyMock(deviceId),
  };

  return {
    invokers,
    detectMock,
    installMock,
    configureMock,
    verifyMock,
    remaining: () => ({
      detect: detectQueue.length,
      install: installQueue.length,
      configure: configureQueue.length,
      verify: verifyQueue.length,
    }),
  };
}

beforeEach(() => {
  cleanup();
  // Fake timers keep retry-loop wall-clock out of the determinism budget.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── E2E-1 + E2E-2 ────────────────────────────────────────────────────────────

describe("T-W.9 — fresh-Mac E2E (happy path)", () => {
  it(
    "E2E-1+2: walks 5 steps deterministically; spy counters match fixture length; no real native calls",
    async () => {
      const handle = makeScenarioInvokers(SCENARIO_FRESH_MAC_HAPPY);
      const onDone = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(createElement(SetupWizard, { invokers: handle.invokers, onDone }));

      // Step 1: Welcome → click Continue
      expect(
        screen.getByTestId("setup-wizard-step-welcome"),
      ).toBeInTheDocument();
      await user.click(screen.getByTestId("setup-wizard-continue-button"));

      // Step 2: Detect (auto-fires) → fixture returns NotInstalled →
      // reducer short-circuits to install.
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-install"),
        ).toBeInTheDocument(),
      );
      expect(handle.detectMock).toHaveBeenCalledTimes(1);

      // Step 3: Install → click Install → fixture streams 4 stdout lines +
      // resolves brew_found=true → reducer advances to configure.
      await user.click(screen.getByTestId("setup-wizard-install-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-configure"),
        ).toBeInTheDocument(),
      );
      expect(handle.installMock).toHaveBeenCalledTimes(1);

      // Step 4: Configure → click → fixture returns deviceId=137 → verify.
      await user.click(screen.getByTestId("setup-wizard-configure-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-verify"),
        ).toBeInTheDocument(),
      );
      expect(handle.configureMock).toHaveBeenCalledTimes(1);

      // Step 5: Verify → click → fixture returns signal_present=true → done.
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-done"),
        ).toBeInTheDocument(),
      );
      expect(handle.verifyMock).toHaveBeenCalledTimes(1);
      // verify was called with the deviceId surfaced by configure_completed.
      expect(handle.verifyMock).toHaveBeenCalledWith(137);

      // E2E-2: spy assertions. Fixture queues fully drained → wizard made
      // exactly the calls scripted, no more, no less.
      expect(handle.remaining()).toEqual({
        detect: 0,
        install: 0,
        configure: 0,
        verify: 0,
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    },
  );
});

// ── E2E-3 ────────────────────────────────────────────────────────────────────

describe("T-W.9 — determinism (3/3 re-runs)", () => {
  // The same scenario, executed 3 times in sequence. Each iteration uses a
  // fresh handle (fresh fixture queues) and a fresh DOM (cleanup() in
  // beforeEach). Asserting onDone fires every run guarantees the FSM
  // reaches the terminal state without flake.
  it.each([1, 2, 3])(
    "E2E-3: deterministic run %i/3 of fresh-Mac happy path",
    async () => {
      const handle = makeScenarioInvokers(SCENARIO_FRESH_MAC_HAPPY);
      const onDone = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(createElement(SetupWizard, { invokers: handle.invokers, onDone }));

      await user.click(screen.getByTestId("setup-wizard-continue-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-install"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-install-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-configure"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-configure-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-verify"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-done"),
        ).toBeInTheDocument(),
      );

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(handle.remaining()).toEqual({
        detect: 0,
        install: 0,
        configure: 0,
        verify: 0,
      });
    },
  );
});

// ── E2E-4 ────────────────────────────────────────────────────────────────────

describe("T-W.9 — error path A (brew not found)", () => {
  it(
    "E2E-4: brew-not-found → manual URL link → re-detect after manual install → resume to done",
    async () => {
      const handle = makeScenarioInvokers(SCENARIO_BREW_NOT_FOUND);
      const onDone = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(createElement(SetupWizard, { invokers: handle.invokers, onDone }));

      // Welcome → Detect (fresh-Mac fixture) → Install
      await user.click(screen.getByTestId("setup-wizard-continue-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-install"),
        ).toBeInTheDocument(),
      );

      // Click install → fixture returns brew_found=false → manual URL
      // surfaces, FSM stays on install per reducer's install_completed
      // case (manual fallback branch).
      await user.click(screen.getByTestId("setup-wizard-install-button"));
      const link = await screen.findByTestId("setup-wizard-manual-url");
      expect(link).toHaveAttribute(
        "href",
        "https://existential.audio/blackhole/",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel") ?? "").toMatch(/noopener/);
      expect(
        screen.getByTestId("setup-wizard-step-install"),
      ).toBeInTheDocument();
      expect(handle.installMock).toHaveBeenCalledTimes(1);

      // User installs the .pkg out-of-band, then clicks "I've installed,
      // re-check" — that dispatches `back` → reducer goes detect, the
      // detect useEffect re-fires, fixture queue's 2nd entry returns
      // InstalledNotConfigured → reducer routes to configure.
      await user.click(
        screen.getByTestId("setup-wizard-retry-detect-button"),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-configure"),
        ).toBeInTheDocument(),
      );
      expect(handle.detectMock).toHaveBeenCalledTimes(2);

      // Configure → Verify → done
      await user.click(screen.getByTestId("setup-wizard-configure-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-verify"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-done"),
        ).toBeInTheDocument(),
      );

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(handle.remaining()).toEqual({
        detect: 0,
        install: 0,
        configure: 0,
        verify: 0,
      });
    },
  );
});

// ── E2E-5 ────────────────────────────────────────────────────────────────────

describe("T-W.9 — error path B (verify silent retry-bounded)", () => {
  it(
    "E2E-5: silent capture × 3 keeps FSM on verify; no auto-advance to done; error pane visible after final attempt",
    async () => {
      const handle = makeScenarioInvokers(SCENARIO_VERIFY_SILENT_RETRY);
      const onDone = vi.fn();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(createElement(SetupWizard, { invokers: handle.invokers, onDone }));

      // Returning-user fixture: detect short-circuits to verify.
      await user.click(screen.getByTestId("setup-wizard-continue-button"));
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-step-verify"),
        ).toBeInTheDocument(),
      );
      expect(handle.detectMock).toHaveBeenCalledTimes(1);
      // Install + configure must NOT have been touched on this path —
      // the wizard short-circuited per the reducer's nextStepForDetect.
      expect(handle.installMock).not.toHaveBeenCalled();
      expect(handle.configureMock).not.toHaveBeenCalled();

      // Attempt 1: click Test capture → silent → stays on verify, error visible.
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      const alert1 = await screen.findByTestId("setup-wizard-error");
      expect(alert1).toHaveTextContent(/no audio signal/i);
      expect(
        screen.getByTestId("setup-wizard-step-verify"),
      ).toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();

      // Attempt 2: click "Try again" → reducer's `retry` clears error and
      // re-enables Test-capture. Click Test capture again → silent again.
      await user.click(
        screen.getByTestId("setup-wizard-verify-retry-button"),
      );
      // After retry the error is cleared and the primary button reappears.
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-verify-button"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      const alert2 = await screen.findByTestId("setup-wizard-error");
      expect(alert2).toHaveTextContent(/no audio signal/i);

      // Attempt 3 (the bound): retry once more → silent → still on verify.
      await user.click(
        screen.getByTestId("setup-wizard-verify-retry-button"),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("setup-wizard-verify-button"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("setup-wizard-verify-button"));
      const alert3 = await screen.findByTestId("setup-wizard-error");
      expect(alert3).toHaveTextContent(/no audio signal/i);

      // After 3 silent attempts the FSM is still on verify, has NOT
      // auto-advanced to done, and onDone has NOT fired. The fixture queue
      // is fully drained (3 verify entries, 3 calls).
      expect(
        screen.getByTestId("setup-wizard-step-verify"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("setup-wizard-step-done"),
      ).not.toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();
      expect(handle.verifyMock).toHaveBeenCalledTimes(3);
      expect(handle.remaining()).toEqual({
        detect: 0,
        install: 0,
        configure: 0,
        verify: 0,
      });
    },
  );
});
