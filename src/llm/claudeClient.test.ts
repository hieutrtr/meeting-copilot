// Phase 1 T-1.10 — claudeClient vitest harness.
//
// AC traceability (see docs/tasks/phase-1/T-1.10-claude-streaming.md):
//   CL-S1  → AC-5/AC-6 (missing key throws synchronously, no key in error)
//   CL-S2  → AC-2 (model / max_tokens / temperature constants)
//   CL-S3  → AC-2 (system[0]/system[1] both cached, ARCH §6.2)
//   CL-S4  → AC-2 (user message has 2 NON-cached parts, ARCH §7.2)
//   CL-S5  → AC-2 (transcript + question wording embed correctly)
//   CL-S6  → AC-8 (empty transcript → "(no recent transcript yet)" placeholder)
//   CL-S7  → AC-3 (byte-identical body across 2 calls)
//   CL-S8  → AC-4 (deltas yield as text fires)
//   CL-S9  → AC-7 (final result aggregates text + usage + cost + ratio)
//   CL-S10 → AC-6 (apiKey opt overrides env var)
//   CL-S11 → AC-6 (SDK errors propagate, no key leak)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake SDK ──────────────────────────────────────────────────────────────
//
// Captures the most-recent constructor `apiKey`, the most-recent body passed
// to `messages.stream`, and lets each test inject its own delta sequence
// + final usage block via `nextScript`.

type TextListener = (text: string) => void;
type FinalListener = () => void;
type ErrorListener = (err: unknown) => void;

interface SdkScript {
  deltas: string[];
  finalUsage: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
  };
  stopReason?: string;
  throwOnFinal?: Error;
}

const captured: {
  apiKeys: string[];
  bodies: unknown[];
  nextScript: SdkScript;
} = {
  apiKeys: [],
  bodies: [],
  nextScript: {
    deltas: ["hel", "lo"],
    finalUsage: {
      input_tokens: 1,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 22_000,
      output_tokens: 50,
    },
    stopReason: "end_turn",
  },
};

class FakeStream {
  private textListeners: TextListener[] = [];
  private finalListeners: FinalListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private script: SdkScript;

  constructor(script: SdkScript) {
    this.script = script;
  }

  on(event: string, cb: TextListener | FinalListener | ErrorListener): this {
    if (event === "text") this.textListeners.push(cb as TextListener);
    if (event === "finalMessage") this.finalListeners.push(cb as FinalListener);
    if (event === "error") this.errorListeners.push(cb as ErrorListener);
    return this;
  }

  async finalMessage(): Promise<{
    content: { type: string; text: string }[];
    usage: SdkScript["finalUsage"];
    stop_reason?: string;
  }> {
    // Emit text events synchronously off a microtask so any `for await` consumer
    // that .next()s the generator sees them before the resolver fires.
    for (const t of this.script.deltas) {
      for (const cb of this.textListeners) cb(t);
    }
    if (this.script.throwOnFinal) {
      for (const cb of this.errorListeners) cb(this.script.throwOnFinal);
      throw this.script.throwOnFinal;
    }
    const message = {
      content: [{ type: "text", text: this.script.deltas.join("") }],
      usage: this.script.finalUsage,
      stop_reason: this.script.stopReason,
    };
    for (const cb of this.finalListeners) cb();
    return message;
  }
}

class FakeAnthropic {
  public messages: { stream: (body: unknown) => FakeStream };
  constructor(opts: { apiKey: string }) {
    captured.apiKeys.push(opts.apiKey);
    this.messages = {
      stream: (body: unknown) => {
        captured.bodies.push(body);
        return new FakeStream(captured.nextScript);
      },
    };
  }
}

vi.mock("@anthropic-ai/sdk", () => ({
  default: FakeAnthropic,
}));

const { askClaude, MissingApiKeyError, MODEL, MAX_TOKENS } = await import("./claudeClient");

// ── Test fixtures ─────────────────────────────────────────────────────────

const sampleInput = {
  question: "What is the current end-to-end latency?",
  contextDoc: "# PRD\n\nLatency budget is 2 seconds for first token.",
  recentTranscript: "Speaker 1: how is latency? Speaker 2: about 2.4s end-to-end.",
};

function resetCaptured() {
  captured.apiKeys.length = 0;
  captured.bodies.length = 0;
  captured.nextScript = {
    deltas: ["hel", "lo"],
    finalUsage: {
      input_tokens: 1,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 22_000,
      output_tokens: 50,
    },
    stopReason: "end_turn",
  };
}

