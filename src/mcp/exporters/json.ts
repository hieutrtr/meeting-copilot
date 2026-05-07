// Phase 4 T-4.7 — JSON exporter.
//
// Pure function: serialise the snapshot via `JSON.stringify(_, null, 2)` so
// the file round-trips through `JSON.parse` and is human-readable. The wire
// shape mirrors the helper-daemon's `serde(rename_all = "camelCase")` output
// so a downstream consumer can deserialise into the same Rust struct.

import type { ExporterMeetingSnapshot, RenderedExport } from "./types";

export function renderJson(snapshot: ExporterMeetingSnapshot): RenderedExport {
  // Defensive sort: chunks by startTs ASC, questions by detectedTs ASC. The
  // helper-daemon already sorts on read, but the MCP server might receive
  // snapshots from other loaders (e.g. a Phase 4.x file-replay tool); we
  // apply a stable canonical order so the JSON file is reproducible.
  const sortedChunks = [...snapshot.chunks].sort((a, b) => {
    if (a.startTs !== b.startTs) return a.startTs - b.startTs;
    return a.id.localeCompare(b.id);
  });
  const sortedQuestions = [...snapshot.questions].sort(
    (a, b) => a.detectedTs - b.detectedTs,
  );

  const canonicalised: ExporterMeetingSnapshot = {
    meeting: snapshot.meeting,
    chunks: sortedChunks,
    questions: sortedQuestions,
    answer: snapshot.answer,
    contextSource: snapshot.contextSource,
  };

  const body = `${JSON.stringify(canonicalised, null, 2)}\n`;

  return {
    ext: "json",
    mime: "application/json",
    body,
  };
}
