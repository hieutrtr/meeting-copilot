// Phase 1 T-1.9 — vitest harness for the manual-marked question store.
//
// AC traceability (see docs/tasks/phase-1/T-1.9-meeting-controls.md):
//   QS-S1 → AC-2 (markFromChunks([]) returns null + does not mutate)
//   QS-S2 → AC-2 (defaults to lastN = 3, joins with single space, detectedTs = last endTs)
//   QS-S3 → AC-2 (lastN override captures only the requested tail)
//   QS-S4 → AC-2 (newest-first ordering)
//   QS-S5 → AC-2 (meetingId opt overrides store value)

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "../../shared/types";
import { useMeetingStore } from "./meetingStore";
import { useQuestionStore } from "./questionStore";

function chunk(idx: number, text: string, endTs = (idx + 1) * 1_000): TranscriptChunk {
  return {
    id: `c-${idx}`,
    meetingId: "m-1",
    text,
    startTs: idx * 1_000,
    endTs,
    isFinal: true,
  };
}

beforeEach(() => {
  useQuestionStore.setState({ questions: [] });
  useMeetingStore.getState().reset();
});

afterEach(() => {
  useQuestionStore.setState({ questions: [] });
  useMeetingStore.getState().reset();
});

describe("useQuestionStore.markFromChunks", () => {
  it("QS-S1: empty chunks returns null and leaves the list untouched", () => {
    const result = useQuestionStore.getState().markFromChunks([]);
    expect(result).toBeNull();
    expect(useQuestionStore.getState().questions).toHaveLength(0);
  });

  it("QS-S2: defaults to last 3 chunks, joined with a single space", () => {
    useMeetingStore.getState().start({ meetingId: "m-42", now: 0 });

    const chunks = [
      chunk(0, "alpha"),
      chunk(1, "beta"),
      chunk(2, "charlie"),
      chunk(3, "delta"),
      chunk(4, "echo"),
    ];

    const q = useQuestionStore
      .getState()
      .markFromChunks(chunks, { now: 99 });

    expect(q).not.toBeNull();
    expect(q!.text).toBe("charlie delta echo");
    expect(q!.method).toBe("manual");
    expect(q!.status).toBe("open");
    expect(q!.meetingId).toBe("m-42");
    expect(q!.detectedTs).toBe(5_000); // chunk(4).endTs
    expect(useQuestionStore.getState().questions).toHaveLength(1);
  });

  it("QS-S2 (lastN > length): bounded to whole array, no out-of-range slice", () => {
    useMeetingStore.getState().start({ meetingId: "m-42", now: 0 });

    const chunks = [chunk(0, "only-one")];
    const q = useQuestionStore
      .getState()
      .markFromChunks(chunks, { lastN: 9 });

    expect(q!.text).toBe("only-one");
  });

  it("QS-S3: lastN = 1 captures only the most recent chunk", () => {
    useMeetingStore.getState().start({ meetingId: "m-42", now: 0 });

    const chunks = [chunk(0, "alpha"), chunk(1, "beta"), chunk(2, "charlie")];
    const q = useQuestionStore
      .getState()
      .markFromChunks(chunks, { lastN: 1 });

    expect(q!.text).toBe("charlie");
    expect(q!.detectedTs).toBe(3_000); // chunk(2).endTs
  });

  it("QS-S4: newest mark prepends; questions ordered newest-first", () => {
    useMeetingStore.getState().start({ meetingId: "m-42", now: 0 });

    useQuestionStore
      .getState()
      .markFromChunks([chunk(0, "first")], { lastN: 1 });
    useQuestionStore
      .getState()
      .markFromChunks([chunk(1, "second")], { lastN: 1 });

    const list = useQuestionStore.getState().questions;
    expect(list).toHaveLength(2);
    expect(list[0]!.text).toBe("second");
    expect(list[1]!.text).toBe("first");
  });

  it("QS-S5: meetingId option overrides the value from the meeting store", () => {
    useMeetingStore.getState().start({ meetingId: "m-store", now: 0 });

    const q = useQuestionStore
      .getState()
      .markFromChunks([chunk(0, "x")], { meetingId: "m-explicit", lastN: 1 });

    expect(q!.meetingId).toBe("m-explicit");
  });

  it("falls back to meetingId='unknown' when no meeting is active and no opt passed", () => {
    // meeting store is at the reset baseline → no active meeting.
    const q = useQuestionStore
      .getState()
      .markFromChunks([chunk(0, "x")], { lastN: 1 });

    expect(q!.meetingId).toBe("unknown");
  });

  it("clear() drops all questions", () => {
    useQuestionStore
      .getState()
      .markFromChunks([chunk(0, "a")], { lastN: 1, meetingId: "m" });
    useQuestionStore.getState().clear();
    expect(useQuestionStore.getState().questions).toHaveLength(0);
  });
});
