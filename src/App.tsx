import { useEffect, useMemo } from "react";

import "./App.css";

import { AnswerPanel } from "./components/AnswerPanel";
import { ContextLoader } from "./components/ContextLoader";
import { MeetingControls } from "./components/MeetingControls";
import { PastMeetings } from "./components/PastMeetings";
import { TranscriptView } from "./components/TranscriptView";
import { useTranscriptStream } from "./hooks/useTranscriptStream";
import { useAskClaude } from "./hooks/useAskClaude";
import { useMeetingPersist } from "./hooks/useMeetingPersist";
import { useContextStore } from "./store/contextStore";
import { useQuestionStore } from "./store/questionStore";

const RECENT_TRANSCRIPT_CHUNK_COUNT = 12;

export default function App() {
  const { chunks } = useTranscriptStream();
  const contextContent = useContextStore((s) => s.content);
  const latestQuestion = useQuestionStore((s) => s.questions[0] ?? null);
  const { status, text, error, usage, costUsd, cacheReadRatio, ask } = useAskClaude();

  const recentTranscript = useMemo(
    () =>
      chunks
        .slice(-RECENT_TRANSCRIPT_CHUNK_COUNT)
        .map((c) => c.text)
        .join(" "),
    [chunks],
  );

  // T-1.13 — Stop→persist + hydrate-on-open.
  // The hook reads `useMeetingStore.status` internally and fires once when it
  // flips to "ended". `answer` is the last streamed Claude output (if any).
  useMeetingPersist({
    chunks,
    answer:
      status === "done" || status === "streaming"
        ? {
            text,
            tokensIn: usage?.input_tokens,
            tokensOut: usage?.output_tokens,
            cachedRatio: cacheReadRatio,
          }
        : null,
  });

  // When a fresh question lands, kick off a Claude stream. The hook owns
  // cancellation: a second `ask()` cancels the prior in-flight generator.
  useEffect(() => {
    if (!latestQuestion) return;
    if (!contextContent) return;
    ask({
      question: latestQuestion.text,
      contextDoc: contextContent,
      recentTranscript,
    });
    // We deliberately key the effect on the question ID only — `recentTranscript`
    // changes each chunk, but we want to fire once per marked question. The
    // transcript-snapshot in scope at fire time is the right one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestQuestion?.id, contextContent]);

  return (
    <main className="container">
      <h1>Meeting Copilot</h1>
      <p className="subtitle">Phase 1 — load context, start meeting, mark questions.</p>

      <ContextLoader />
      <MeetingControls chunks={chunks} />
      <TranscriptView chunks={chunks} />
      <AnswerPanel
        status={status}
        text={text}
        error={error}
        usage={usage}
        costUsd={costUsd}
        cacheReadRatio={cacheReadRatio}
      />
      <PastMeetings />
    </main>
  );
}
