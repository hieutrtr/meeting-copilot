// Phase 1 T-1.9 — manual-marked question store.
//
// `markFromChunks` is the demo's single mark surface (per loop INDEX): grab the
// last N transcript chunks, join them with a single space, and push a Question
// onto the front of the list. T-1.10's Claude client reads `questions[0]` to
// build the next streaming Q/A turn.
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

export interface QuestionState {
  questions: Question[];
  markFromChunks: (
    chunks: TranscriptChunk[],
    opts?: MarkOptions,
  ) => Question | null;
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
  clear: () => set({ questions: [] }),
}));
