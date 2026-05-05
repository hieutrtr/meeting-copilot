// Phase 1 T-1.9 — manual-marked question store.
// Phase 2 T-2.6 — `markAuto` companion for the queue worker (`method: "auto"`).
//
// `markFromChunks` is the manual surface (US-12): grab the last N transcript
// chunks, join them with a single space, prepend a Question with
// `method: "manual"`. `markAuto` is the auto-detector surface (US-04): the
// worker (T-2.6) calls it with the assembled utterance text + the Haiku
// verdict's confidence score. Both flows prepend onto `questions[0]` so the
// existing T-1.10 Q/A render pipeline picks the newest one verbatim.
//
// Newest-first ordering matches PRD §7.2 sidebar wireframe. Persistence wiring
// lands in T-1.12; this slice is in-memory only for MVP.

import { create } from "zustand";

import type { Question, QuestionMethod, TranscriptChunk } from "../../shared/types";
import { useMeetingStore } from "./meetingStore";

export interface MarkOptions {
  lastN?: number;
  meetingId?: string;
  now?: number;
  method?: QuestionMethod;
  id?: string;
}

export interface MarkAutoOptions {
  meetingId?: string;
  detectedTs?: number;
  confidence?: number;
  id?: string;
}

export interface QuestionState {
  questions: Question[];
  markFromChunks: (
    chunks: TranscriptChunk[],
    opts?: MarkOptions,
  ) => Question | null;
  markAuto: (text: string, opts?: MarkAutoOptions) => Question | null;
  clear: () => void;
}

const DEFAULT_LAST_N = 3;

function generateQuestionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `q-${c.randomUUID()}`;
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useQuestionStore = create<QuestionState>((set) => ({
  questions: [],
  markFromChunks: (chunks, opts) => {
    if (!chunks.length) return null;

    const lastN = Math.max(1, opts?.lastN ?? DEFAULT_LAST_N);
    const tail = chunks.slice(-lastN);
    const text = tail.map((c) => c.text).join(" ");
    // detectedTs anchors on the latest chunk's endTs so persistence ordering by
    // detectedTs lines up with the source transcript timeline.
    const detectedTs = tail[tail.length - 1]!.endTs;

    const meetingIdFromStore = useMeetingStore.getState().meetingId;
    const meetingId = opts?.meetingId ?? meetingIdFromStore ?? "unknown";

    const question: Question = {
      id: opts?.id ?? generateQuestionId(),
      meetingId,
      text,
      detectedTs,
      method: opts?.method ?? "manual",
      status: "open",
    };

    set((s) => ({ questions: [question, ...s.questions] }));
    return question;
  },
  markAuto: (text, opts) => {
    if (!text || text.length === 0) return null;

    const meetingIdFromStore = useMeetingStore.getState().meetingId;
    const meetingId = opts?.meetingId ?? meetingIdFromStore ?? "unknown";
    // Auto path stamps detectedTs at utterance.endTs (caller's responsibility);
    // when omitted we fall back to "now" so the chip still has a sortable time.
    const detectedTs = opts?.detectedTs ?? Date.now();

    const question: Question = {
      id: opts?.id ?? generateQuestionId(),
      meetingId,
      text,
      detectedTs,
      method: "auto",
      status: "open",
    };
    if (typeof opts?.confidence === "number") {
      question.confidence = opts.confidence;
    }

    set((s) => ({ questions: [question, ...s.questions] }));
    return question;
  },
  clear: () => set({ questions: [] }),
}));
