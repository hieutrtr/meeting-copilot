// Phase 2 T-2.3 — Haiku LLM filter (Stage 2 detector) test harness.
//
// AC traceability (see docs/tasks/phase-2/T-2.3-haiku-llm-filter.md):
//   HF-S1  → AC #5 (missing key throws synchronously, no key in error)
//   HF-S2  → AC #1 (model / max_tokens / temperature constants)
//   HF-S3  → AC #1 (single system block with cache_control: ephemeral)
//   HF-S4  → AC #1 (user message embeds the utterance verbatim)
//   HF-S5  → AC #1 (byte-identical body across 2 calls — cache key stability)
//   HF-S6  → AC #3 (parser robustness — YES/NO/MAYBE/garbage variants)
//   HF-S7  → AC #5 (env var fallback / explicit override)
//   HF-S8  → AC #4 (latencyMs plumbing)
//   HF-S9  → AC #5 (cost plumbing — costUsd matches computeHaikuCostUsd)
//   HF-S10 → AC #2 (gold-label agreement ≥ 0.85 on 100-sample fixture)
//   HF-S11 → AC threshold export (HAIKU_ADMIT_THRESHOLD === 0.7)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import goldFixture from "../../shared/fixtures/haiku-gold-100.json";

// ── Fake Anthropic SDK ────────────────────────────────────────────────────
//
// `messages.create()` is the non-streaming entry point used by the Haiku
// filter. The fake captures every constructor key + every request body, and
// the per-test script controls which `verdict` text the next call returns.

interface FakeMessageResponse {
  content: Array<{ type: "text"; text: string }>;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
  };
  stop_reason?: string;
}

const captured: {
  apiKeys: string[];
  bodies: unknown[];
  // If `responseFor` is set, it routes the response by inspecting the
  // request's user-text. Falls back to `nextResponse` when unset (default
  // for non-fixture tests).
  nextResponse: FakeMessageResponse;
  responseFor: ((userText: string) => FakeMessageResponse) | null;
  throwOnNext: Error | null;
} = {
  apiKeys: [],
  bodies: [],
  nextResponse: {
    content: [{ type: "text", text: "YES generic test reply." }],
    usage: { input_tokens: 150, output_tokens: 30 },
    stop_reason: "end_turn",
  },
  responseFor: null,
  throwOnNext: null,
};

class FakeAnthropic {
  public messages: {
    create: (body: unknown) => Promise<FakeMessageResponse>;
  };
  constructor(opts: { apiKey: string }) {
    captured.apiKeys.push(opts.apiKey);
    this.messages = {
      create: async (body: unknown) => {
        captured.bodies.push(body);
        if (captured.throwOnNext) {
          const e = captured.throwOnNext;
          captured.throwOnNext = null;
          throw e;
        }
        if (captured.responseFor) {
          const userText =
            ((body as {
              messages: Array<{ content: Array<{ text: string }> }>;
            }).messages?.[0]?.content?.[0]?.text) ?? "";
          return captured.responseFor(userText);
        }
        return captured.nextResponse;
      },
    };
  }
}

vi.mock("@anthropic-ai/sdk", () => ({
  default: FakeAnthropic,
}));

const {
  buildHaikuRequest,
  classifyWithHaiku,
  HAIKU_ADMIT_THRESHOLD,
  HAIKU_MAX_TOKENS,
  HAIKU_MODEL,
  HAIKU_TEMPERATURE,
  MissingApiKeyError,
  parseHaikuVerdict,
} = await import("./haikuFilter");
const { computeHaikuCostUsd } = await import("./pricing");

interface GoldSample {
  id: string;
  text: string;
  expected: boolean;
  lang: string;
  tag: string;
  haikuVerdict: string;
}
const fixture = goldFixture as { samples: GoldSample[] };

