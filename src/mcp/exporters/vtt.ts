// Phase 4 T-4.7 — WebVTT exporter.
//
// Pure function that produces a valid WebVTT body:
//   WEBVTT
//
//   00:00:01.000 --> 00:00:02.500
//   first chunk text
//
//   00:00:05.000 --> 00:00:06.000
//   second chunk text
//
// Cue timestamps are computed relative to `meeting.startedAt`. The timestamps
// in the snapshot's chunks are already millisecond-since-epoch values; we
// subtract `startedAt` to produce a 0-anchored cue timeline. If a chunk's
// startTs predates startedAt (clock skew, late arrival), the timestamp
// formatter clamps to 0.

import { formatTimestamp } from "./timestamp";
import type { ExporterMeetingSnapshot, RenderedExport } from "./types";

export function renderVtt(snapshot: ExporterMeetingSnapshot): RenderedExport {
  const sortedChunks = [...snapshot.chunks].sort((a, b) => {
    if (a.startTs !== b.startTs) return a.startTs - b.startTs;
    return a.id.localeCompare(b.id);
  });

  const startedAt = snapshot.meeting.startedAt;
  const lines: string[] = ["WEBVTT", ""];

  for (const chunk of sortedChunks) {
    const startMs = chunk.startTs - startedAt;
    const endMs = chunk.endTs - startedAt;
    const cueStart = formatTimestamp(startMs, ".");
    const cueEnd = formatTimestamp(endMs, ".");
    lines.push(`${cueStart} --> ${cueEnd}`);
    lines.push(chunk.text);
    lines.push("");
  }

  return {
    ext: "vtt",
    mime: "text/vtt",
    body: `${lines.join("\n")}`,
  };
}