const ENV_BACKUP = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  resetCaptured();
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  resetCaptured();
  if (ENV_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ENV_BACKUP;
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("askClaude — error paths", () => {
  it("CL-S1: throws MissingApiKeyError synchronously when no key is provided", () => {
    expect(() => askClaude(sampleInput)).toThrow(MissingApiKeyError);
  });

  it("CL-S1: error message does not echo any key-shaped substring", () => {
    process.env.ANTHROPIC_API_KEY = ""; // empty string still missing
    let err: unknown;
    try {
      askClaude(sampleInput);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingApiKeyError);
    const msg = (err as Error).message;
    expect(msg).not.toContain("sk-ant-");
    expect(msg.toLowerCase()).toContain("api key");
  });
});

describe("askClaude — request shape (mocked SDK)", () => {
  async function drainAll(input = sampleInput, opts = { apiKey: "test-key" }) {
    const gen = askClaude(input, opts);
    for await (const _ of gen) {
      // drain
    }
    return gen;
  }

  it("CL-S2: model / max_tokens / temperature constants", async () => {
    await drainAll();
    const body = captured.bodies[0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(600);
    expect(body.temperature).toBe(0);
    expect(MODEL).toBe("claude-sonnet-4-6");
    expect(MAX_TOKENS).toBe(600);
  });

  it("CL-S3: system[0] + system[1] both have cache_control: ephemeral (ARCH §6.2)", async () => {
    await drainAll();
    const body = captured.bodies[0] as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>;
    };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(2);
    for (const block of body.system) {
      expect(block.type).toBe("text");
      expect(block.cache_control).toEqual({ type: "ephemeral" });
      expect(typeof block.text).toBe("string");
      expect(block.text.length).toBeGreaterThan(0);
    }
    expect(body.system[0]!.text).toContain("Meeting Copilot");
    expect(body.system[1]!.text).toBe(sampleInput.contextDoc);
  });

  it("CL-S4: user message has 2 content parts and NO cache_control on either (ARCH §7.2)", async () => {
    await drainAll();
    const body = captured.bodies[0] as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; text: string; cache_control?: unknown }>;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[0]!.content).toHaveLength(2);
    for (const part of body.messages[0]!.content) {
      expect(part.type).toBe("text");
      expect((part as Record<string, unknown>).cache_control).toBeUndefined();
    }
  });

  it("CL-S5: transcript + question wording embed correctly", async () => {
    await drainAll();
    const body = captured.bodies[0] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const [transcriptPart, questionPart] = body.messages[0]!.content;
    expect(transcriptPart!.text.startsWith("Recent transcript")).toBe(true);
    expect(transcriptPart!.text).toContain(sampleInput.recentTranscript);
    expect(questionPart!.text.startsWith("Question detected:")).toBe(true);
    expect(questionPart!.text).toContain(sampleInput.question);
  });

  it("CL-S6: empty transcript → '(no recent transcript yet)' placeholder", async () => {
    await drainAll({ ...sampleInput, recentTranscript: "" });
    const body = captured.bodies[0] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.messages[0]!.content[0]!.text).toContain("(no recent transcript yet)");
  });

  it("CL-S7: byte-identical request body across 2 calls (cache key stability)", async () => {
    await drainAll();
    await drainAll();
    expect(captured.bodies).toHaveLength(2);
    const a = JSON.stringify(captured.bodies[0]);
    const b = JSON.stringify(captured.bodies[1]);
    expect(a).toBe(b);
  });
});

describe("askClaude — streaming + result", () => {
  it("CL-S8: yields delta events in order as the SDK 'text' event fires", async () => {
    captured.nextScript.deltas = ["hel", "lo", " world"];
    const gen = askClaude(sampleInput, { apiKey: "test-key" });
    const collected: string[] = [];
    for await (const event of gen) {
      if (event.type === "delta") collected.push(event.text);
    }
    expect(collected).toEqual(["hel", "lo", " world"]);
  });

  it("CL-S9: final result aggregates text + usage + cost + cacheReadRatio", async () => {
    const gen = askClaude(sampleInput, { apiKey: "test-key" });
    let resultFromReturn: unknown;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        resultFromReturn = step.value;
        break;
      }
    }
    expect(resultFromReturn).toBeDefined();
    const result = resultFromReturn as {
      text: string;
      usage: { cache_read_input_tokens?: number };
      cacheReadRatio: number;
      costUsd: number;
      stopReason?: string;
    };
    expect(result.text).toBe("hello");
    expect(result.usage.cache_read_input_tokens).toBe(22_000);
    expect(result.cacheReadRatio).toBeGreaterThan(0.99);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("askClaude — credentials", () => {
  it("CL-S10: explicit apiKey opt overrides env var", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    const gen = askClaude(sampleInput, { apiKey: "explicit-key" });
    for await (const _ of gen) {
      // drain
    }
    expect(captured.apiKeys[0]).toBe("explicit-key");
  });

  it("CL-S10b: falls back to env var when no opt is provided", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    const gen = askClaude(sampleInput);
    for await (const _ of gen) {
      // drain
    }
    expect(captured.apiKeys[0]).toBe("env-key");
  });
});

describe("askClaude — error propagation", () => {
  it("CL-S11: SDK errors thrown by finalMessage propagate through the generator without leaking the key", async () => {
    captured.nextScript.throwOnFinal = new Error("upstream 503 (no key in here)");
    const gen = askClaude(sampleInput, { apiKey: "test-key" });
    let caught: unknown;
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("test-key");
    expect((caught as Error).message).toContain("upstream");
  });
});
