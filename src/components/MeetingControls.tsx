// Phase 1 T-1.9 — meeting controls bar (Start / Stop / Mark question).
//
// Render-only; the meeting + question stores are the single source of truth.
// `chunks` is passed in by the parent (T-1.13 wires it to `useTranscriptStream`)
// so the component stays unit-testable without any Tauri event mocks.
//
// The Start button is disabled until a context source is loaded — matches the
// demo path: load PRD → Start → speak → Mark → Stop. PHASE-BROWSER-TEST.md
// step 2 calls this out explicitly.

import type { TranscriptChunk } from "../../shared/types";
import { useContextStore } from "../store/contextStore";
import { useMeetingStore } from "../store/meetingStore";
import { useQuestionStore } from "../store/questionStore";

const MARK_LAST_N = 3;

export interface MeetingControlsProps {
  chunks: TranscriptChunk[];
}

export function MeetingControls({ chunks }: MeetingControlsProps) {
  const status = useMeetingStore((s) => s.status);
  const start = useMeetingStore((s) => s.start);
  const stop = useMeetingStore((s) => s.stop);
  const reset = useMeetingStore((s) => s.reset);
  const contextSource = useContextStore((s) => s.source);
  const markFromChunks = useQuestionStore((s) => s.markFromChunks);

  const canStart = status === "idle" && contextSource !== null;

  function handleStart() {
    start();
  }

  function handleStop() {
    stop();
  }

  function handleMark() {
    markFromChunks(chunks, { lastN: MARK_LAST_N });
  }

  function handleRestart() {
    reset();
    start();
  }

  return (
    <section className="meeting-controls" aria-label="Meeting controls">
      <span className="meeting-controls__status" data-testid="meeting-status">
        {status}
      </span>

      {(status === "idle") && (
        <button
          type="button"
          onClick={handleStart}
          disabled={!canStart}
          data-testid="meeting-start-button"
        >
          Start meeting
        </button>
      )}

      {status === "active" && (
        <>
          <button
            type="button"
            onClick={handleMark}
            data-testid="meeting-mark-button"
          >
            Mark question
          </button>
          <button
            type="button"
            onClick={handleStop}
            data-testid="meeting-stop-button"
          >
            Stop meeting
          </button>
        </>
      )}

      {status === "ended" && (
        <button
          type="button"
          onClick={handleRestart}
          data-testid="meeting-restart-button"
        >
          Start new meeting
        </button>
      )}
    </section>
  );
}
