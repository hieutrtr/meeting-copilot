// Phase 4 T-4.9 — TS mirror of the Rust `EmbedEvent` enum
// (`crates/helper-daemon/src/embed_http.rs`). Adding a new variant requires
// bumping both sides in lockstep — the SSE wire format is the binding
// contract.
//
// Wire shape (camelCase, internally tagged):
//   { "kind": "transcriptChunk", "payload": { "chunkId": "...", ... } }
//   { "kind": "question",        "payload": { "questionId": "...", ... } }
//   { "kind": "answer",          "payload": { "answerId": "...", ... } }
//   { "kind": "meetingEnded",    "payload": { "endedAtMs": ... } }

export interface TranscriptChunkPayload {
  chunkId: string;
  speaker: string;
  text: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface QuestionPayload {
  questionId: string;
  text: string;
  detectedAtMs: number;
}

export interface AnswerPayload {
  questionId: string;
  answerId: string;
  text: string;
  completedAtMs: number;
}

export interface MeetingEndedPayload {
  endedAtMs: number;
}

export type EmbedEvent =
  | { kind: "transcriptChunk"; payload: TranscriptChunkPayload }
  | { kind: "question"; payload: QuestionPayload }
  | { kind: "answer"; payload: AnswerPayload }
  | { kind: "meetingEnded"; payload: MeetingEndedPayload };

/** Connection status surfaced in the iframe header pill. */
export type ConnectionState = "connecting" | "open" | "closed" | "error";

/** Full reducer state held by `<TranscriptEmbed/>`. Pure data — no DOM
 *  references or function bodies, so unit tests can construct fixtures
 *  inline without rendering. */
export interface TranscriptViewState {
  meetingId: string;
  connection: ConnectionState;
  chunks: TranscriptChunkPayload[];
  /** Question + optional linked Answer, joined by `questionId`. */
  qaPairs: Array<{
    question: QuestionPayload;
    answer?: AnswerPayload;
  }>;
  ended: boolean;
  endedAtMs?: number;
}
