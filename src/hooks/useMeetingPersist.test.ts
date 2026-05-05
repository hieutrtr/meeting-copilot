// @vitest-environment jsdom
// Phase 1 T-1.13 — useMeetingPersist tests (E11..E14).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { MeetingSession, TranscriptChunk } from "../../shared/types";

const saveMeetingSnapshot = vi.fn();
const loadMeetings = vi.fn();

vi.mock("../persist/persistClient", () => ({
  saveMeetingSnapshot: (...args: unknown[]) => saveMeetingSnapshot(...args),
  loadMeetings: (...args: unknown[]) => loadMeetings(...args),
}));

const { useMeetingPersist } = await import("./useMeetingPersist");
const { useMeetingStore } = await import("../store/meetingStore");
const { useQuestionStore } = await import("../store/questionStore");
const { useContextStore } = await import("../store/contextStore");
const { useHistoryStore } = await import("../store/historyStore");

beforeEach(() => {
  saveMeetingSnapshot.mockReset();
  saveMeetingSnapshot.mockResolvedValue(undefined);
  loadMeetings.mockReset();
  loadMeetings.mockResolvedValue([]);
  useMeetingStore.getState().reset();
  useQuestionStore.getState().clear();
  useContextStore.getState().clear();
  useHistoryStore.getState().clear();
});

afterEach(() => {
  cleanup();
  useMeetingStore.getState().reset();
  useQuestionStore.getState().clear();
  useContextStore.getState().clear();
  useHistoryStore.getState().clear();
});

describe("useMeetingPersist", () => {
  it("E11: hydrates pastMeetings on mount via loadMeetings()", async () => {
    const past: MeetingSession[] = [
      { id: "m-old", title: "Old", startedAt: 1, endedAt: 2, status: "ended" },
      { id: "m-old2", title: "Old2", startedAt: 3, endedAt: 4, status: "ended" },
    ];
    loadMeetings.mockResolvedValueOnce(past);

    await act(async () => {
      renderHook(() => useMeetingPersist({ chunks: [], answer: null }));
      await Promise.resolve();
    });

    expect(loadMeetings).toHaveBeenCalledTimes(1);
    expect(useHistoryStore.getState().pastMeetings).toEqual(past);
  });

  it("E11b: failed loadMeetings keeps pastMeetings empty (no throw)", async () => {
    loadMeetings.mockRejectedValueOnce(new Error("no db yet"));
    // Silence the warn this path emits.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () => {
      renderHook(() => useMeetingPersist({ chunks: [], answer: null }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useHistoryStore.getState().pastMeetings).toEqual([]);
    warn.mockRestore();
  });

  it("E12: saves once when status flips to ended", async () => {
    useContextStore.setState({
      source: {
        id: "ctx-1",
        path: "/tmp/PRD.md",
        charCount: 10,
        estimatedTokens: 3,
        loadedAt: 1,
      },
      content: "PRD",
      error: null,
    });

    const chunks: TranscriptChunk[] = [
      { id: "c-0", meetingId: "m-1", text: "hi", startTs: 0, endTs: 100, isFinal: true },
    ];
    const answer = { text: "the answer", model: "claude-sonnet-4-6", tokensIn: 5, tokensOut: 6 };

    const { rerender } = renderHook(
      ({ c, a }: { c: TranscriptChunk[]; a: typeof answer | null }) =>
        useMeetingPersist({ chunks: c, answer: a }),
      { initialProps: { c: chunks, a: answer } },
    );

    await act(async () => {
      useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });
      useQuestionStore.getState().markFromChunks(chunks, { lastN: 1, id: "q-1" });
    });
    expect(saveMeetingSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      useMeetingStore.getState().stop({ now: 2_000 });
      rerender({ c: chunks, a: answer });
      await Promise.resolve();
    });

    expect(saveMeetingSnapshot).toHaveBeenCalledTimes(1);
    const arg = saveMeetingSnapshot.mock.calls[0]![0];
    expect(arg.meeting.id).toBe("m-1");
    expect(arg.meeting.status).toBe("ended");
    expect(arg.meeting.endedAt).toBe(2_000);
    expect(arg.chunks).toHaveLength(1);
    expect(arg.questions).toHaveLength(1);
    expect(arg.answer.text).toBe("the answer");
    expect(arg.answer.questionId).toBe("q-1");
    expect(arg.contextSource.id).toBe("ctx-1");
  });

  it("E13: idempotent — re-renders after Stop don't re-save", async () => {
    const chunks: TranscriptChunk[] = [];
    const { rerender } = renderHook(() =>
      useMeetingPersist({ chunks, answer: null }),
    );

    await act(async () => {
      useMeetingStore.getState().start({ meetingId: "m-2", now: 1_000 });
      useMeetingStore.getState().stop({ now: 2_000 });
      rerender();
      await Promise.resolve();
    });
    expect(saveMeetingSnapshot).toHaveBeenCalledTimes(1);

    // Several extra renders with the same status — must not re-save.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        rerender();
      });
    }
    expect(saveMeetingSnapshot).toHaveBeenCalledTimes(1);
  });

  it("E14: never saves if status stays idle", async () => {
    renderHook(() => useMeetingPersist({ chunks: [], answer: null }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveMeetingSnapshot).not.toHaveBeenCalled();
  });
});
