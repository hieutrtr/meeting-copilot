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

// Phase 2 T-2.2 — Sliding-window utterance assembled from one or more
// `TranscriptChunk` events. The detector pipeline (T-2.1 heuristic → T-2.3
// Haiku filter) classifies whole utterances, not raw chunks.
export interface Utterance {
  text: string;
  startTs: number;
  endTs: number;
  chunkIds: string[];
}

// Phase 4 T-4.2 — MCP tool surface re-export. The Zod-derived inferred types
// live in `src/mcp/tools.ts`; we re-export the TS shapes here so cross-crate
// consumers (Rust serde via shared/types.ts mirror, future dashboard embed)
// can `import { McpStartInput, ... } from "@shared/types"`.
export type {
  ErrorCode as McpErrorCode,
  ToolName as McpToolName,
  ToolResult as McpToolResult,
  InstallInput as McpInstallInput,
  InstallOutput as McpInstallOutput,
  StartInput as McpStartInput,
  StartOutput as McpStartOutput,
  StatusInput as McpStatusInput,
  StatusOutput as McpStatusOutput,
  StopInput as McpStopInput,
  StopOutput as McpStopOutput,
  ExportInput as McpExportInput,
  ExportOutput as McpExportOutput,
} from "../src/mcp/tools";
