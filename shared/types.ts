// Shared TypeScript types for Meeting Copilot.
// Authoritative shapes per docs/ARCHITECTURE.md §3.1 (STT pipeline) and §10 (Data Model).
// Consumers: src/ (React UI), src-tauri/ (event payload contract via serde JSON).

export const SHARED_TYPES_SCHEMA_VERSION = "1.0.0" as const;

export interface TranscriptChunk {
  id: string;
  meetingId: string;
  text: string;
  startTs: number;
  endTs: number;
  isFinal: boolean;
  speaker?: "self" | "other" | string;
  confidence?: number;
}

export type MeetingStatus = "idle" | "active" | "ended";

export interface MeetingSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  sttProvider?: string;
  model?: string;
  privacyMode?: "local-only" | "cloud";
  status: MeetingStatus;
}

export type Meeting = MeetingSession;

export type QuestionMethod = "auto" | "manual";

export interface Question {
  id: string;
  meetingId: string;
  text: string;
  detectedTs: number;
  method: QuestionMethod;
  confidence?: number;
  status?: "open" | "answered" | "dismissed";
}

export interface Answer {
  id: string;
  questionId: string;
  text: string;
  generatedAt: number;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cachedRatio?: number;
}

export interface QAEntry {
  question: Question;
  answer: Answer | null;
}

export interface ContextSource {
  id: string;
  path: string;
  charCount: number;
  estimatedTokens: number;
  loadedAt: number;
}
