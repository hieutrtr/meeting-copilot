// Phase 4 T-4.7 — SubRip (SRT) exporter unit tests.

import { describe, expect, it } from "vitest";

import { renderSrt } from "./srt";
import type { ExporterMeetingSnapshot } from "./types";

const SAMPLE: ExporterMeetingSnapshot = {
  meeting: {
    id: "m_42",
    title: "Roadmap sync",
    startedAt: 1_700_000_000_000,
    status: "ended",
  },
  chunks: [
    {
      id: "c2",
      meetingId: "m_42",
      text: "second chunk",
      startTs: 1_700_000_005_000,
      endTs: 1_700_000_006_500,
      isFinal: true,
    },
    {
      id: "c1",
      meetingId: "m_42",
      text: "first chunk",
      startTs: 1_700_000_001_000,
      endTs: 1_700_000_002_500,
      isFinal: true,
    },
  ],
  questions: [],
};

const SRT_CUE_RE =
  /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;

describe("renderSrt — SubRip spec compliance (T-4.7)", () => {
  it("ext/mime are 'srt' / 'application/x-subrip'", () => {
    const out = renderSrt(SAMPLE);
    expect(out.ext).toBe("srt");
    expect(out.mime).toBe("application/x-subrip");
  });

  it("does NOT emit a WEBVTT header (SRT has no header)", () => {
    const out = renderSrt(SAMPLE);
    expect(out.body.startsWith("WEBVTT")).toBe(false);
  });

  it("first cue is numbered 1 (1-indexed, NOT 0)", () => {
    const out = renderSrt(SAMPLE);
    expect(out.body.startsWith("1\n")).toBe(true);
  });

  it("renders cues in startTs-ASC order with sequential numbering", () => {
    const out = renderSrt(SAMPLE);
    // Expect: 1\n…first chunk\n\n2\n…second chunk
    expect(out.body).toMatch(/^1\n.*first chunk/s);
    expect(out.body).toMatch(/\n2\n.*second chunk/s);
  });

  it("each cue timestamp matches the SRT regex (comma not period)", () => {
    const out = renderSrt(SAMPLE);
    const matches = out.body.match(/^.* --> .*$/gm) ?? [];
    expect(matches.length).toBe(2);
    for (const cue of matches) {
      expect(cue).toMatch(SRT_CUE_RE);
      expect(cue.includes(".")).toBe(false);
    }
  });

  it("cue timestamps are 0-anchored relative to meeting.startedAt", () => {
    const out = renderSrt(SAMPLE);
    expect(out.body).toContain("00:00:01,000 --> 00:00:02,500");
    expect(out.body).toContain("00:00:05,000 --> 00:00:06,500");
  });

  it("blank line separates adjacent cues", () => {
    const out = renderSrt(SAMPLE);
    // Pattern: "first chunk\n\n2\n"
    expect(out.body).toMatch(/first chunk\n\n2\n/);
  });

  it("empty snapshot emits empty body (no header)", () => {
    const out = renderSrt({
      meeting: SAMPLE.meeting,
      chunks: [],
      questions: [],
    });
    expect(out.body).toBe("");
  });
});
