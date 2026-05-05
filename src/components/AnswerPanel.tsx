// Phase 1 T-1.11 — AnswerPanel: streaming markdown render + Copy button.
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

import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import type { AnthropicUsage } from "../llm/pricing";

export type AnswerPanelStatus = "idle" | "streaming" | "done" | "error";

export interface AnswerPanelProps {
  status: AnswerPanelStatus;
  text: string;
  error?: Error | null;
  usage?: AnthropicUsage;
  costUsd?: number;
  cacheReadRatio?: number;
  onCopy?: (text: string) => void | Promise<void>;
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
}: AnswerPanelProps): ReactNode {
  const [copied, setCopied] = useState(false);

  const showCopy = status === "done";
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
    </section>
  );
}
