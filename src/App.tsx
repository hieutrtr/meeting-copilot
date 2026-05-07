import { useCallback, useEffect, useMemo, useRef } from "react";

import "./App.css";

import { AnswerPanel } from "./components/AnswerPanel";
import { CloudConsentBanner } from "./components/CloudConsentBanner";
import { ContextLoader } from "./components/ContextLoader";
import { MeetingControls } from "./components/MeetingControls";
import { PastMeetings } from "./components/PastMeetings";
import { SettingsSheet } from "./components/SettingsSheet";
import {
  SetupWizard,
  type SetupWizardInvokers,
} from "./components/SetupWizard/SetupWizard";
import type { BlackHoleStatus } from "./components/SetupWizard/useSetupWizard";
import { TranscriptView } from "./components/TranscriptView";
import { useTranscriptStream } from "./hooks/useTranscriptStream";
import { useAskClaude } from "./hooks/useAskClaude";
import { useMeetingPersist } from "./hooks/useMeetingPersist";
import {
  setupConfigureMultiOutput,
  setupDetectBlackhole,
  setupInstallBlackhole,
  setupVerifyCapture,
} from "./lib/setupCommands";
import { isTtsAllowed } from "./privacy/privacyMode";
import { useContextStore } from "./store/contextStore";
import { useQuestionStore } from "./store/questionStore";
import { useSettingsStore } from "./store/settingsStore";
import { ENABLE_TTS } from "./tts/featureFlag";

const RECENT_TRANSCRIPT_CHUNK_COUNT = 12;

// T-W.5 verify FFI default duration. Mirrors the wizard's Verify-step copy
// ("Play 5 s of audio") and the helper-daemon's RealAudioInputProbe 5_000 ms
// window from `crates/audio-capture/src/verify.rs`.
const SETUP_VERIFY_DURATION_MS = 5_000;
// Device-hint string handed to the verify Tauri command. The Rust side
// resolves this against cpal's enumerate_devices output (case-insensitive
// substring match) — `"blackhole"` matches "BlackHole 2ch" / "BlackHole 16ch".
const SETUP_VERIFY_DEVICE_HINT = "blackhole";

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
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const setSetupCompleted = useSettingsStore((s) => s.setSetupCompleted);

  // The setup wizard's `Configure` step has no dedicated UID picker, so the
  // App holds the most-recent detect status here and forwards the BlackHole
  // UID into `setup_configure_multi_output`. Rendering reads do not depend
  // on this, so a ref (rather than state) is correct.
  const detectStatusRef = useRef<BlackHoleStatus | null>(null);

  const wizardInvokers = useMemo<SetupWizardInvokers>(
    () => ({
      detect: async () => {
        const status = await setupDetectBlackhole();
        detectStatusRef.current = status;
        return status;
      },
      // brew streaming is not surfaced via Tauri events yet (Phase-W follow-up
      // — `helper_daemon::install_via_brew` blocks until the cask completes),
      // so the onLine callback is intentionally unused. The wizard still
      // renders an empty log <pre> + the InstallReport on completion.
      install: async (_onLine) => setupInstallBlackhole(),
      configure: async () => {
        const last = detectStatusRef.current;
        const blackholeUid =
          last &&
          (last.kind === "installed_not_configured" ||
            last.kind === "configured")
            ? last.blackhole_uid
            : "";
        const subDeviceUids = blackholeUid ? [blackholeUid] : [];
        const result = await setupConfigureMultiOutput(subDeviceUids);
        return { deviceId: result.device_id };
      },
      verify: async (_deviceId) =>
        setupVerifyCapture(SETUP_VERIFY_DEVICE_HINT, SETUP_VERIFY_DURATION_MS),
    }),
    [],
  );

  const onWizardDone = useCallback(() => {
    setSetupCompleted(true);
  }, [setSetupCompleted]);

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

  // T-W.7 — gate the meeting UI behind the BlackHole Setup Wizard. On a
  // fresh install (or any persisted settings payload missing the
  // `setupCompleted` key — see `coerceLoaded` in `settingsStore.ts`), the
  // wizard renders as a modal overlay before the meeting UI. The Done step
  // calls `onWizardDone` which flips `setupCompleted=true`; the next render
  // unmounts the wizard and the meeting UI takes over. Users can re-run the
  // wizard from the Settings panel by toggling the flag back to `false`.
  if (!setupCompleted) {
    return <SetupWizard invokers={wizardInvokers} onDone={onWizardDone} />;
  }

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
