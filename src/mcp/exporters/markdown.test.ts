// Phase 4 T-4.7 — Markdown exporter unit tests.

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";
import type { ExporterMeetingSnapshot } from "./types";

const STARTED_AT = 1_700_000_000_000;

const SAMPLE: ExporterMeetingSnapshot = {
  meeting: {
    id: "m_42",
    title: "Roadmap sync",
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 900_000,
    sttProvider: "mlx",
    model: "claude-sonnet-4-6",
    privacyMode: "local-first",
    status: "ended",
  },
  chunks: [
    {
      id: "c2",
      meetingId: "m_42",
      text: "second utterance",
      startTs: STARTED_AT + 5_000,
      endTs: STARTED_AT + 6_500,
      isFinal: true,
      speaker: "self",
    },
    {
      id: "c1",
      meetingId: "m_42",
      text: "first utterance",
      startTs: STARTED_AT + 1_000,
      endTs: STARTED_AT + 2_500,
      isFinal: true,
      speaker: "other",
    },
  ],
  questions: [
    {
      id: "q1",
      meetingId: "m_42",
      text: "What is the projected ARR by Q4?",
      detectedTs: STARTED_AT + 4_000,
      method: "auto",
      status: "answered",
    },
  ],
  answer: {
    id: "a1",
    questionId: "q1",
    text: "Per the PRD §3.1, target ARR is $4.2M by Q4.",
    generatedAt: STARTED_AT + 4_500,
    model: "claude-sonnet-4-6",
    tokensIn: 22_010,
    tokensOut: 48,
    cachedRatio: 0.997,
  },
  contextSource: {
    id: "ctx-1",
    path: "/Users/me/PRD.md",
    charCount: 18_204,
    estimatedTokens: 4_551,
    loadedAt: STARTED_AT - 1_000,
  },
};

describe("renderMarkdown — header (T-4.7)", () => {
  it("title is the H1 heading at the top", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body.split("\n")[0]).toBe("# Roadmap sync");
  });

  it("falls back to meeting.id when title is empty", () => {
    const out = renderMarkdown({
      ...SAMPLE,
      meeting: { ...SAMPLE.meeting, title: "" },
    });
    expect(out.body.split("\n")[0]).toBe("# m_42");
  });

  it("includes a 'Privacy mode:' badge", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toContain("> Privacy mode: local-first");
  });

  it("falls back to 'unknown' when privacy mode missing", () => {
    const out = renderMarkdown({
      ...SAMPLE,
      meeting: { ...SAMPLE.meeting, privacyMode: undefined },
    });
    expect(out.body).toContain("> Privacy mode: unknown");
  });

  it("includes a 'Cost: $…' line in the header", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toMatch(/^> Cost: \$\d+\.\d{2}/m);
  });

  it("renders 'no Q&A' cost when there is no answer", () => {
    const out = renderMarkdown({ ...SAMPLE, answer: undefined });
    expect(out.body).toContain("> Cost: $0.00 (no Q&A)");
  });
});

describe("renderMarkdown — Q/A blocks (T-4.7)", () => {
  it("renders the question text under an H3 heading", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toContain("### Q: What is the projected ARR by Q4?");
  });

  it("renders the linked answer below its question", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toContain(
      "Per the PRD §3.1, target ARR is $4.2M by Q4.",
    );
  });

  it("falls back to a no-answer marker when answer.questionId mismatches", () => {
    const out = renderMarkdown({
      ...SAMPLE,
      answer: { ...SAMPLE.answer!, questionId: "ghost" },
    });
    expect(out.body).toContain("_(no answer recorded)_");
  });

  it("falls back to a no-answer marker when there is no answer at all", () => {
    const out = renderMarkdown({ ...SAMPLE, answer: undefined });
    expect(out.body).toContain("_(no answer recorded)_");
  });

  it("annotates the question with detection timestamp + method", () => {
    const out = renderMarkdown(SAMPLE);
    // 4_000 ms after startedAt = 00:00:04.000
    expect(out.body).toContain("_Detected at 00:00:04.000 (auto)_");
  });
});

describe("renderMarkdown — transcript (T-4.7)", () => {
  it("emits transcript chunks in startTs ASC order with HH:MM:SS.mmm prefix", () => {
    const out = renderMarkdown(SAMPLE);
    const lines = out.body.split("\n");
    const idxFirst = lines.findIndex((l) => l.includes("first utterance"));
    const idxSecond = lines.findIndex((l) => l.includes("second utterance"));
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(lines[idxFirst]).toContain("[00:00:01.000]");
    expect(lines[idxSecond]).toContain("[00:00:05.000]");
  });

  it("renders the speaker tag in bold when present", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toContain("**other**: first utterance");
    expect(out.body).toContain("**self**: second utterance");
  });

  it("falls back to '(no transcript chunks)' when chunks is empty", () => {
    const out = renderMarkdown({
      ...SAMPLE,
      chunks: [],
    });
    expect(out.body).toContain("_(no transcript chunks)_");
  });

  it("includes the context source path when present", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.body).toContain("- Path: `/Users/me/PRD.md`");
    expect(out.body).toContain("18204 chars / ~4551 tokens");
  });

  it("omits the context section when contextSource is missing", () => {
    const out = renderMarkdown({
      ...SAMPLE,
      contextSource: undefined,
    });
    expect(out.body).not.toContain("## Context");
  });
});

describe("renderMarkdown — meta (T-4.7)", () => {
  it("ext/mime are 'md' / 'text/markdown'", () => {
    const out = renderMarkdown(SAMPLE);
    expect(out.ext).toBe("md");
    expect(out.mime).toBe("text/markdown");
  });

  it("Cost USD reflects sonnet-4-6 cached-ratio pricing", () => {
    // tokensIn=22010, cachedRatio=0.997, tokensOut=48 →
    //   uncached input = 22010 * 0.003 * 3 / 1M     ≈ 0.000198 USD
    //   cached   input = 22010 * 0.997 * 0.30 / 1M  ≈ 0.006583 USD
    //   output         = 48 * 15 / 1M               = 0.000720 USD
    //   total                                       ≈ 0.007501 USD → "$0.01"
    const usd =
      (22010 * (1 - 0.997) * 3) / 1_000_000 +
      (22010 * 0.997 * 0.3) / 1_000_000 +
      (48 * 15) / 1_000_000;
    expect(usd).toBeCloseTo(0.0075, 4);
    const out = renderMarkdown(SAMPLE);
    // 0.0075 → "$0.01" (rounded to 2 decimals)
    expect(out.body).toContain("> Cost: $0.01");
  });
});
