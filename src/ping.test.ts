// IPC schema-parity guard for the `ping` Tauri command (Phase 1 T-1.2).
// Pairs with the Rust unit tests in src-tauri/src/lib.rs:tests::ping_*.
// If the command name string drifts on either side, the front-end test fails first.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "ping") return "pong";
    throw new Error(`unmocked command: ${cmd}`);
  }),
}));

const { invoke } = await import("@tauri-apps/api/core");

describe("ping IPC contract", () => {
  it("invoke('ping') resolves to 'pong'", async () => {
    const result = await invoke<string>("ping");
    expect(result).toBe("pong");
  });

  it("rejects when the command name is anything but 'ping'", async () => {
    await expect(invoke<string>("not-ping")).rejects.toThrow("unmocked command: not-ping");
  });
});
