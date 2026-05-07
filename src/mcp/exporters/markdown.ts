// Phase 4 T-4.7 — Markdown exporter.
//
// Operator-facing surface: a human-readable summary of the meeting with
// privacy mode + cost meter in the header (per ARCH §11 + §15 cross-link),
// the context source path (if any), Q/A blocks, and transcript chunks
// timestamp-prefixed relative to `meeting.startedAt`.
//
// Pricing constants intentionally re-stated here (not imported from
// `src/llm/pricing.ts`) so the exporter is standalone — see T-4.7 §6 risk
// "Cost meter drift". Operator-facing surface, not billing.

import { formatTimestamp } from "./timestamp";
import type {
  ExporterAnswerRow,
  ExporterMeetingSnapshot,
  ExporterQuestionRow,
  RenderedExport,
} from "./types";

// Sonnet 4.6 pricing (USD per 1M tokens). Pulled from Anthropic's published
// pricing as of v1.0 release.
//   - input  (no cache):  $3.00 / 1M
//   - input  (cache hit): $0.30 / 1M
//   - output           : $15.00 / 1M
const SONNET_4_6_USD_PRICING = {
  inputPerMillion: 3,
  cachedInputPerMillion: 0.3,
  outputPerMillion: 15,
} as const;

function computeCostUsd(answer: ExporterAnswerRow | undefined): {
  usd: number;
  hasAnswer: boolean;
} {
  if (!answer) return { usd: 0, hasAnswer: false };
  const cachedRatio = answer.cachedRatio ?? 0;
  const tokensIn = answer.tokensIn ?? 0;
  const tokensOut = answer.tokensOut ?? 0;
  const inputUncached = tokensIn * (1 - cachedRatio);
  const inputCached = tokensIn * cachedRatio;
  const usd =
    (inputUncached * SONNET_4_6_USD_PRICING.inputPerMillion) / 1_000_000 +
    (inputCached * SONNET_4_6_USD_PRICING.cachedInputPerMillion) / 1_000_000 +
    (tokensOut * SONNET_4_6_USD_PRICING.outputPerMillion) / 1_000_000;
  return { usd, hasAnswer: true };
}

function formatUsd(usd: number): string {
  // Two-decimal precision keeps the header readable; fractional cent precision
  // would change every run on the same snapshot due to rounding.
  return `$${usd.toFixed(2)}`;
}

function formatDateTime(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  // ISO-8601 in UTC. Operator-facing; locale-agnostic.
  return new Date(ms).toISOString();
}

function findAnswerForQuestion(
  question: ExporterQuestionRow,
  answer: ExporterAnswerRow | undefined,
): ExporterAnswerRow | undefined {
  if (!answer) return undefined;
  return answer.questionId === question.id ? answer : undefined;
}

export function renderMarkdown(
  snapshot: ExporterMeetingSnapshot,
): RenderedExport {
  const { meeting, chunks, questions, answer, contextSource } = snapshot;
  const cost = computeCostUsd(answer);
  const sortedChunks = [...chunks].sort((a, b) => {
    if (a.startTs !== b.startTs) return a.startTs - b.startTs;
    return a.id.localeCompare(b.id);
  });
  const sortedQuestions = [...questions].sort(
    (a, b) => a.detectedTs - b.detectedTs,
  );

  const sections: string[] = [];

  // -- Header
  sections.push(`# ${meeting.title || meeting.id}`);
  sections.push("");
  sections.push(`> Privacy mode: ${meeting.privacyMode ?? "unknown"}`);
  const costLine = cost.hasAnswer
    ? `> Cost: ${formatUsd(cost.usd)}`
    : `> Cost: $0.00 (no Q&A)`;
  sections.push(costLine);
  sections.push(`> Started: ${formatDateTime(meeting.startedAt)}`);
  if (meeting.endedAt != null) {
    sections.push(`> Ended: ${formatDateTime(meeting.endedAt)}`);
  }
  if (meeting.sttProvider) {
    sections.push(`> STT: ${meeting.sttProvider}`);
  }
  if (meeting.model) {
    sections.push(`> Model: ${meeting.model}`);
  }
  sections.push("");

  // -- Context source
  if (contextSource) {
    sections.push("## Context");
    sections.push("");
    sections.push(`- Path: \`${contextSource.path}\``);
    sections.push(
      `- Size: ${contextSource.charCount} chars / ~${contextSource.estimatedTokens} tokens`,
    );
    sections.push("");
  }

  // -- Q/A
  if (sortedQuestions.length > 0) {
    sections.push("## Questions & Answers");
    sections.push("");
    for (const q of sortedQuestions) {
      const a = findAnswerForQuestion(q, answer);
      sections.push(`### Q: ${q.text}`);
      sections.push("");
      sections.push(
        `_Detected at ${formatTimestamp(q.detectedTs - meeting.startedAt)} (${q.method})_`,
      );
      sections.push("");
      if (a) {
        sections.push(`**Answer** _(model: ${a.model})_`);
        sections.push("");
        sections.push(a.text);
      } else {
        sections.push("_(no answer recorded)_");
      }
      sections.push("");
    }
  }

  // -- Transcript
  sections.push("## Transcript");
  sections.push("");
  if (sortedChunks.length === 0) {
    sections.push("_(no transcript chunks)_");
    sections.push("");
  } else {
    for (const chunk of sortedChunks) {
      const ts = formatTimestamp(chunk.startTs - meeting.startedAt);
      const speaker = chunk.speaker ? `**${chunk.speaker}**: ` : "";
      sections.push(`- [${ts}] ${speaker}${chunk.text}`);
    }
    sections.push("");
  }

  return {
    ext: "md",
    mime: "text/markdown",
    body: sections.join("\n"),
  };
}
