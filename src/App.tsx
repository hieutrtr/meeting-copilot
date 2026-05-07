import { useEffect, useMemo } from "react";

import "./App.css";

import { AnswerPanel } from "./components/AnswerPanel";
import { CloudConsentBanner } from "./components/CloudConsentBanner";
import { ContextLoader } from "./components/ContextLoader";
import { MeetingControls } from "./components/MeetingControls";
import { PastMeetings } from "./components/PastMeetings";
import { SettingsSheet } from "./components/SettingsSheet";
import { TranscriptView } from "./components/TranscriptView";
import { useTranscriptStream } from "./hooks/useTranscriptStream";
import { useAskClaude } from "./hooks/useAskClaude";
import { useMeetingPersist } from "./hooks/useMeetingPersist";
import { isTtsAllowed } from "./privacy/privacyMode";
import { useContextStore } from "./store/contextStore";
import { useQuestionStore } from "./store/questionStore";
import { useSettingsStore } from "./store/settingsStore";
import { ENABLE_TTS } from "./tts/featureFlag";

const RECENT_TRANSCRIPT_CHUNK_COUNT = 12;

// Phase 3 T-3.7 — TTS Speak handler. Default-OFF: ENABLE_TTS reads
// `import.meta.env.VITE_ENABLE_TTS` and is `false` for every default Vite
// build. The handler is dynamically imported on first click so the TTS code
// path is dead-stripped from the initial bundle when the flag is disabled.
// Live audio playback (Web Audio context, BlackHole virtual-output routing)
// is deferred to Phase 3.x — this stub resolves immediately so the AnswerPanel
// state machine settles back to "done" after click. The underlying
// `ElevenLabsTts` adapter is the live wire-up seam.
async function speakAnswer(text: string): Promise<void> {
  // The dynamic import keeps `elevenLabsTts.ts` out of the default chunk
  // when ENABLE_TTS is false; with ENABLE_TTS true, Vite still code-splits.
  const mod = await import("./tts/elevenLabsTts");
  // Read settings store lazily here to avoid a top-level import cycle with
  // the AnswerPanel's wiring tests (which don't construct a real store).
  const { useSettingsStore } = await import("./store/settingsStore");
  const apiKey = useSettingsStore.getState().apiKeys.elevenlabs;
  if (!apiKey) {
    throw new Error(mod.ELEVENLABS_TTS_API_KEY_MISSING_MESSAGE);
  }
  const tts = new mod.ElevenLabsTts({ apiKey });
  // Drain the iterable. Audio playback (the actual `<audio>` / Web Audio
  // wiring) is the deferred Phase 3.x seam — this loop just exercises the
  // synthesis round-trip so the button settles back to "done" once the
  // first chunk lands.
  for await (const _chunk of tts.speak(text, { voice: "" })) {
    // Discard until live audio routing lands.
    void _chunk;
    break;
  }
}

export default function App() {
  const { chunks } = useTranscriptStream();
  const contextContent = useContextStore((s) => s.content);
  const latestQuestion = useQuestionStore((s) => s.questions[0] ?? null);
  const privacyMode = useSettingsStore((s) => s.privacyMode);
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
      {privacyMode === "cloud" ? <CloudConsentBanner /> : null}
      <TranscriptView chunks={chunks} />
      <AnswerPanel
        status={status}
        text={text}
        error={error}
        usage={usage}
        costUsd={costUsd}
        cacheReadRatio={cacheReadRatio}
        onSpeak={
          ENABLE_TTS && isTtsAllowed(privacyMode) ? speakAnswer : undefined
        }
      />
      <PastMeetings />
      <details className="settings-sheet__details">
        <summary>Settings</summary>
        <SettingsSheet />
      </details>
    </main>
  );
}
