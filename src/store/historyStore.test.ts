// Phase 1 T-1.13 — historyStore unit tests (E15..E16).

import { beforeEach, describe, expect, it } from "vitest";

import type { MeetingSession } from "../../shared/types";
import { useHistoryStore } from "./historyStore";

beforeEach(() => {
  useHistoryStore.getState().clear();
});

describe("useHistoryStore", () => {
  it("E16: initial state is empty", () => {
    expect(useHistoryStore.getState().pastMeetings).toEqual([]);
  });

  it("E15: setPastMeetings replaces the list", () => {
    const a: MeetingSession = { id: "a", title: "A", startedAt: 1, status: "ended" };
    const b: MeetingSession = { id: "b", title: "B", startedAt: 2, status: "ended" };
    useHistoryStore.getState().setPastMeetings([a]);
    expect(useHistoryStore.getState().pastMeetings).toEqual([a]);
    useHistoryStore.getState().setPastMeetings([b]);
    expect(useHistoryStore.getState().pastMeetings).toEqual([b]);
  });
});