function resetCaptured() {
  captured.apiKeys.length = 0;
  captured.bodies.length = 0;
  captured.nextResponse = {
    content: [{ type: "text", text: "YES generic test reply." }],
    usage: { input_tokens: 150, output_tokens: 30 },
    stop_reason: "end_turn",
  };
  captured.responseFor = null;
  captured.throwOnNext = null;
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

describe("HF-S1: credentials — error path", () => {
  it("throws MissingApiKeyError synchronously when no key is provided", async () => {
    let err: unknown;
    try {
      await classifyWithHaiku("What is the deadline?");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingApiKeyError);
    const msg = (err as Error).message;
    expect(msg).not.toContain("sk-ant-");
    expect(msg.toLowerCase()).toContain("api key");
  });
});

describe("HF-S2..S5: request shape (mocked SDK)", () => {
  it("HF-S2: model / max_tokens / temperature constants", async () => {
    await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    const body = captured.bodies[0] as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.max_tokens).toBe(80);
    expect(body.temperature).toBe(0);
    expect(HAIKU_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(HAIKU_MAX_TOKENS).toBe(80);
    expect(HAIKU_TEMPERATURE).toBe(0);
  });

  it("HF-S3: system has exactly one block with cache_control: ephemeral", async () => {
    await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    const body = captured.bodies[0] as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>;
    };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(1);
    expect(body.system[0]!.type).toBe("text");
    expect(body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0]!.text.length).toBeGreaterThan(0);
    // The system text should mention the binary verdict format so the model
    // is steered into the parseable shape.
    expect(body.system[0]!.text).toContain("YES");
    expect(body.system[0]!.text).toContain("NO");
  });

  it("HF-S4: user message has 1 part with the utterance verbatim, no cache_control", async () => {
    await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    const body = captured.bodies[0] as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; text: string; cache_control?: unknown }>;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[0]!.content).toHaveLength(1);
    expect(body.messages[0]!.content[0]!.type).toBe("text");
    expect(
      (body.messages[0]!.content[0] as Record<string, unknown>).cache_control,
    ).toBeUndefined();
    expect(body.messages[0]!.content[0]!.text).toContain("What is the deadline?");
  });

  it("HF-S5: byte-identical body across two calls with same input (cache key stability)", async () => {
    await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    expect(captured.bodies).toHaveLength(2);
    expect(JSON.stringify(captured.bodies[0])).toBe(
      JSON.stringify(captured.bodies[1]),
    );
  });

  it("HF-S5b: buildHaikuRequest is pure", () => {
    const a = buildHaikuRequest("hello");
    const b = buildHaikuRequest("hello");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buildHaikuRequest("different");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});

describe("HF-S6: parser robustness", () => {
  it.each([
    ["YES it is a question.", true, 0.9],
    ["Yes — clear question.", true, 0.9],
    ["yes, asks for a date.", true, 0.9],
    ["YES.", true, 0.9],
    ["YES: rationale follows.", true, 0.9],
    ["  YES   leading whitespace ok", true, 0.9],
    ["YES\nadditional preamble lines\nignored", true, 0.9],
    ["NO declarative.", false, 0.1],
    ["No this is a statement.", false, 0.1],
    ["no, just venting.", false, 0.1],
    ["NO.", false, 0.1],
  ])("verdict %j → isQuestion=%s confidence=%s", (raw, isQ, conf) => {
    const v = parseHaikuVerdict(raw as string);
    expect(v.isQuestion).toBe(isQ);
    expect(v.confidence).toBe(conf);
  });

  it("ambiguous reply (MAYBE / garbage / empty) maps to confidence 0.5 (won't trip threshold)", () => {
    const cases = ["MAYBE could go either way", "", "...", "I don't know"];
    for (const raw of cases) {
      const v = parseHaikuVerdict(raw);
      expect(v.isQuestion).toBe(false);
      expect(v.confidence).toBe(0.5);
      expect(v.confidence).toBeLessThan(HAIKU_ADMIT_THRESHOLD);
    }
  });

  it("YES verdict at confidence 0.9 trips the admit threshold", () => {
    expect(0.9).toBeGreaterThanOrEqual(HAIKU_ADMIT_THRESHOLD);
  });

  it("NO verdict at confidence 0.1 fails the admit threshold", () => {
    expect(0.1).toBeLessThan(HAIKU_ADMIT_THRESHOLD);
  });
});

describe("HF-S7: credentials — env fallback + opt override", () => {
  it("falls back to ANTHROPIC_API_KEY env var when no opt is provided", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key-only";
    await classifyWithHaiku("What's up?");
    expect(captured.apiKeys[0]).toBe("env-key-only");
  });

  it("explicit apiKey opt overrides env var", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    await classifyWithHaiku("What's up?", { apiKey: "explicit-key" });
    expect(captured.apiKeys[0]).toBe("explicit-key");
  });
});

