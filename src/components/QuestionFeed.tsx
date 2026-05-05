// Phase 2 T-2.8 — QuestionFeed: auto-detected question list + click-to-scroll.
//
// Pure presentational component. Consumes `useQuestionStore.questions` (T-1.9 +
// T-2.6 `markAuto`) verbatim — no internal data fetching. The chip click
// triggers a `scrollIntoView` on a caller-supplied `answerRef` and a 1.5 s
// flash class on the same element; that is the only side-effect this component
// owns.
//
// Single-card AnswerPanel is the contract (per ARCH §3 single-flight). So the
// "answer the chip points at" is always the lone AnswerPanel, regardless of
// which chip was clicked. Multi-card history is a Phase-3 concern.
//
// jsdom note: `Element.prototype.scrollIntoView` is a no-op under jsdom. The
// test suite spies on the prototype method to verify call shape; the real
// scroll happens on a live host (PHASE-BROWSER-TEST.md).

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import type { Question } from "../../shared/types";

const DEFAULT_FLASH_CLASS = "answer-flash" as const;
const DEFAULT_FLASH_DURATION_MS = 1500;
const DEFAULT_SCROLL_OPTIONS: ScrollIntoViewOptions = {
  behavior: "smooth",
  block: "start",
};
const CHIP_TEXT_MAX_CHARS = 80;
const CONFIDENCE_HIGH = 0.8;
const CONFIDENCE_MID = 0.6;

export interface QuestionFeedProps {
  questions: Question[];
  answerRef?: RefObject<HTMLElement | null>;
  selectedId?: string;
  onSelect?: (id: string) => void;
  flashClass?: string;
  flashDurationMs?: number;
  scrollOptions?: ScrollIntoViewOptions;
}

function classifyConfidence(c: number): "high" | "mid" | "low" {
  if (c >= CONFIDENCE_HIGH) return "high";
  if (c >= CONFIDENCE_MID) return "mid";
  return "low";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

export function QuestionFeed({
  questions,
  answerRef,
  selectedId,
  onSelect,
  flashClass = DEFAULT_FLASH_CLASS,
  flashDurationMs = DEFAULT_FLASH_DURATION_MS,
  scrollOptions,
}: QuestionFeedProps): ReactNode {
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup any pending flash timer on unmount so we never mutate a node React
  // no longer owns. The component does not survive across meetings, so this is
  // mostly defensive — but the test suite validates the cleanup semantics.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  function handleChipClick(id: string) {
    const target = answerRef?.current ?? null;
    if (target) {
      try {
        target.scrollIntoView(scrollOptions ?? DEFAULT_SCROLL_OPTIONS);
      } catch {
        // jsdom + some headless envs throw on scrollIntoView with options.
        // Ignore — the click should still flash + dispatch onSelect.
      }
      target.classList.add(flashClass);
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = setTimeout(() => {
        // Re-resolve `target` lazily inside the timer would be safer if the
        // caller swapped refs mid-flight; for v0.2 we trust the captured node.
        target.classList.remove(flashClass);
        flashTimerRef.current = null;
      }, flashDurationMs);
    }
    try {
      onSelect?.(id);
    } catch {
      // Swallow consumer errors — the chip click should never crash the feed.
    }
  }

  if (questions.length === 0) {
    return (
      <section className="question-feed" data-testid="question-feed">
        <p
          className="question-feed__empty"
          data-testid="question-feed-empty"
        >
          No questions detected yet.
        </p>
      </section>
    );
  }

  return (
    <section className="question-feed" data-testid="question-feed">
      <ul className="question-feed__list">
        {questions.map((q) => {
          const isSelected = selectedId === q.id;
          const showConfidence =
            q.method === "auto" && typeof q.confidence === "number";
          const confidenceTier = showConfidence
            ? classifyConfidence(q.confidence!)
            : null;
          const confidencePct = showConfidence
            ? Math.round(q.confidence! * 100)
            : null;
          const visibleText = truncate(q.text, CHIP_TEXT_MAX_CHARS);

          return (
            <li key={q.id} className="question-feed__item">
              <button
                type="button"
                data-testid="question-chip"
                data-question-id={q.id}
                data-method={q.method}
                data-selected={isSelected ? "true" : "false"}
                title={q.text}
                className={[
                  "question-feed__chip",
                  isSelected ? "question-feed__chip--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleChipClick(q.id)}
              >
                <span
                  className="question-feed__badge"
                  data-testid="question-method"
                  data-method={q.method}
                >
                  {q.method === "auto" ? "AI" : "manual"}
                </span>
                {showConfidence && (
                  <span
                    className={`question-feed__badge question-feed__badge--conf qf-conf--${confidenceTier}`}
                    data-testid="question-confidence"
                  >
                    {confidencePct}%
                  </span>
                )}
                <span className="question-feed__text">{visibleText}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
