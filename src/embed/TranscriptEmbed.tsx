// Phase 4 T-4.9 — Read-only React component rendered inside the
// claude-bridge dashboard iframe. Subscribes to the helper-daemon's SSE
// embed route and renders transcript chunks + Q/A pairs as they arrive.
//
// Pure-DOM only — no Tauri APIs, no Zustand stores, no IPC. The component
// must work inside the dashboard's WebView2/Chromium process which has no
// access to the Tauri runtime.

import { useEffect, useReducer, useRef } from "react";

import type {
  AnswerPayload,
  ConnectionState,
  EmbedEvent,
  MeetingEndedPayload,
  QuestionPayload,
  TranscriptChunkPayload,
  TranscriptViewState,
} from "./types";

// --- Reducer --------------------------------------------------------------

type Action =
  | { type: "connection"; state: ConnectionState }
  | { type: "event"; event: EmbedEvent };

function initialState(meetingId: string): TranscriptViewState {
  return {
    meetingId,
    connection: "connecting",
    chunks: [],
    qaPairs: [],
    ended: false,
  };
}

export function reduce(state: TranscriptViewState, action: Action): TranscriptViewState {
  if (action.type === "connection") {
    return { ...state, connection: action.state };
  }
  // action.type === "event"
  const evt = action.event;
  switch (evt.kind) {
    case "transcriptChunk":
      return appendChunk(state, evt.payload);
    case "question":
      return appendQuestion(state, evt.payload);
    case "answer":
      return attachAnswer(state, evt.payload);
    case "meetingEnded":
      return markEnded(state, evt.payload);
  }
}

function appendChunk(
  state: TranscriptViewState,
  chunk: TranscriptChunkPayload,
): TranscriptViewState {
  // De-dupe by chunkId — broadcast lag may surface a redelivered frame.
  if (state.chunks.some((c) => c.chunkId === chunk.chunkId)) return state;
  return { ...state, chunks: [...state.chunks, chunk] };
}

function appendQuestion(
  state: TranscriptViewState,
  question: QuestionPayload,
): TranscriptViewState {
  if (state.qaPairs.some((p) => p.question.questionId === question.questionId)) return state;
  return { ...state, qaPairs: [...state.qaPairs, { question }] };
}

function attachAnswer(
  state: TranscriptViewState,
  answer: AnswerPayload,
): TranscriptViewState {
  let matched = false;
  const qaPairs = state.qaPairs.map((pair) => {
    if (pair.question.questionId !== answer.questionId) return pair;
    matched = true;
    return { ...pair, answer };
  });
  if (!matched) return state;
  return { ...state, qaPairs };
}

function markEnded(
  state: TranscriptViewState,
  payload: MeetingEndedPayload,
): TranscriptViewState {
  return { ...state, ended: true, endedAtMs: payload.endedAtMs };
}

// --- Helpers --------------------------------------------------------------

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00.000";
  const totalMs = Math.floor(ms);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.` +
    `${String(millis).padStart(3, "0")}`
  );
}

function eventSourceUrl(meetingId: string, token: string): string {
  // The dashboard's outer page hosts the iframe; the iframe doc + SSE both
  // live on `127.0.0.1:7411`. Token is in the query string per T-4.9 §3.2.
  const params = new URLSearchParams({ token });
  return `/embed/transcript/${encodeURIComponent(meetingId)}/events?${params.toString()}`;
}

// --- Component ------------------------------------------------------------

export interface TranscriptEmbedProps {
  meetingId: string;
  token: string;
  /** Override the EventSource constructor for tests. The mock in
   *  `TranscriptEmbed.test.tsx` substitutes a hand-rolled class that
   *  implements just the surface this component touches. */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

/** Minimal subset of the DOM `EventSource` we touch. */
export interface EventSourceLike {
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onmessage: ((this: EventSourceLike, ev: MessageEvent<string>) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  close(): void;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

export function TranscriptEmbed({
  meetingId,
  token,
  eventSourceFactory,
}: TranscriptEmbedProps): JSX.Element {
  const [state, dispatch] = useReducer(reduce, meetingId, initialState);
  const sourceRef = useRef<EventSourceLike | null>(null);

  useEffect(() => {
    const factory = eventSourceFactory ?? defaultFactory;
    const url = eventSourceUrl(meetingId, token);
    const source = factory(url);
    sourceRef.current = source;

    source.onopen = () => dispatch({ type: "connection", state: "open" });
    source.onerror = () => dispatch({ type: "connection", state: "error" });
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as EmbedEvent;
        if (parsed && typeof parsed === "object" && "kind" in parsed) {
          dispatch({ type: "event", event: parsed });
        }
      } catch {
        // Malformed frame — ignore. We don't want a single bad payload to
        // tear down the iframe; the daemon's SSE adapter already
        // serializes through `serde_json` so this should not normally
        // happen, but defence in depth.
      }
    };

    return () => {
      source.close();
      dispatch({ type: "connection", state: "closed" });
      sourceRef.current = null;
    };
  }, [meetingId, token, eventSourceFactory]);

  return (
    <div className="transcript-embed" data-meeting-id={meetingId}>
      <header className="transcript-embed__header">
        <span className="transcript-embed__title">Meeting {meetingId}</span>
        <span
          className={`transcript-embed__status transcript-embed__status--${state.connection}`}
          data-testid="connection-status"
        >
          {state.connection}
        </span>
      </header>

      <ol className="transcript-embed__chunks" data-testid="chunks">
        {state.chunks.map((chunk) => (
          <li key={chunk.chunkId} className="transcript-embed__chunk">
            <time>{formatTimestamp(chunk.startedAtMs)}</time>
            <strong>{chunk.speaker}</strong>
            <span>{chunk.text}</span>
          </li>
        ))}
      </ol>

      <section className="transcript-embed__qa" data-testid="qa-pairs">
        {state.qaPairs.map((pair) => (
          <article key={pair.question.questionId} className="transcript-embed__qa-pair">
            <h3 className="transcript-embed__question">{pair.question.text}</h3>
            <p className="transcript-embed__answer">
              {pair.answer ? pair.answer.text : "(no answer yet)"}
            </p>
          </article>
        ))}
      </section>

      <footer className="transcript-embed__footer" data-testid="footer">
        {state.ended ? "Ended" : "Live"}
      </footer>
    </div>
  );
}

// Re-export the URL helper so tests can assert the encoding shape directly.
export { eventSourceUrl, formatTimestamp, initialState };
