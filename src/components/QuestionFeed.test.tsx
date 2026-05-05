// @vitest-environment jsdom
//
// Phase 2 T-2.8 — `QuestionFeed` presentational + interaction tests.
//
// AC traceability (see docs/tasks/phase-2/T-2.8-question-feed.md):
//   QF-S1   → AC-1     (empty state)
//   QF-S2   → AC-2,3   (one chip per question, newest-first, text)
//   QF-S3   → AC-4     (method attribute)
//   QF-S4   → AC-5     (manual chip: no confidence badge)
//   QF-S5   → AC-5     (auto chip + undefined confidence: no badge)
//   QF-S6   → AC-5,6   (auto + 0.92: 92% high)
//   QF-S7   → AC-6     (mid + low tier classes)
//   QF-S8   → AC-14    (long text truncation + title)
//   QF-S9   → AC-7     (click → scrollIntoView default)
//   QF-S10  → AC-12    (custom scrollOptions)
//   QF-S11  → AC-11    (no answerRef → still onSelect, no throw)
//   QF-S12  → AC-11    (answerRef.current=null → no throw)
//   QF-S13  → AC-8     (flash class added then removed at 1500 ms)
//   QF-S14  → AC-9     (custom flashClass + flashDurationMs)
//   QF-S15  → (doc)    (multi-click extends flash window)
//   QF-S16  → AC-10    (onSelect called with id)
//   QF-S17  → AC-13    (selectedId attribute)
//   QF-S18  → (doc)    (rerender doesn't reset flash state mid-flight)
//   QF-S19  → (edge)   (empty text still renders)
//   QF-S20  → AC-6     (confidence boundary semantics)

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QuestionFeed, type QuestionFeedProps } from "./QuestionFeed";
import type { Question } from "../../shared/types";

