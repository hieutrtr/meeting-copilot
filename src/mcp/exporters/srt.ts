// Phase 4 T-4.7 — SubRip Subtitle (SRT) exporter.
//
// SRT spec:
//   1
//   00:00:01,000 --> 00:00:02,500
//   first chunk text
//
//   2
//   00:00:05,000 --> 00:00:06,500
//   second chunk text
//
// Differences vs VTT:
//   - No "WEBVTT" header.
//   - Cue numbers are 1-indexed and prefix every cue.
//   - Millisecond separator is COMMA, not period.

import { formatTimestamp } from "./timestamp";
import type { ExporterMeetingSnapshot, RenderedExport } from "./types";

export function renderSrt(snapshot: ExporterMeetingSnapshot): RenderedExport {
  const sortedChunks = [...snapshot.chunks].sort((a, b) => {
    if (a.startTs !== b.startTs) return a.startTs - b.startTs;
    return a.id.localeCompare(b.id);
  });

  const startedAt = snapshot.meeting.startedAt;
  const lines: string[] = [];

  for (let i = 0; i < sortedChunks.length; i += 1) {
    const chunk = sortedChunks[i]!;
    const cueStart = formatTimestamp(chunk.startTs - startedAt, ",");
    const cueEnd = formatTimestamp(chunk.endTs - startedAt, ",");
    lines.push(String(i + 1));
    lines.push(`${cueStart} --> ${cueEnd}`);
    lines.push(chunk.text);
    lines.push("");
  }

  return {
    ext: "srt",
    mime: "application/x-subrip",
    body: lines.join("\n"),
  };
}
