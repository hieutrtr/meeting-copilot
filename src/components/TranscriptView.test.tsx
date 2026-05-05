// @vitest-environment jsdom
//
// Phase 1 T-1.7 — `TranscriptView` component tests.
// Per-file `jsdom` pragma so the existing 9 node-env tests stay byte-identical.
//
// AC traceability (see docs/tasks/phase-1/T-1.7-transcript-view.md):
//   UI-T1 → AC-1, AC-6 (renders chunks + mm:ss timestamp)
//   UI-T2 → AC-2 (50 chunks, last chunk in DOM, scrollIntoView called)
//   UI-T3 → AC-3 (append re-render → scrollIntoView called again)
//   UI-T4 → AC-4, AC-5 (search filter + restore)
//   UI-T5 → AC-4 (search highlight via <mark>)
//   UI-T6 → AC-7 (1000 chunks → rendered listitem count < 100)

import "@testing-library/jest-dom/vitest";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptChunk } from "../../shared/types";
import { TranscriptView } from "./TranscriptView";

// jsdom does not implement Element.scrollIntoView. We install a vi.fn() spy so
// auto-scroll AC tests can count invocations.
const originalScrollIntoView = Element.prototype.scrollIntoView;
const scrollIntoViewSpy = vi.fn();

beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoViewSpy as unknown as typeof originalScrollIntoView;
});

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  scrollIntoViewSpy.mockClear();
  cleanup();
});

function makeChunk(i: number, text: string, startSec = i * 2): TranscriptChunk {
  return {
    id: `m1-${i}`,
    meetingId: "m1",
    text,
    startTs: startSec * 1000,
    endTs: (startSec + 2) * 1000,
    isFinal: true,
  };
}

function makeSequence(n: number): TranscriptChunk[] {
  return Array.from({ length: n }, (_, i) => makeChunk(i, `chunk ${i + 1}`));
}

describe("TranscriptView", () => {
  it("UI-T1 — renders each chunk with its text + mm:ss timestamp prefix", () => {
    const chunks = [
      makeChunk(0, "first line", 0), // 00:00
      makeChunk(1, "second line", 65), // 01:05
      makeChunk(2, "third line", 730), // 12:10
    ];
    render(<TranscriptView chunks={chunks} />);

    expect(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.getByText(/second line/)).toBeInTheDocument();
    expect(screen.getByText(/third line/)).toBeInTheDocument();

    expect(screen.getByText(/\[00:00\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[01:05\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[12:10\]/)).toBeInTheDocument();
  });

  it("UI-T2 — with 50 chunks, last chunk is rendered and scrollIntoView fires on mount", () => {
    const chunks = makeSequence(50);
    render(<TranscriptView chunks={chunks} />);

    // Last chunk visible (within the rendered virtual window).
    expect(screen.getByText(/chunk 50/)).toBeInTheDocument();
    // Auto-scroll fired at least once.
    expect(scrollIntoViewSpy).toHaveBeenCalled();
  });

  it("UI-T3 — appending a chunk via re-render scrolls again", () => {
    const initial = makeSequence(10);
    const { rerender } = render(<TranscriptView chunks={initial} />);
    const afterMountCalls = scrollIntoViewSpy.mock.calls.length;

    const appended = [...initial, makeChunk(10, "freshly arrived")];
    rerender(<TranscriptView chunks={appended} />);

    expect(screen.getByText(/freshly arrived/)).toBeInTheDocument();
    expect(scrollIntoViewSpy.mock.calls.length).toBeGreaterThan(afterMountCalls);
  });

  it("UI-T4 — search filters list (case-insensitive); empty query restores full list", async () => {
    const user = userEvent.setup();
    const chunks = [
      makeChunk(0, "alpha greeting"),
      makeChunk(1, "beta middle"),
      makeChunk(2, "gamma end"),
    ];
    render(<TranscriptView chunks={chunks} />);

    const search = screen.getByRole("searchbox", { name: /search/i });

    await user.type(search, "ALPHA");
    // When search is active, the matched chunk's text is split around <mark>,
    // so we assert via the surviving listitem's textContent rather than getByText.
    const filteredItems = screen.getAllByRole("listitem");
    expect(filteredItems).toHaveLength(1);
    expect(filteredItems[0]?.textContent).toContain("alpha greeting");
    expect(screen.queryByText(/beta middle/)).not.toBeInTheDocument();
    expect(screen.queryByText(/gamma end/)).not.toBeInTheDocument();

    await user.clear(search);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/alpha greeting/)).toBeInTheDocument();
    expect(screen.getByText(/beta middle/)).toBeInTheDocument();
    expect(screen.getByText(/gamma end/)).toBeInTheDocument();
  });

  it("UI-T5 — matching substring is wrapped in <mark> (case-insensitive, original casing preserved)", async () => {
    const user = userEvent.setup();
    const chunks = [makeChunk(0, "say AlPhA now")];
    render(<TranscriptView chunks={chunks} />);

    const search = screen.getByRole("searchbox", { name: /search/i });
    await user.type(search, "alpha");

    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBe(1);
    // Highlight uses the original casing from the chunk text, not the query.
    expect(marks[0]?.textContent).toBe("AlPhA");
  });

  it("UI-T6 — with 1000 chunks, fewer than 100 list items are rendered (virtualization)", () => {
    const chunks = makeSequence(1000);
    render(<TranscriptView chunks={chunks} />);

    const items = screen.queryAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(100);
  });
});