// jsdom doesn't ship `Element.prototype.scrollIntoView`. Install a no-op stub
// once at module load so individual `beforeEach` blocks can `vi.spyOn` the
// existing property without "property is not defined" errors.
if (typeof (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView !== "function") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: function () {},
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Tiny helpers ---------------------------------------------------------------

function makeQ(over: Partial<Question> = {}): Question {
  return {
    id: over.id ?? "q-1",
    meetingId: over.meetingId ?? "m-1",
    text: over.text ?? "what's the deadline?",
    detectedTs: over.detectedTs ?? 1000,
    method: over.method ?? "auto",
    ...over,
  };
}

interface HarnessProps extends Omit<QuestionFeedProps, "answerRef"> {
  attachRef?: boolean;
}

function Harness(props: HarnessProps) {
  const ref = useRef<HTMLElement | null>(null);
  return (
    <>
      <article
        ref={(el) => {
          ref.current = el;
        }}
        data-testid="answer-target"
      >
        answer body
      </article>
      <QuestionFeed
        {...props}
        answerRef={props.attachRef === false ? undefined : ref}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

describe("QuestionFeed — empty state", () => {
  it("QF-S1: renders empty-state when questions=[]", () => {
    render(<QuestionFeed questions={[]} />);
    expect(screen.getByTestId("question-feed-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("question-chip")).toHaveLength(0);
  });
});

describe("QuestionFeed — chip rendering (AC-2..AC-5)", () => {
  it("QF-S2: renders one chip per question in array order", () => {
    const qs: Question[] = [
      makeQ({ id: "q-1", text: "first?" }),
      makeQ({ id: "q-2", text: "second?" }),
      makeQ({ id: "q-3", text: "third?" }),
    ];
    render(<QuestionFeed questions={qs} />);

    const chips = screen.getAllByTestId("question-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]?.getAttribute("data-question-id")).toBe("q-1");
    expect(chips[1]?.getAttribute("data-question-id")).toBe("q-2");
    expect(chips[2]?.getAttribute("data-question-id")).toBe("q-3");
    expect(chips[0]?.textContent).toContain("first?");
    expect(chips[1]?.textContent).toContain("second?");
    expect(chips[2]?.textContent).toContain("third?");
  });

  it("QF-S3: data-method attribute reflects auto vs manual", () => {
    render(
      <QuestionFeed
        questions={[
          makeQ({ id: "q-a", method: "auto" }),
          makeQ({ id: "q-m", method: "manual" }),
        ]}
      />,
    );
    const chips = screen.getAllByTestId("question-chip");
    expect(chips[0]?.getAttribute("data-method")).toBe("auto");
    expect(chips[1]?.getAttribute("data-method")).toBe("manual");
  });

  it("QF-S4: manual chip has no confidence badge", () => {
    render(
      <QuestionFeed
        questions={[makeQ({ method: "manual", confidence: 0.95 })]}
      />,
    );
    const chip = screen.getByTestId("question-chip");
    expect(within(chip).queryByTestId("question-confidence")).toBeNull();
  });

  it("QF-S5: auto chip with undefined confidence has no badge", () => {
    render(
      <QuestionFeed questions={[makeQ({ method: "auto" })]} />,
    );
    const chip = screen.getByTestId("question-chip");
    expect(within(chip).queryByTestId("question-confidence")).toBeNull();
  });

  it("QF-S6: auto chip + 0.92 → 92% with qf-conf--high class", () => {
    render(
      <QuestionFeed
        questions={[makeQ({ method: "auto", confidence: 0.92 })]}
      />,
    );
    const badge = screen.getByTestId("question-confidence");
    expect(badge).toHaveTextContent("92%");
    expect(badge.classList.contains("qf-conf--high")).toBe(true);
  });

  it("QF-S7: confidence tiers — 0.65→mid, 0.4→low", () => {
    const qs: Question[] = [
      makeQ({ id: "q-mid", method: "auto", confidence: 0.65 }),
      makeQ({ id: "q-low", method: "auto", confidence: 0.4 }),
    ];
    render(<QuestionFeed questions={qs} />);
    const badges = screen.getAllByTestId("question-confidence");
    expect(badges[0]?.classList.contains("qf-conf--mid")).toBe(true);
    expect(badges[0]).toHaveTextContent("65%");
    expect(badges[1]?.classList.contains("qf-conf--low")).toBe(true);
    expect(badges[1]).toHaveTextContent("40%");
  });
});

describe("QuestionFeed — long text truncation (AC-14)", () => {
  it("QF-S8: 200-char text → truncated visible + full text in title", () => {
    const longText = "a".repeat(200);
    render(<QuestionFeed questions={[makeQ({ text: longText })]} />);

    const chip = screen.getByTestId("question-chip");
    expect(chip.getAttribute("title")).toBe(longText);
    // Visible text is shorter than original.
    const visible = chip.querySelector(".question-feed__text");
    expect(visible).not.toBeNull();
    expect((visible?.textContent ?? "").length).toBeLessThan(longText.length);
    expect(visible?.textContent ?? "").toContain("…");
  });
});

describe("QuestionFeed — click → scrollIntoView (AC-7, AC-11, AC-12)", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView by default; install a mock so
    // calls are observable without throwing.
    scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollSpy.mockRestore();
  });

  it("QF-S9: click chip calls scrollIntoView once with default opts on the answer target", async () => {
    const user = userEvent.setup();
    render(<Harness questions={[makeQ()]} />);

    await user.click(screen.getByTestId("question-chip"));

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    const callArg = scrollSpy.mock.calls[0]?.[0] as ScrollIntoViewOptions;
    expect(callArg).toEqual({ behavior: "smooth", block: "start" });
    // Verify the receiver is the answer-target element.
    const target = screen.getByTestId("answer-target");
    expect(scrollSpy.mock.instances[0]).toBe(target);
  });

  it("QF-S10: custom scrollOptions propagates", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        questions={[makeQ()]}
        scrollOptions={{ behavior: "auto", block: "center" }}
      />,
    );

    await user.click(screen.getByTestId("question-chip"));

    const callArg = scrollSpy.mock.calls[0]?.[0] as ScrollIntoViewOptions;
    expect(callArg).toEqual({ behavior: "auto", block: "center" });
  });

  it("QF-S11: no answerRef → onSelect still fires, no scroll, no throw", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<QuestionFeed questions={[makeQ()]} onSelect={onSelect} />);

    await user.click(screen.getByTestId("question-chip"));

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("q-1");
  });

  it("QF-S12: answerRef.current=null → onSelect fires, no scroll, no throw", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const nullRef = { current: null as HTMLElement | null };
    render(
      <QuestionFeed
        questions={[makeQ()]}
        answerRef={nullRef}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId("question-chip"));

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("QuestionFeed — click → flash class (AC-8, AC-9)", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    scrollSpy.mockRestore();
  });

  // Flash tests intentionally use `fireEvent.click` instead of `userEvent.click`.
  // userEvent v14 schedules pointer-event ticks via setTimeout(0) chains; under
  // `vi.useFakeTimers()` the await-loop deadlocks waiting for timers we control.
  // `fireEvent` dispatches synchronously, which is what the assertion shape here
  // (sync flash class flip + manual timer advance) actually needs.

  it("QF-S13: default — flash class added then removed at 1500 ms", () => {
    render(<Harness questions={[makeQ()]} />);

    const target = screen.getByTestId("answer-target");
    expect(target.classList.contains("answer-flash")).toBe(false);

    fireEvent.click(screen.getByTestId("question-chip"));
    expect(target.classList.contains("answer-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(target.classList.contains("answer-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(target.classList.contains("answer-flash")).toBe(false);
  });

  it("QF-S14: custom flashClass + flashDurationMs honored", () => {
    render(
      <Harness
        questions={[makeQ()]}
        flashClass="custom-flash"
        flashDurationMs={200}
      />,
    );

    const target = screen.getByTestId("answer-target");
    fireEvent.click(screen.getByTestId("question-chip"));
    expect(target.classList.contains("custom-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(target.classList.contains("custom-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(target.classList.contains("custom-flash")).toBe(false);
  });

  it("QF-S15: subsequent click resets the flash timer rather than firing the prior one early", () => {
    const qs = [makeQ({ id: "q-a" }), makeQ({ id: "q-b" })];
    render(<Harness questions={qs} />);

    const target = screen.getByTestId("answer-target");
    const [chipA, chipB] = screen.getAllByTestId("question-chip");

    fireEvent.click(chipA!);
    expect(target.classList.contains("answer-flash")).toBe(true);

    // Advance halfway through the first flash, then re-click — the timer must
    // reset, so 1499 ms after the *second* click the class is still present.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.click(chipB!);
    expect(target.classList.contains("answer-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(target.classList.contains("answer-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(target.classList.contains("answer-flash")).toBe(false);
  });
});

describe("QuestionFeed — onSelect + selectedId (AC-10, AC-13)", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollSpy.mockRestore();
  });

  it("QF-S16: onSelect called once with the chip's question id", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        questions={[makeQ({ id: "q-x" })]}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId("question-chip"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("q-x");
  });

  it("QF-S17: selectedId flips data-selected on matching chip", () => {
    const qs = [
      makeQ({ id: "q-1" }),
      makeQ({ id: "q-2" }),
      makeQ({ id: "q-3" }),
    ];
    render(<QuestionFeed questions={qs} selectedId="q-2" />);

    const chips = screen.getAllByTestId("question-chip");
    expect(chips[0]?.getAttribute("data-selected")).toBe("false");
    expect(chips[1]?.getAttribute("data-selected")).toBe("true");
    expect(chips[2]?.getAttribute("data-selected")).toBe("false");
  });

  it("QF-S16b: throwing onSelect does not crash the click handler", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    render(<Harness questions={[makeQ()]} onSelect={onSelect} />);

    await user.click(screen.getByTestId("question-chip"));
    expect(onSelect).toHaveBeenCalled();
    // No throw escapes the click — test reaches this point.
  });
});

describe("QuestionFeed — defensive (QF-S18..QF-S20)", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    scrollSpy.mockRestore();
  });

  it("QF-S18: rerender with new questions array preserves the in-flight flash timer", () => {
    const initial = [makeQ({ id: "q-1" })];
    const { rerender } = render(<Harness questions={initial} />);

    const target = screen.getByTestId("answer-target");
    fireEvent.click(screen.getByTestId("question-chip"));
    expect(target.classList.contains("answer-flash")).toBe(true);

    // New question list arrives mid-flash (auto-detect adds another).
    rerender(
      <Harness
        questions={[makeQ({ id: "q-2", text: "another?" }), ...initial]}
      />,
    );
    // Flash still in flight; class remains.
    expect(target.classList.contains("answer-flash")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(target.classList.contains("answer-flash")).toBe(false);
  });

  it("QF-S19: empty `text` still renders a chip without crashing", () => {
    render(<QuestionFeed questions={[makeQ({ text: "" })]} />);
    const chip = screen.getByTestId("question-chip");
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute("title")).toBe("");
  });

  it("QF-S20: confidence boundary — 0.8 high, 0.6 mid, 0.5999… low", () => {
    const qs: Question[] = [
      makeQ({ id: "q-bh", method: "auto", confidence: 0.8 }),
      makeQ({ id: "q-bm", method: "auto", confidence: 0.6 }),
      makeQ({ id: "q-bl", method: "auto", confidence: 0.5999 }),
    ];
    render(<QuestionFeed questions={qs} />);
    const badges = screen.getAllByTestId("question-confidence");
    expect(badges[0]?.classList.contains("qf-conf--high")).toBe(true);
    expect(badges[1]?.classList.contains("qf-conf--mid")).toBe(true);
    expect(badges[2]?.classList.contains("qf-conf--low")).toBe(true);
  });
});
