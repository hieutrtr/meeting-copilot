// @vitest-environment jsdom
//
// Phase 1 T-1.11 — `useAskClaude` hook tests.
//
// AC traceability (see docs/tasks/phase-1/T-1.11-answer-panel.md):
//   AC-H1 → initial state idle (text="", error=null)
//   AC-H2 → ask drives streaming → done (deltas accumulate, usage populated, costUsd > 0)
//   AC-H3 → synchronous MissingApiKeyError captured, not re-thrown
//   AC-H4 → mid-stream SDK error captured (status=error, text preserves partial)
//   AC-H5 → reset() clears state back to idle
//   AC-H6 → re-ask cancels prior stream (final text reflects only second input)

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { MissingApiKeyError, type AskClaudeEvent, type AskClaudeResult } from "../llm/claudeClient";

// ── Fake askClaude generator factory ─────────────────────────────────────
//
// Tests assemble a controllable "script" of yields + the final result, then
// assign to `nextRunner`. The hook (under test) imports `askClaude` from
// `../llm/claudeClient`; we vi.mock the module so each test injects its own
// behavior.

type Script = {
  deltas: string[];
  usage: AskClaudeResult["usage"];
  costUsd: number;
  cacheReadRatio: number;
  stopReason?: string;
  syncThrow?: Error;
  midThrow?: Error;
  // Manual gates so a test can pause delta delivery (used by AC-H6 to assert
  // that a second ask cancels the first).
  gates?: Array<Promise<void>>;
};

const state: { nextRunner: () => Script } = {
  nextRunner: () => ({
    deltas: ["he", "llo"],
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 22_000,
      output_tokens: 50,
    },
    costUsd: 0.0123,
    cacheReadRatio: 0.99,
    stopReason: "end_turn",
  }),
};

function makeGenerator(script: Script): AsyncGenerator<AskClaudeEvent, AskClaudeResult, void> {
  if (script.syncThrow) throw script.syncThrow;
  return (async function* () {
    for (let i = 0; i < script.deltas.length; i++) {
      const gate = script.gates?.[i];
      if (gate !== undefined) await gate;
      const text = script.deltas[i]!;
      yield { type: "delta", text };
      if (script.midThrow && i === Math.floor(script.deltas.length / 2)) {
        throw script.midThrow;
      }
    }
    yield { type: "usage", usage: script.usage };
    if (script.stopReason) yield { type: "stopReason", reason: script.stopReason };
    return {
      text: script.deltas.join(""),
      usage: script.usage,
      costUsd: script.costUsd,
      cacheReadRatio: script.cacheReadRatio,
      stopReason: script.stopReason,
    };
  })();
}

vi.mock("../llm/claudeClient", async (orig) => {
  const real = (await orig()) as typeof import("../llm/claudeClient");
  return {
    ...real,
    askClaude: vi.fn((_input: unknown, _opts?: unknown) => {
      const script = state.nextRunner();
      return makeGenerator(script);
    }),
  };
});

const { useAskClaude } = await import("./useAskClaude");

beforeEach(() => {
  state.nextRunner = () => ({
    deltas: ["he", "llo"],
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 22_000,
      output_tokens: 50,
    },
    costUsd: 0.0123,
    cacheReadRatio: 0.99,
    stopReason: "end_turn",
  });
});

afterEach(() => {
  cleanup();
});

const sampleInput = {
  question: "What is the latency?",
  contextDoc: "# PRD\nlatency budget 2s",
  recentTranscript: "Speaker: latency?",
};

describe("useAskClaude", () => {
  it("AC-H1: initial state is idle / empty / no error", () => {
    const { result } = renderHook(() => useAskClaude());
    expect(result.current.status).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.error).toBeNull();
    expect(result.current.usage).toBeUndefined();
    expect(result.current.costUsd).toBeUndefined();
  });

  it("AC-H2: ask drives status → streaming → done, accumulates text and usage", async () => {
    const { result } = renderHook(() => useAskClaude());

    await act(async () => {
      result.current.ask(sampleInput);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("done");
    });

    expect(result.current.text).toBe("hello");
    expect(result.current.usage?.cache_read_input_tokens).toBe(22_000);
    expect(result.current.costUsd).toBeCloseTo(0.0123);
    expect(result.current.cacheReadRatio).toBeGreaterThan(0.9);
    expect(result.current.error).toBeNull();
  });

  it("AC-H3: synchronous MissingApiKeyError captured into state instead of throwing", async () => {
    state.nextRunner = () => ({
      deltas: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      cacheReadRatio: 0,
      syncThrow: new MissingApiKeyError(),
    });
    const { result } = renderHook(() => useAskClaude());

    await act(async () => {
      result.current.ask(sampleInput);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBeInstanceOf(MissingApiKeyError);
  });

  it("AC-H4: mid-stream error captured; partial text preserved", async () => {
    state.nextRunner = () => ({
      deltas: ["aa", "bb", "cc"],
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      cacheReadRatio: 0,
      midThrow: new Error("upstream 503"),
    });
    const { result } = renderHook(() => useAskClaude());

    await act(async () => {
      result.current.ask(sampleInput);
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.message).toContain("upstream 503");
    // Deltas seen before the throw remain visible.
    expect(result.current.text.length).toBeGreaterThan(0);
  });

  it("AC-H5: reset() clears state back to idle", async () => {
    const { result } = renderHook(() => useAskClaude());
    await act(async () => {
      result.current.ask(sampleInput);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.text).toBe("");
    expect(result.current.usage).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("AC-H6: a second ask cancels the first; final text reflects only the second input", async () => {
    // First runner: gated on a manually-released promise so the test can pause it.
    const releaser: { fn: (() => void) | null } = { fn: null };
    const gate = new Promise<void>((res) => {
      releaser.fn = res;
    });
    let callCount = 0;
    state.nextRunner = () => {
      callCount++;
      if (callCount === 1) {
        return {
          deltas: ["first-a", "first-b"],
          usage: { input_tokens: 1, output_tokens: 1 },
          costUsd: 0.001,
          cacheReadRatio: 0,
          // gates[0] applies before the FIRST yield. We pause forever (release
          // is never called), so the first generator's deltas never land.
          gates: [gate],
        };
      }
      return {
        deltas: ["second-a", "second-b"],
        usage: { input_tokens: 2, output_tokens: 2 },
        costUsd: 0.002,
        cacheReadRatio: 0.99,
        stopReason: "end_turn",
      };
    };

    const { result } = renderHook(() => useAskClaude());

    await act(async () => {
      result.current.ask(sampleInput);
    });
    // Now ask again — should cancel the first.
    await act(async () => {
      result.current.ask({ ...sampleInput, question: "second question" });
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    // Final text never includes the first stream's deltas.
    expect(result.current.text).toBe("second-asecond-b");
    // Releasing the first runner late must not pollute state.
    releaser.fn?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(result.current.text).toBe("second-asecond-b");
  });
});
