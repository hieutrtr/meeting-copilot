// Phase 4 T-4.7 — WebVTT exporter unit tests.

import { describe, expect, it } from "vitest";

import { renderVtt } from "./vtt";
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

const VTT_CUE_RE =
  /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/;

describe("renderVtt — WebVTT spec compliance (T-4.7)", () => {
  it("first line is 'WEBVTT'", () => {
    const out = renderVtt(SAMPLE);
    const lines = out.body.split("\n");
    expect(lines[0]).toBe("WEBVTT");
    expect(lines[1]).toBe("");
  });

  it("ext/mime are 'vtt' / 'text/vtt'", () => {
    const out = renderVtt(SAMPLE);
    expect(out.ext).toBe("vtt");
    expect(out.mime).toBe("text/vtt");
  });

  it("renders cues in startTs-ASC order regardless of input order", () => {
    const out = renderVtt(SAMPLE);
    expect(out.body).toMatch(/first chunk[\s\S]*second chunk/);
  });

  it("each cue header matches the WebVTT timestamp regex", () => {
    const out = renderVtt(SAMPLE);
    const matches = out.body.match(/^.* --> .*$/gm) ?? [];
    expect(matches.length).toBe(2);
    for (const cue of matches) {
      expect(cue).toMatch(VTT_CUE_RE);
    }
  });

  it("cue timestamps are 0-anchored relative to meeting.startedAt", () => {
    const out = renderVtt(SAMPLE);
    expect(out.body).toContain("00:00:01.000 --> 00:00:02.500");
    expect(out.body).toContain("00:00:05.000 --> 00:00:06.500");
  });

  it("milliseconds are zero-padded to width 3", () => {
    const sn: ExporterMeetingSnapshot = {
      ...SAMPLE,
      chunks: [
        {
          id: "c1",
          meetingId: "m_42",
          text: "millisecond probe",
          startTs: 1_700_000_000_007,
          endTs: 1_700_000_000_073,
          isFinal: true,
        },
      ],
    };
    const out = renderVtt(sn);
    expect(out.body).toContain("00:00:00.007 --> 00:00:00.073");
  });

  it("blank line separates cues", () => {
    const out = renderVtt(SAMPLE);
    // Two cues + blank line after each = 4 \n's between cue starts
    const parts = out.body.split(/^00:/m);
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it("empty snapshot still emits the WEBVTT header", () => {
    const out = renderVtt({
      meeting: SAMPLE.meeting,
      chunks: [],
      questions: [],
    });
    expect(out.body.split("\n")[0]).toBe("WEBVTT");
  });
});
