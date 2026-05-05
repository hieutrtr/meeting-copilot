// Phase 1 T-1.8 — vitest harness for the context store slice.
//
// AC traceability (see docs/tasks/phase-1/T-1.8-context-loader.md):
//   CTX-S1 → AC-6 (loadFromPath happy path: invokes `read_context_file`, sets `source`)
//   CTX-S2 → AC-6 (loadFromPath error path: invoke rejects → `error` set, `source` stays null)
//   CTX-S3 → AC-6 (clear() resets to null)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextFilePayload } from "./contextStore";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { useContextStore, READ_CONTEXT_FILE_COMMAND } = await import("./contextStore");

beforeEach(() => {
  invokeMock.mockReset();
  useContextStore.getState().clear();
});

afterEach(() => {
  useContextStore.getState().clear();
});

describe("useContextStore.loadFromPath", () => {
  it("CTX-S1: stores source on success", async () => {
    const payload: ContextFilePayload = {
      path: "/tmp/prd.md",
      content: "# PRD",
      charCount: 5,
      estimatedTokens: 2,
    };
    invokeMock.mockResolvedValueOnce(payload);

    await useContextStore.getState().loadFromPath("/tmp/prd.md");

    expect(invokeMock).toHaveBeenCalledWith(READ_CONTEXT_FILE_COMMAND, {
      path: "/tmp/prd.md",
    });

    const { source, content, error } = useContextStore.getState();
    expect(error).toBeNull();
    expect(content).toBe("# PRD");
    expect(source).not.toBeNull();
    expect(source!.path).toBe("/tmp/prd.md");
    expect(source!.charCount).toBe(5);
    expect(source!.estimatedTokens).toBe(2);
    expect(typeof source!.loadedAt).toBe("number");
  });

  it("CTX-S2: stores error on failure, leaves source null", async () => {
    invokeMock.mockRejectedValueOnce(new Error("unsupported extension `pdf`"));

    await useContextStore.getState().loadFromPath("/tmp/doc.pdf");

    const { source, error } = useContextStore.getState();
    expect(source).toBeNull();
    expect(error).toContain("unsupported extension");
  });

  it("CTX-S2 (string error): non-Error rejections still surface a message", async () => {
    invokeMock.mockRejectedValueOnce("io error reading `/x`: file not found");

    await useContextStore.getState().loadFromPath("/x");

    expect(useContextStore.getState().error).toContain("io error");
    expect(useContextStore.getState().source).toBeNull();
  });
});

describe("useContextStore.clear", () => {
  it("CTX-S3: resets source/content/error to null", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "/tmp/x.md",
      content: "x",
      charCount: 1,
      estimatedTokens: 1,
    } satisfies ContextFilePayload);
    await useContextStore.getState().loadFromPath("/tmp/x.md");
    expect(useContextStore.getState().source).not.toBeNull();

    useContextStore.getState().clear();

    expect(useContextStore.getState().source).toBeNull();
    expect(useContextStore.getState().content).toBeNull();
    expect(useContextStore.getState().error).toBeNull();
  });
});

describe("successful load clears prior error", () => {
  it("loading after a failed load wipes the error message", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await useContextStore.getState().loadFromPath("/bad");
    expect(useContextStore.getState().error).toBe("boom");

    invokeMock.mockResolvedValueOnce({
      path: "/tmp/ok.md",
      content: "ok",
      charCount: 2,
      estimatedTokens: 1,
    } satisfies ContextFilePayload);
    await useContextStore.getState().loadFromPath("/tmp/ok.md");

    expect(useContextStore.getState().error).toBeNull();
    expect(useContextStore.getState().source).not.toBeNull();
  });
});
