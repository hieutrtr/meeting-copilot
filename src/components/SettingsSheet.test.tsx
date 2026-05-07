// @vitest-environment jsdom
//
// Phase 3 T-3.6 — `SettingsSheet` RTL component tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.6-settings-ui.md):
//   SH-U1 → initial render: picker = "mlx", API-key disabled
//   SH-U2 → change picker → store.sttProvider updates; API-key enabled
//   SH-U3 → type API key with provider=deepgram → store.apiKeys.deepgram updates
//   SH-U4 → switch provider → API-key input shows the new provider's stored key
//   SH-U5 → Test Connection ok=true mock → pill `pending → success` within 3 s
//   SH-U6 → Test Connection ok=false mock → pill `fail`, error message rendered
//   SH-U7 → Test Connection on mlx → no key needed, pill `success`
//   SH-U8 → debounce: second click while pending is a no-op (1 mock call total)
//
// The singleton `useSettingsStore` is shared across the suite (same module
// instance vitest hands every test). We reset it between tests via the
// store's own `reset()` action plus `localStorage.clear()` so each spec sees
// a clean canonical state.

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SettingsSheet } from "./SettingsSheet";
import type { TestConnectionFn } from "../settings/testConnection";
import { useSettingsStore } from "../store/settingsStore";

beforeEach(() => {
  // Pre-T-3.6 baseline localStorage may contain v1/v2 payloads from the
  // singleton initialization. Wipe it AND the in-memory store before each
  // spec so the picker / api-key fields start at documented defaults.
  try {
    globalThis.localStorage?.clear();
  } catch {
    // jsdom may not expose localStorage in some envs — best-effort.
  }
  act(() => {
    useSettingsStore.getState().reset();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("SettingsSheet — initial render (SH-U1)", () => {
  it("SH-U1: defaults to picker=mlx with API-key input disabled", () => {
    render(<SettingsSheet />);
    const select = screen.getByTestId(
      "settings-provider-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("mlx");

    const input = screen.getByTestId(
      "settings-api-key-input",
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("");

    const status = screen.getByTestId("settings-test-connection-status");
    expect(status.getAttribute("data-status")).toBe("idle");
    expect(status.textContent).toBe("");
  });
});

describe("SettingsSheet — picker change (SH-U2)", () => {
  it("SH-U2: switching to deepgram updates store and enables API-key input", () => {
    render(<SettingsSheet />);
    const select = screen.getByTestId(
      "settings-provider-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "deepgram" } });

    expect(useSettingsStore.getState().sttProvider).toBe("deepgram");
    expect(select.value).toBe("deepgram");

    const input = screen.getByTestId(
      "settings-api-key-input",
    ) as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});

describe("SettingsSheet — API key edit (SH-U3)", () => {
  it("SH-U3: typing into the API-key field updates apiKeys[provider] in the store", () => {
    render(<SettingsSheet />);
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    const input = screen.getByTestId(
      "settings-api-key-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "dg-secret-123" } });

    expect(useSettingsStore.getState().apiKeys.deepgram).toBe("dg-secret-123");
    expect(input.value).toBe("dg-secret-123");
    // Per-key isolation: the elevenlabs slot stays empty.
    expect(useSettingsStore.getState().apiKeys.elevenlabs).toBe("");
  });
});

describe("SettingsSheet — provider swap preserves per-key isolation (SH-U4)", () => {
  it("SH-U4: switching provider shows the new provider's stored key", () => {
    render(<SettingsSheet />);
    // Set a deepgram key
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    fireEvent.change(screen.getByTestId("settings-api-key-input"), {
      target: { value: "DG-KEY" },
    });

    // Swap to elevenlabs — input should now reflect the (empty) elevenlabs key
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "elevenlabs" },
    });
    let input = screen.getByTestId(
      "settings-api-key-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("");

    // Type an elevenlabs key
    fireEvent.change(input, { target: { value: "EL-KEY" } });
    expect(useSettingsStore.getState().apiKeys.elevenlabs).toBe("EL-KEY");

    // Swap back to deepgram — input should restore the prior DG-KEY
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    input = screen.getByTestId(
      "settings-api-key-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("DG-KEY");
  });
});

describe("SettingsSheet — Test Connection success (SH-U5)", () => {
  it("SH-U5: pill flips pending → success within 3 s on ok=true mock", async () => {
    const mock: TestConnectionFn = vi.fn(async () => ({
      ok: true,
      message: "Deepgram OK — handshake 142ms",
      latencyMs: 142,
    }));
    render(<SettingsSheet testConnection={mock} />);

    // Pre-set provider to deepgram + a key so the live path mock is exercised
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    fireEvent.change(screen.getByTestId("settings-api-key-input"), {
      target: { value: "DG-KEY" },
    });

    const start = Date.now();
    fireEvent.click(screen.getByTestId("settings-test-connection-button"));

    // Pending pill renders synchronously after click.
    const status = screen.getByTestId("settings-test-connection-status");
    expect(["pending", "success"]).toContain(status.getAttribute("data-status"));

    await waitFor(
      () => {
        expect(
          screen
            .getByTestId("settings-test-connection-status")
            .getAttribute("data-status"),
        ).toBe("success");
      },
      { timeout: 3000 },
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);

    expect(
      screen.getByTestId("settings-test-connection-status").textContent,
    ).toContain("Deepgram OK");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("deepgram", "DG-KEY");
  });
});

describe("SettingsSheet — Test Connection failure (SH-U6)", () => {
  it("SH-U6: pill flips to fail with the error message on ok=false mock", async () => {
    const mock: TestConnectionFn = vi.fn(async () => ({
      ok: false,
      message: "Deepgram: 401 Unauthorized",
      latencyMs: 88,
    }));
    render(<SettingsSheet testConnection={mock} />);

    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    fireEvent.change(screen.getByTestId("settings-api-key-input"), {
      target: { value: "BAD-KEY" },
    });
    fireEvent.click(screen.getByTestId("settings-test-connection-button"));

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-test-connection-status")
          .getAttribute("data-status"),
      ).toBe("fail");
    });
    expect(
      screen.getByTestId("settings-test-connection-status").textContent,
    ).toContain("401 Unauthorized");
  });
});

describe("SettingsSheet — Test Connection skip-on-mlx (SH-U7)", () => {
  it("SH-U7: clicking on mlx invokes the mock and renders success path", async () => {
    const mock: TestConnectionFn = vi.fn(async () => ({
      ok: true,
      message: "MLX local — no key required",
      latencyMs: 0,
    }));
    render(<SettingsSheet testConnection={mock} />);
    // Default provider is mlx — no extra setup needed.
    fireEvent.click(screen.getByTestId("settings-test-connection-button"));

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-test-connection-status")
          .getAttribute("data-status"),
      ).toBe("success");
    });
    expect(
      screen.getByTestId("settings-test-connection-status").textContent,
    ).toContain("MLX local");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("mlx", "");
  });
});

// ── Phase 3 T-3.8 — Privacy mode picker (SH-U9..SH-U14) ─────────────────────

describe("SettingsSheet — privacy picker default (SH-U9)", () => {
  it("SH-U9: privacy picker renders with default 'local-first'", () => {
    render(<SettingsSheet />);
    const picker = screen.getByTestId(
      "settings-privacy-mode-select",
    ) as HTMLSelectElement;
    expect(picker.value).toBe("local-first");
    // a11y: accessible name surfaces via aria-label OR <label>
    expect(picker.getAttribute("aria-label")).toBe("Privacy mode");
  });
});

describe("SettingsSheet — local-first disables cloud STT options (SH-U10)", () => {
  it("SH-U10: Deepgram + ElevenLabs options carry disabled + non-empty title", () => {
    render(<SettingsSheet />);
    const dgOption = screen.getByTestId(
      "settings-provider-option-deepgram",
    ) as HTMLOptionElement;
    expect(dgOption.disabled).toBe(true);
    expect(dgOption.getAttribute("title") ?? "").toMatch(/Switch to Cloud mode/);

    const elOption = screen.getByTestId(
      "settings-provider-option-elevenlabs",
    ) as HTMLOptionElement;
    expect(elOption.disabled).toBe(true);
    expect(elOption.getAttribute("title") ?? "").toMatch(/cloud STT/i);

    // MLX stays enabled
    const mlxOption = screen.getByTestId(
      "settings-provider-option-mlx",
    ) as HTMLOptionElement;
    expect(mlxOption.disabled).toBe(false);
    expect(mlxOption.getAttribute("title")).toBeNull();
  });
});

describe("SettingsSheet — switching to Cloud unlocks cloud STT (SH-U11)", () => {
  it("SH-U11: pick Cloud → Deepgram option no longer disabled", () => {
    render(<SettingsSheet />);
    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "cloud" },
    });
    const dgOption = screen.getByTestId(
      "settings-provider-option-deepgram",
    ) as HTMLOptionElement;
    expect(dgOption.disabled).toBe(false);
    expect(dgOption.getAttribute("title")).toBeNull();
  });
});

