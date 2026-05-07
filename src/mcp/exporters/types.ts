// Phase 4 T-4.7 — Snapshot shape consumed by the 4 exporters.
//
// Mirrors `crates/helper-daemon::repo::MeetingSnapshot` 1:1 (camelCase via
// `serde(rename_all = "camelCase")`). We re-state the type here so the
// exporters stay decoupled from `shared/types.ts` (Tauri-bound) and the Rust
// crate (out-of-process). The MCP server is the standalone bun process; the
// snapshot it consumes arrives over an injected loader (`loadSnapshot`) and
// shapes are validated at the boundary.

export interface ExporterMeetingRow {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  sttProvider?: string;
  model?: string;
  privacyMode?: string;
  status: string;
}

export interface ExporterTranscriptChunk {
  id: string;
  meetingId: string;
  text: string;
  startTs: number;
  endTs: number;
  isFinal: boolean;
  speaker?: string;
  confidence?: number;
}

export interface ExporterQuestionRow {
  id: string;
  meetingId: string;
  text: string;
  detectedTs: number;
  method: string;
  confidence?: number;
  status?: string;
}

export interface ExporterAnswerRow {
  id: string;
  questionId: string;
  text: string;
  generatedAt: number;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedRatio?: number;
}

export interface ExporterContextSourceRow {
  id: string;
  path: string;
  charCount: number;
  estimatedTokens: number;
  loadedAt: number;
}

export interface ExporterMeetingSnapshot {
  meeting: ExporterMeetingRow;
  chunks: ExporterTranscriptChunk[];
  questions: ExporterQuestionRow[];
  answer?: ExporterAnswerRow;
  contextSource?: ExporterContextSourceRow;
}

export interface RenderedExport {
  ext: "md" | "json" | "vtt" | "srt";
  mime:
    | "text/markdown"
    | "application/json"
    | "text/vtt"
    | "application/x-subrip";
  body: string;
}

export type ExporterFormat = "markdown" | "json" | "vtt" | "srt";
