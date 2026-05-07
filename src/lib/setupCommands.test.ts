// T-W.7 — Tests for the typed Tauri command wrappers.
//
// Mocks `@tauri-apps/api/core` so no real IPC fires; asserts that each
// wrapper:
//   1. invokes the canonical command name (snapshot-style — renaming the
//      command on either side trips this test);
//   2. forwards arguments under the names the Rust side expects (Tauri
//      camelCases the param names, so `device_hint` in Rust ↔ `deviceHint`
//      in JS);
//   3. returns the wire payload verbatim (no client-side transformation).

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const {
  SETUP_CONFIGURE_MULTI_OUTPUT,
  SETUP_DETECT_BLACKHOLE,
  SETUP_INSTALL_BLACKHOLE,
  SETUP_VERIFY_CAPTURE,
  setupConfigureMultiOutput,
  setupDetectBlackhole,
  setupInstallBlackhole,
  setupVerifyCapture,
} = await import("./setupCommands");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("SC-1: setupDetectBlackhole invokes setup_detect_blackhole", () => {
  it("returns the wire payload verbatim", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "not_installed" });
    const out = await setupDetectBlackhole();
    expect(invokeMock).toHaveBeenCalledWith(SETUP_DETECT_BLACKHOLE);
    expect(out).toEqual({ kind: "not_installed" });
  });

  it("forwards a configured payload through unchanged", async () => {
    const status = {
      kind: "configured" as const,
      blackhole_uid: "BlackHole2ch_UID",
      multi_output_uid: "MeetingCopilotMultiOut",
      multi_output_id: 137,
    };
    invokeMock.mockResolvedValueOnce(status);
    const out = await setupDetectBlackhole();
    expect(out).toEqual(status);
  });
});

describe("SC-2: setupInstallBlackhole invokes setup_install_blackhole", () => {
  it("returns the install report verbatim (brew_found=true)", async () => {
    const report = {
      brew_found: true,
      manual_url: "https://existential.audio/blackhole/",
      exit_code: 0,
    };
    invokeMock.mockResolvedValueOnce(report);
    const out = await setupInstallBlackhole();
    expect(invokeMock).toHaveBeenCalledWith(SETUP_INSTALL_BLACKHOLE);
    expect(out).toEqual(report);
  });

  it("returns the manual-fallback report (brew_found=false)", async () => {
    const report = {
      brew_found: false,
      manual_url: "https://existential.audio/blackhole/",
    };
    invokeMock.mockResolvedValueOnce(report);
    const out = await setupInstallBlackhole();
    expect(out).toEqual(report);
  });
});

describe("SC-3: setupConfigureMultiOutput forwards subDeviceUids", () => {
  it("invokes setup_configure_multi_output with camelCased arg name", async () => {
    invokeMock.mockResolvedValueOnce({ device_id: 901 });
    const out = await setupConfigureMultiOutput([
      "BuiltInSpeakerDevice",
      "BlackHole2ch_UID",
    ]);
    expect(invokeMock).toHaveBeenCalledWith(SETUP_CONFIGURE_MULTI_OUTPUT, {
      subDeviceUids: ["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
    });
    expect(out).toEqual({ device_id: 901 });
  });
});

describe("SC-4: setupVerifyCapture forwards deviceHint + durationMs", () => {
  it("invokes setup_verify_capture with both args", async () => {
    invokeMock.mockResolvedValueOnce({
      peak_amplitude: 0.5,
      signal_present: true,
      duration_ms_actual: 5_000,
      callback_count: 240,
    });
    const out = await setupVerifyCapture("blackhole 2ch", 5_000);
    expect(invokeMock).toHaveBeenCalledWith(SETUP_VERIFY_CAPTURE, {
      deviceHint: "blackhole 2ch",
      durationMs: 5_000,
    });
    expect(out.signal_present).toBe(true);
    expect(out.callback_count).toBe(240);
  });

  it("propagates rejection on verify error", async () => {
    invokeMock.mockRejectedValueOnce(
      "BlackHole present but silent — peak 1.0e-5 ≤ threshold 1.0e-3",
    );
    await expect(setupVerifyCapture("", 5_000)).rejects.toContain(
      "BlackHole present but silent",
    );
  });
});

describe("SC-5: command-name constants are stable", () => {
  it("matches the Rust #[tauri::command] fn names", () => {
    expect(SETUP_DETECT_BLACKHOLE).toBe("setup_detect_blackhole");
    expect(SETUP_INSTALL_BLACKHOLE).toBe("setup_install_blackhole");
    expect(SETUP_CONFIGURE_MULTI_OUTPUT).toBe("setup_configure_multi_output");
    expect(SETUP_VERIFY_CAPTURE).toBe("setup_verify_capture");
  });
});