describe("SettingsSheet — auto-revert reflected on mode switch (SH-U12)", () => {
  it("SH-U12: Cloud→deepgram, switch to Local-first → STT picker shows mlx", () => {
    render(<SettingsSheet />);
    // Swap to cloud + pick deepgram
    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "cloud" },
    });
    fireEvent.change(screen.getByTestId("settings-provider-select"), {
      target: { value: "deepgram" },
    });
    expect(useSettingsStore.getState().sttProvider).toBe("deepgram");

    // Switch back to local-first → store auto-reverts; UI re-renders to mlx
    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "local-first" },
    });
    const select = screen.getByTestId(
      "settings-provider-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("mlx");
    expect(useSettingsStore.getState().sttProvider).toBe("mlx");
  });
});

describe("SettingsSheet — Mixed mode disables cloud STT (SH-U13)", () => {
  it("SH-U13: Mixed → Deepgram + ElevenLabs disabled, MLX allowed", () => {
    render(<SettingsSheet />);
    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "mixed" },
    });
    expect(
      (screen.getByTestId(
        "settings-provider-option-deepgram",
      ) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId(
        "settings-provider-option-elevenlabs",
      ) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId(
        "settings-provider-option-mlx",
      ) as HTMLOptionElement).disabled,
    ).toBe(false);
  });
});