describe("HF-S8: latencyMs plumbing", () => {
  it("result.latencyMs is a finite number ≥ 0", async () => {
    const r = await classifyWithHaiku("What is the deadline?", {
      apiKey: "test-key",
    });
    expect(Number.isFinite(r.latencyMs)).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("HF-S9: cost plumbing", () => {
  it("result.costUsd matches computeHaikuCostUsd(usage) on the same usage block", async () => {
    captured.nextResponse = {
      content: [{ type: "text", text: "YES asks for a deadline." }],
      usage: { input_tokens: 200, output_tokens: 40 },
      stop_reason: "end_turn",
    };
    const r = await classifyWithHaiku("What is the deadline?", {
      apiKey: "test-key",
    });
    expect(r.usage.input_tokens).toBe(200);
    expect(r.usage.output_tokens).toBe(40);
    expect(r.costUsd).toBeCloseTo(
      computeHaikuCostUsd({ input_tokens: 200, output_tokens: 40 }),
      9,
    );
    // Sanity: per-call cost on a typical filter shape lands well under
    // a tenth of a cent.
    expect(r.costUsd).toBeLessThan(0.001);
  });
});

describe("HF-S10: gold-label agreement on 100-sample fixture", () => {
  it("fixture shape — 100 entries, ≥ 40 each class, unique IDs", () => {
    expect(fixture.samples).toHaveLength(100);
    const positives = fixture.samples.filter((s) => s.expected).length;
    const negatives = fixture.samples.filter((s) => !s.expected).length;
    expect(positives).toBeGreaterThanOrEqual(40);
    expect(negatives).toBeGreaterThanOrEqual(40);
    const ids = fixture.samples.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of fixture.samples) {
      expect(typeof s.haikuVerdict).toBe("string");
      expect(s.haikuVerdict.length).toBeGreaterThan(0);
    }
  });

  it("AC GATE — agreement ≥ 0.85 on the 100-sample fixture", async () => {
    // The mocked SDK returns each sample's encoded `haikuVerdict` whenever the
    // request body's user text contains that sample's text. This validates
    // the parser + threshold pipeline end-to-end against gold labels.
    captured.responseFor = (userText: string) => {
      const sample = fixture.samples.find((s) => userText.includes(s.text));
      const verdictText = sample
        ? sample.haikuVerdict
        : "MAYBE no fixture match";
      return {
        content: [{ type: "text", text: verdictText }],
        usage: { input_tokens: 150, output_tokens: 30 },
        stop_reason: "end_turn",
      };
    };

    let agree = 0;
    let confTpAtThreshold = 0;
    let confTnAtThreshold = 0;
    const disagreements: string[] = [];

    for (const s of fixture.samples) {
      const r = await classifyWithHaiku(s.text, { apiKey: "test-key" });
      // `isQuestion` is the parsed Haiku verdict; AC compares it to gold.
      if (r.isQuestion === s.expected) {
        agree++;
      } else {
        disagreements.push(`${s.id} expected=${s.expected} parsed=${r.isQuestion}`);
      }
      // Threshold-gated counts (T-2.5 admit logic):
      const admit = r.confidence >= HAIKU_ADMIT_THRESHOLD;
      if (admit && s.expected) confTpAtThreshold++;
      if (!admit && !s.expected) confTnAtThreshold++;
    }

    const agreement = agree / fixture.samples.length;
    // eslint-disable-next-line no-console
    console.log(
      `[T-2.3] gold-label agreement: ${agree}/${fixture.samples.length} (${(
        agreement * 100
      ).toFixed(1)} %)`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-2.3] threshold-gated TP=${confTpAtThreshold} TN=${confTnAtThreshold}`,
    );
    if (disagreements.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[T-2.3] disagreements (${disagreements.length}):`, disagreements);
    }

    expect(agreement).toBeGreaterThanOrEqual(0.85);
  });
});

describe("HF-S11: threshold export", () => {
  it("HAIKU_ADMIT_THRESHOLD === 0.7", () => {
    expect(HAIKU_ADMIT_THRESHOLD).toBe(0.7);
  });
});

describe("HF-S12: SDK error propagation", () => {
  it("SDK rejection from messages.create propagates without leaking the key", async () => {
    captured.throwOnNext = new Error("upstream 503 (no key in here)");
    let caught: unknown;
    try {
      await classifyWithHaiku("What is the deadline?", { apiKey: "test-key" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("test-key");
    expect((caught as Error).message).toContain("upstream");
  });
});
