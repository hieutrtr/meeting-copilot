// Phase 1 T-1.13 — Stop→persist + hydrate-on-mount glue hook.
//
// Single consumer (`<App />`). Owns two side effects:
//   1. On mount, call `loadMeetings()` once → seed `useHistoryStore`.
//   2. On `useMeetingStore.status` flipping to `"ended"`, gather the in-flight
//      meeting state (chunks, questions, latest answer, context) and call
//      `saveMeetingSnapshot()` exactly once per meetingId.
//
// The "exactly once per meetingId" guard handles a parent re-render that
// happens to fire while status is still `"ended"` — without it, every render
// would re-issue the save.

import { useEffect, useRef } from "react";

import type {
  Answer,
  ContextSource,
  MeetingSession,
  Question,
  TranscriptChunk,
} from "../../shared/types";
import { useContextStore } from "../store/contextStore";
import { useHistoryStore } from "../store/historyStore";
import { useMeetingStore } from "../store/meetingStore";
import { useQuestionStore } from "../store/questionStore";
import {
  loadMeetings,
  saveMeetingSnapshot,
  type MeetingSnapshot,
} from "../persist/persistClient";

export interface UseMeetingPersistArgs {
  chunks: TranscriptChunk[];
  /** Latest streamed answer text. `null` while streaming or before the first
   *  Mark-question. The hook persists whatever's currently in `text` when Stop
   *  fires — Phase 1 deliberate: "your data is saved at the moment you press
   *  Stop". Phase 1.x can add a "wait for streaming to finish" UX gate. */
  answer: {
    text: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    cachedRatio?: number;
  } | null;
}

const DEFAULT_TITLE = "Untitled meeting";

function buildAnswerRow(
  questionId: string,
  ans: NonNullable<UseMeetingPersistArgs["answer"]>,
  now: number,
): Answer {
  return {
    id: `a-${questionId}`,
    questionId,
    text: ans.text,
    generatedAt: now,
    model: ans.model ?? "claude-sonnet-4-6",
    tokensIn: ans.tokensIn,
    tokensOut: ans.tokensOut,
    cachedRatio: ans.cachedRatio,
  };
}

function buildContextRow(
  source: { id: string; path: string; charCount: number; estimatedTokens: number; loadedAt: number } | null,
): ContextSource | undefined {
  if (!source) return undefined;
  return {
    id: source.id,
    path: source.path,
    charCount: source.charCount,
    estimatedTokens: source.estimatedTokens,
    loadedAt: source.loadedAt,
  };
}

function buildSnapshot(
  meetingState: {
    meetingId: string | null;
    startedAt: number | null;
    endedAt: number | null;
  },
  chunks: TranscriptChunk[],
  questions: Question[],
  answer: UseMeetingPersistArgs["answer"],
  contextSource: ReturnType<typeof useContextStore.getState>["source"],
  now: number,
): MeetingSnapshot | null {
  if (!meetingState.meetingId || meetingState.startedAt === null) return null;
  const meeting: MeetingSession = {
    id: meetingState.meetingId,
    title: DEFAULT_TITLE,
    startedAt: meetingState.startedAt,
    endedAt: meetingState.endedAt ?? now,
    status: "ended",
  };
  // Question text is preserved as-is; the answer (if any) is bound to the
  // newest question — matches the demo flow where the user marks one question
  // and waits for one answer.
  const newestQuestion = questions[0];
  const answerRow =
    answer && newestQuestion ? buildAnswerRow(newestQuestion.id, answer, now) : undefined;

  return {
    meeting,
    chunks,
    questions,
    answer: answerRow,
    contextSource: buildContextRow(contextSource),
  };
}

export interface UseMeetingPersistResult {
  /** Mostly visible for tests — exposes a tick that increments once a save
   *  has resolved (so an E2E test can `waitFor(saveCount > 0)`). */
  saveCount: number;
}

export function useMeetingPersist(args: UseMeetingPersistArgs): UseMeetingPersistResult {
  // Subscribe ONLY to `status` — zustand v5 fires a separate React update for
  // every selector subscription, so subscribing to status + meetingId +
  // startedAt + endedAt would re-fire the effect 3-4 times per `start()`/
  // `stop()` call. Reading the other fields via `getState()` inside the
  // effect keeps the effect-fire count = 1 per status transition.
  const status = useMeetingStore((s) => s.status);
  const setPastMeetings = useHistoryStore((s) => s.setPastMeetings);
  const lastSavedIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  // saveCount lives in a ref + state pair so consumers can re-render but the
  // increment itself doesn't loop the effect.
  const saveCountRef = useRef(0);

  // Hydrate-on-mount.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    loadMeetings()
      .then((rows) => {
        setPastMeetings(rows);
      })
      .catch((err) => {
        // Soft-fail — fresh installs hit this path until the first save.
        // Surface for telemetry but don't block the UI.
        // eslint-disable-next-line no-console
        console.warn("loadMeetings failed:", err);
        setPastMeetings([]);
      });
  }, [setPastMeetings]);

  // Stop→persist.
  useEffect(() => {
    if (status !== "ended") return;
    const meeting = useMeetingStore.getState();
    if (!meeting.meetingId) return;
    if (lastSavedIdRef.current === meeting.meetingId) return;
    lastSavedIdRef.current = meeting.meetingId;

    const now = Date.now();
    const questions = useQuestionStore.getState().questions;
    const contextSource = useContextStore.getState().source;
    const snap = buildSnapshot(
      {
        meetingId: meeting.meetingId,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
      },
      args.chunks,
      questions,
      args.answer,
      contextSource,
      now,
    );
    if (!snap) return;

    saveMeetingSnapshot(snap)
      .then(() => {
        saveCountRef.current += 1;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("saveMeetingSnapshot failed:", err);
      });
    // Args (chunks/answer) are read at fire time; deliberate to keep the effect
    // gated on the status flip, not on every chunk arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return { saveCount: saveCountRef.current };
}