describe("SettingsSheet — privacy summary line (SH-U14)", () => {
  it("SH-U14: summary text changes per mode (gives the user immediate feedback)", () => {
    render(<SettingsSheet />);
    const summary = screen.getByTestId("settings-privacy-mode-summary");
    expect(summary.textContent).toMatch(/local/i);

    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "cloud" },
    });
    expect(summary.textContent).toMatch(/cloud/i);

    fireEvent.change(screen.getByTestId("settings-privacy-mode-select"), {
      target: { value: "mixed" },
    });
    expect(summary.textContent).toMatch(/cloud TTS/i);
  });
});

describe("SettingsSheet — debounce in-flight click (SH-U8)", () => {
  it("SH-U8: second click while pending is a no-op (mock invoked once)", async () => {
    let resolveFn: (() => void) | null = null;
    const mock: TestConnectionFn = vi.fn(
      () =>
        new Promise<{ ok: boolean; message: string; latencyMs: number }>(
          (resolve) => {
            resolveFn = () =>
              resolve({ ok: true, message: "ok", latencyMs: 10 });
          },
        ),
    );
    render(<SettingsSheet testConnection={mock} />);

    const button = screen.getByTestId("settings-test-connection-button");
    fireEvent.click(button);
    // Second click while the first promise is still pending — should be ignored.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight promise; pill should flip to success.
    await act(async () => {
      resolveFn?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-test-connection-status")
          .getAttribute("data-status"),
      ).toBe("success");
    });

    // After completion, a fresh click is allowed to fire again.
    fireEvent.click(button);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
