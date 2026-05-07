// Phase 1 T-1.11 — AnswerPanel: streaming markdown render + Copy button.
// Phase 3 T-3.7 — optional "Speak answer" button (TTS feature flag, default OFF).
//
// Pure presentational component. The driver (`useAskClaude`) owns the
// async-generator and pumps deltas into `text` via `useState`. Keeping render
// state-less lets `T-1.13`'s smoke harness drive the panel directly without a
// live Anthropic stream.
//
// Markdown via `react-markdown` (v10) — XSS-safe by default (no raw HTML
// pass-through), tolerates partial input mid-stream (an open `## ` heading
// that hasn't reached its newline still parses), and renders to native HTML
// elements that map cleanly onto Testing Library's getByRole queries.
//
// Cache-hit + cost surface land in this component (instead of in
// `useAskClaude`) because they're cosmetic — the hook's `result` object is
// already the source of truth.
//
// TTS seam (T-3.7): when the parent passes `onSpeak`, a "Speak answer" button
// appears alongside the Copy button (status = "done" only). When the prop is
// undefined, no button renders — no DOM presence, no event listeners, no
// imported audio code path. The wiring in `App.tsx` gates the prop on the
// `ENABLE_TTS` constant from `src/tts/featureFlag.ts` so the default install
// has zero TTS surface.

import { useCallback, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import type { AnthropicUsage } from "../llm/pricing";

export type AnswerPanelStatus = "idle" | "streaming" | "done" | "error";

export type AnswerPanelSpeakStatus = "idle" | "speaking" | "done" | "error";

export interface AnswerPanelProps {
  status: AnswerPanelStatus;
  text: string;
  error?: Error | null;
  usage?: AnthropicUsage;
  costUsd?: number;
  cacheReadRatio?: number;
  onCopy?: (text: string) => void | Promise<void>;
  /** Phase 3 T-3.7 TTS seam. When defined, renders a "Speak answer" button
   *  while `status === "done"`. When undefined, the button does NOT render
   *  (no DOM presence). The handler should resolve when synthesis kicks off
   *  (NOT when audio finishes playing) so the AC-4 wall-clock budget stays
   *  tight. The component manages local `idle → speaking → done | error`
   *  state internally; the parent doesn't need to track it. */
  onSpeak?: (text: string) => void | Promise<void>;
}

const PLACEHOLDER = "Mark a question to see the answer here.";

// Paranoid filter: scrub any `sk-ant-…` substring out of an error message
// before render. T-1.10's `MissingApiKeyError` already excludes the key from
// `.message`, but a future SDK error path might surface one — this is the
// consumer-side safety net (see T-1.11 task doc AC-6 / AP-S12).
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

async function defaultCopy(text: string): Promise<void> {
  const clip = (navigator as unknown as { clipboard?: { writeText?: (t: string) => Promise<void> } })
    .clipboard;
  if (clip?.writeText) await clip.writeText(text);
}

export function AnswerPanel({
  status,
  text,
  error,
  usage: _usage,
  costUsd,
  cacheReadRatio,
  onCopy,
  onSpeak,
}: AnswerPanelProps): ReactNode {
  const [copied, setCopied] = useState(false);
  const [speakStatus, setSpeakStatus] =
    useState<AnswerPanelSpeakStatus>("idle");
  const speakInFlight = useRef(false);

  const showCopy = status === "done";
  const showSpeak = status === "done" && typeof onSpeak === "function";
  const showCacheBadge =
    typeof cacheReadRatio === "number" && cacheReadRatio > 0.5;
  const showCost = typeof costUsd === "number";

  async function handleCopy() {
    try {
      if (onCopy) await onCopy(text);
      else await defaultCopy(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Swallow copy errors — UI just won't flip to "Copied!".
    }
  }

  // Speak handler — local state machine: idle → speaking → done | error. The
  // ref-based debounce mirrors SettingsSheet's test-connection button (T-3.6):
  // a second click while `speaking` is a no-op so a slow synthesis doesn't
  // stack handlers. Errors flip to a transient `error` state then settle back
  // to `idle` after 2 s so the user can retry without a remount.
  const handleSpeak = useCallback(async () => {
    if (!onSpeak) return;
    if (speakInFlight.current) return;
    speakInFlight.current = true;
    setSpeakStatus("speaking");
    try {
      await onSpeak(text);
      setSpeakStatus("done");
    } catch {
      setSpeakStatus("error");
      window.setTimeout(() => setSpeakStatus("idle"), 2000);
    } finally {
      speakInFlight.current = false;
    }
  }, [onSpeak, text]);

  if (status === "error") {
    const raw = error?.message ?? "Unknown error";
    return (
      <section className="answer-panel" data-testid="answer-panel">
        <div role="alert" className="answer-panel__error">
          {sanitizeErrorMessage(raw)}
        </div>
      </section>
    );
  }

  return (
    <section className="answer-panel" data-testid="answer-panel">
      <header className="answer-panel__header">
        {showCacheBadge && (
          <span
            className="answer-panel__badge"
            data-testid="cache-hit-badge"
          >
            Cache hit {Math.round((cacheReadRatio ?? 0) * 100)}%
          </span>
        )}
        {showCost && (
          <span className="answer-panel__cost" data-testid="cost-readout">
            ${costUsd!.toFixed(4)}
          </span>
        )}
      </header>

      <div
        className="answer-panel__body"
        data-testid="answer-body"
        aria-live="polite"
      >
        {status === "idle" && text.length === 0 ? (
          <p className="answer-panel__placeholder">{PLACEHOLDER}</p>
        ) : (
          <ReactMarkdown>{text}</ReactMarkdown>
        )}
      </div>

      {showCopy && (
        <button
          type="button"
          onClick={handleCopy}
          data-testid="answer-copy"
          className="answer-panel__copy"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      )}

      {showSpeak && (
        <button
          type="button"
          onClick={handleSpeak}
          disabled={speakStatus === "speaking"}
          data-testid="answer-speak"
          data-speak-status={speakStatus}
          aria-live="polite"
          className="answer-panel__speak"
        >
          {speakLabel(speakStatus)}
        </button>
      )}
    </section>
  );
}

function speakLabel(s: AnswerPanelSpeakStatus): string {
  switch (s) {
    case "speaking":
      return "Speaking…";
    case "done":
      return "Speak again";
    case "error":
      return "Speak failed — retry";
    case "idle":
    default:
      return "Speak answer";
  }
}
