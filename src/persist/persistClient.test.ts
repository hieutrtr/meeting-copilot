// Phase 1 T-1.13 — persistClient unit tests (E7..E10).

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MeetingSession } from "../../shared/types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const {
  saveMeetingSnapshot,
  loadMeetings,
  SAVE_MEETING_COMMAND,
  LOAD_MEETINGS_COMMAND,
} = await import("./persistClient");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("saveMeetingSnapshot", () => {
  it("E7: forwards the snapshot under the `save_meeting` command name", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const snapshot = {
      meeting: {
        id: "m-1",
        title: "Test",
        startedAt: 1,
        status: "ended" as const,
      },
      chunks: [],
      questions: [],
    };
    await saveMeetingSnapshot(snapshot);
    expect(invokeMock).toHaveBeenCalledWith(SAVE_MEETING_COMMAND, { snapshot });
  });

  it("E8: propagates rejections from the underlying invoke", async () => {
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      saveMeetingSnapshot({
        meeting: { id: "m-1", title: "x", startedAt: 1, status: "ended" },
        chunks: [],
        questions: [],
      }),
    ).rejects.toThrow("disk full");
  });
});

describe("loadMeetings", () => {
  it("E9: invokes the `load_meetings` command with no args", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await loadMeetings();
    expect(invokeMock).toHaveBeenCalledWith(LOAD_MEETINGS_COMMAND);
  });

  it("E10: returns the parsed meeting list as-is", async () => {
    const rows: MeetingSession[] = [
      { id: "m-1", title: "One", startedAt: 9, endedAt: 10, status: "ended" },
      { id: "m-2", title: "Two", startedAt: 1, status: "ended" },
    ];
    invokeMock.mockResolvedValueOnce(rows);
    const got = await loadMeetings();
    expect(got).toEqual(rows);
  });
});
