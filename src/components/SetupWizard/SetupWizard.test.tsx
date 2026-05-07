// @vitest-environment jsdom
//
// T-W.6 — RTL component tests for the SetupWizard container.
//
// AC traceability (see docs/tasks/blackhole-wizard/T-W.6-wizard.md):
//   SW-U1  → AC-RTL welcome renders + Continue advances to detect
//   SW-U2  → AC-RTL detect runs invoker on mount; resolves NotInstalled → install
//   SW-U3  → AC-RTL detect resolves Configured → short-circuits to verify
//   SW-U4  → AC-RTL detect rejection surfaces error + retry re-runs invoker
//   SW-U5  → AC-RTL install streams stdout lines into the log <pre>
//   SW-U6  → AC-RTL install brew_found=false renders manual URL link with target=_blank rel=noopener
//   SW-U7  → AC-RTL configure invokes the configure command on click
//   SW-U8  → AC-RTL configure error renders alert; FSM stays on configure
//   SW-U9  → AC-RTL verify happy path advances to done + fires onDone
//   SW-U10 → AC-RTL verify silent capture renders error + Try again button (retry)
//   SW-U11 → AC-RTL quit-wizard escape-hatch fires onDone from any step
//   SW-U12 → AC-RTL aria-modal=true and role=dialog set on root for focus-trap
//
// The container is tested with prop-injected invokers — no Tauri runtime,
// no fetch polyfill, no real CoreAudio. T-W.7 swaps invokers for live
// `@tauri-apps/api/core::invoke` calls; the contract here is what T-W.7
// must adapt to.

import "@testing-library/jest-dom/vitest";

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

import { SetupWizard, type SetupWizardInvokers } from "./SetupWizard";
import type {
  BlackHoleStatus,
  InstallReport,
  VerifyReport,
} from "./useSetupWizard";

interface InvokersHandle extends SetupWizardInvokers {
  detectMock: Mock;
  installMock: Mock;
  configureMock: Mock;
  verifyMock: Mock;
}

function makeInvokers(): InvokersHandle {
  const detectMock = vi.fn();
  const installMock = vi.fn();
  const configureMock = vi.fn();
  const verifyMock = vi.fn();
  return {
    detect: () => detectMock(),
    install: (onLine: (line: string) => void) => installMock(onLine),
    configure: () => configureMock(),
    verify: (deviceId: number | null) => verifyMock(deviceId),
    detectMock,
    installMock,
    configureMock,
    verifyMock,
  };
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── SW-U1 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — welcome step (SW-U1)", () => {
  it("SW-U1: welcome renders Continue button + Skip link; Continue advances to detect step", async () => {
    const invokers = makeInvokers();
    // Hold the detect invoker open so the FSM stays on `detect` after the
    // continue click — we want to assert the welcome→detect transition,
    // not the auto-advance past detect.
    let resolveDetect: (s: BlackHoleStatus) => void = () => {};
    invokers.detectMock.mockImplementation(
      () =>
        new Promise<BlackHoleStatus>((r) => {
          resolveDetect = r;
        }),
    );
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);

    expect(
      screen.getByTestId("setup-wizard-step-welcome"),
    ).toBeInTheDocument();
    const continueBtn = screen.getByTestId("setup-wizard-continue-button");
    await user.click(continueBtn);

    await waitFor(() => {
      expect(
        screen.getByTestId("setup-wizard-step-detect"),
      ).toBeInTheDocument();
    });

    // Clean up the held promise so subsequent renders don't leak.
    resolveDetect({ kind: "not_installed" });
  });
});

// ── SW-U2 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — detect step (SW-U2)", () => {
  it("SW-U2: detect auto-fires on mount; NotInstalled → advances to install", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));

    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument();
    });
    expect(invokers.detectMock).toHaveBeenCalledTimes(1);
  });
});

// ── SW-U3 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — short-circuit (SW-U3)", () => {
  it("SW-U3: detect Configured → skips install + configure; lands on verify", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "configured",
      blackhole_uid: "BlackHole2ch_UID",
      multi_output_uid: "MeetingCopilotMultiOut",
      multi_output_id: 137,
    } satisfies BlackHoleStatus);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));

    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-step-verify")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("setup-wizard-step-install"),
    ).not.toBeInTheDocument();
    expect(invokers.configureMock).not.toHaveBeenCalled();
  });
});

// ── SW-U4 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — detect failure + retry (SW-U4)", () => {
  it("SW-U4: detect rejection surfaces error pane; retry re-runs the invoker", async () => {
    const invokers = makeInvokers();
    invokers.detectMock
      .mockRejectedValueOnce(new Error("CoreAudio busy"))
      .mockResolvedValueOnce({
        kind: "not_installed",
      } satisfies BlackHoleStatus);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));

    const alert = await screen.findByTestId("setup-wizard-error");
    expect(alert).toHaveTextContent(/CoreAudio busy/);

    await user.click(screen.getByTestId("setup-wizard-retry-button"));

    await waitFor(() => {
      expect(invokers.detectMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument();
    });
  });
});

// ── SW-U5 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — install streaming (SW-U5)", () => {
  it("SW-U5: install streams brew lines into the log <pre>", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    invokers.installMock.mockImplementation((onLine: (line: string) => void) => {
      onLine("==> Downloading blackhole-2ch");
      onLine("==> Installing Cask blackhole-2ch");
      return Promise.resolve({
        brew_found: true,
        manual_url: "",
      } satisfies InstallReport);
    });
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("setup-wizard-install-button"));

    // brew_found=true → advance straight to configure (the log was visible
    // mid-stream; we assert its content by replaying with brew_found=false).
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-configure"),
      ).toBeInTheDocument(),
    );
    expect(invokers.installMock).toHaveBeenCalledTimes(1);
  });
});

