// Phase 4 T-4.7 — JSON exporter unit tests.

import { describe, expect, it } from "vitest";

import { renderJson } from "./json";
import type { ExporterMeetingSnapshot } from "./types";

const SAMPLE: ExporterMeetingSnapshot = {
  meeting: {
    id: "m_42",
    title: "Roadmap sync",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_900_000,
    sttProvider: "mlx",
    model: "claude-sonnet-4-6",
    privacyMode: "local-first",
    status: "ended",
  },
  chunks: [
    {
      id: "c2",
      meetingId: "m_42",
      text: "second chunk",
      startTs: 5_000,
      endTs: 6_000,
      isFinal: true,
    },
    {
      id: "c1",
      meetingId: "m_42",
      text: "first chunk",
      startTs: 1_000,
      endTs: 2_000,
      isFinal: true,
    },
  ],
  questions: [
    {
      id: "q1",
      meetingId: "m_42",
      text: "What is the projected ARR by Q4?",
      detectedTs: 4_000,
      method: "auto",
      status: "answered",
    },
  ],
  answer: {
    id: "a1",
    questionId: "q1",
    text: "Per the PRD §3.1, target ARR is $4.2M by Q4.",
    generatedAt: 4_500,
    model: "claude-sonnet-4-6",
    tokensIn: 22_010,
    tokensOut: 48,
    cachedRatio: 0.997,
  },
};

describe("renderJson — round-trip + canonicalisation (T-4.7)", () => {
  it("body parses through JSON.parse without error", () => {
    const out = renderJson(SAMPLE);
    expect(() => JSON.parse(out.body)).not.toThrow();
  });

  it("ext/mime are 'json' / 'application/json'", () => {
    const out = renderJson(SAMPLE);
    expect(out.ext).toBe("json");
    expect(out.mime).toBe("application/json");
  });

  it("preserves field equality after JSON round-trip", () => {
    const out = renderJson(SAMPLE);
    const parsed = JSON.parse(out.body) as ExporterMeetingSnapshot;
    expect(parsed.meeting).toEqual(SAMPLE.meeting);
    expect(parsed.questions).toEqual(SAMPLE.questions);
    expect(parsed.answer).toEqual(SAMPLE.answer);
  });

  it("canonicalises chunks by startTs ASC (independent of input order)", () => {
    const out = renderJson(SAMPLE);
    const parsed = JSON.parse(out.body) as ExporterMeetingSnapshot;
    expect(parsed.chunks.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(parsed.chunks[0]?.startTs).toBe(1_000);
    expect(parsed.chunks[1]?.startTs).toBe(5_000);
  });

  it("uses 2-space indent (human-readable)", () => {
    const out = renderJson(SAMPLE);
    expect(out.body).toContain('\n  "meeting":');
    expect(out.body).toContain('\n    "id": "m_42"');
  });

  it("trailing newline ensures POSIX-style file ending", () => {
    const out = renderJson(SAMPLE);
    expect(out.body.endsWith("\n")).toBe(true);
  });

  it("control characters in chunk text round-trip via JSON escapes", () => {
    const tricky: ExporterMeetingSnapshot = {
      ...SAMPLE,
      chunks: [
        {
          id: "c1",
          meetingId: "m_42",
          text: 'line1\nline2\t"quoted"\\backslash',
          startTs: 1_000,
          endTs: 2_000,
          isFinal: true,
        },
      ],
    };
    const out = renderJson(tricky);
    const parsed = JSON.parse(out.body) as ExporterMeetingSnapshot;
    expect(parsed.chunks[0]?.text).toBe('line1\nline2\t"quoted"\\backslash');
  });
});