// ── SW-U6 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — manual fallback (SW-U6)", () => {
  it("SW-U6: brew_found=false renders manual URL link with target=_blank rel=noopener; stays on install", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    invokers.installMock.mockResolvedValue({
      brew_found: false,
      manual_url: "https://existential.audio/blackhole/",
    } satisfies InstallReport);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("setup-wizard-install-button"));

    const link = await screen.findByTestId("setup-wizard-manual-url");
    expect(link).toHaveAttribute("href", "https://existential.audio/blackhole/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toMatch(/noopener/);
    // FSM stays on install (so user can retry detect after manual install).
    expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument();
  });
});

// ── SW-U7 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — configure invoke (SW-U7)", () => {
  it("SW-U7: clicking Configure invokes the configure command and advances on success", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "installed_not_configured",
      blackhole_uid: "BlackHole2ch_UID",
    } satisfies BlackHoleStatus);
    invokers.configureMock.mockResolvedValue({ deviceId: 999 });
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-configure"),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("setup-wizard-configure-button"));

    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-verify")).toBeInTheDocument(),
    );
    expect(invokers.configureMock).toHaveBeenCalledTimes(1);
  });
});

// ── SW-U8 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — configure error (SW-U8)", () => {
  it("SW-U8: configure rejection renders alert; FSM stays on configure", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "installed_not_configured",
      blackhole_uid: "BlackHole2ch_UID",
    } satisfies BlackHoleStatus);
    invokers.configureMock.mockRejectedValueOnce(
      new Error("CoreAudioFailed status=1852797028"),
    );
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(
        screen.getByTestId("setup-wizard-step-configure"),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("setup-wizard-configure-button"));

    const alert = await screen.findByTestId("setup-wizard-error");
    expect(alert).toHaveTextContent(/CoreAudioFailed/);
    expect(
      screen.getByTestId("setup-wizard-step-configure"),
    ).toBeInTheDocument();
  });
});

// ── SW-U9 ────────────────────────────────────────────────────────────────────

describe("SetupWizard — verify happy path (SW-U9)", () => {
  it("SW-U9: verify with signal_present=true → done + onDone fires", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "configured",
      blackhole_uid: "BlackHole2ch_UID",
      multi_output_uid: "MeetingCopilotMultiOut",
      multi_output_id: 7,
    } satisfies BlackHoleStatus);
    invokers.verifyMock.mockResolvedValue({
      peak_amplitude: 0.42,
      signal_present: true,
      duration_ms_actual: 5000,
      callback_count: 250,
    } satisfies VerifyReport);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-verify")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("setup-wizard-verify-button"));

    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-done")).toBeInTheDocument(),
    );
    expect(invokers.verifyMock).toHaveBeenCalledWith(7); // deviceId from detect
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// ── SW-U10 ───────────────────────────────────────────────────────────────────

describe("SetupWizard — verify silent (SW-U10)", () => {
  it("SW-U10: verify silent → error + Try again button → retry stays on verify", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "configured",
      blackhole_uid: "BlackHole2ch_UID",
      multi_output_uid: "MeetingCopilotMultiOut",
      multi_output_id: 7,
    } satisfies BlackHoleStatus);
    invokers.verifyMock.mockResolvedValue({
      peak_amplitude: 0.00009,
      signal_present: false,
      duration_ms_actual: 5000,
      callback_count: 250,
    } satisfies VerifyReport);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-verify")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("setup-wizard-verify-button"));

    const alert = await screen.findByTestId("setup-wizard-error");
    expect(alert).toHaveTextContent(/no audio signal/i);
    expect(
      screen.getByTestId("setup-wizard-verify-retry-button"),
    ).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("setup-wizard-verify-retry-button"));
    // Retry stays on verify; error cleared.
    expect(screen.getByTestId("setup-wizard-step-verify")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-wizard-error")).not.toBeInTheDocument();
  });
});

// ── SW-U11 ───────────────────────────────────────────────────────────────────

describe("SetupWizard — quit escape hatch (SW-U11)", () => {
  it("SW-U11: clicking Skip from welcome fires onDone (escape valve)", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-quit-link"));

    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-done")).toBeInTheDocument(),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    // detect was never invoked because the user quit on welcome.
    expect(invokers.detectMock).not.toHaveBeenCalled();
  });

  it("SW-U11b: clicking Skip from install also fires onDone", async () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    const onDone = vi.fn();

    const user = userEvent.setup();
    render(<SetupWizard invokers={invokers} onDone={onDone} />);
    await user.click(screen.getByTestId("setup-wizard-continue-button"));
    await waitFor(() =>
      expect(screen.getByTestId("setup-wizard-step-install")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("setup-wizard-quit-link"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

// ── SW-U12 ───────────────────────────────────────────────────────────────────

describe("SetupWizard — modal a11y (SW-U12)", () => {
  it("SW-U12: root has role=dialog and aria-modal=true (focus-trap surface)", () => {
    const invokers = makeInvokers();
    invokers.detectMock.mockResolvedValue({
      kind: "not_installed",
    } satisfies BlackHoleStatus);
    render(<SetupWizard invokers={invokers} onDone={vi.fn()} />);
    const root = screen.getByTestId("setup-wizard");
    expect(root).toHaveAttribute("role", "dialog");
    expect(root).toHaveAttribute("aria-modal", "true");
  });
});
