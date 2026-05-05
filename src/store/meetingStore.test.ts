// Phase 1 T-1.9 — vitest harness for the meeting state-machine store.
//
// AC traceability (see docs/tasks/phase-1/T-1.9-meeting-controls.md):
//   MS-S1 → AC-1 (initial state)
//   MS-S2 → AC-1 (start happy path: idle → active)
//   MS-S3 → AC-1 + AC-6 (start no-op when already active)
//   MS-S4 → AC-1 (stop happy path: active → ended)
//   MS-S5 → AC-1 + AC-6 (stop no-op when idle)
//   MS-S6 → AC-1 (reset returns state to MS-S1 baseline)

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useMeetingStore } from "./meetingStore";

beforeEach(() => {
  useMeetingStore.getState().reset();
});

afterEach(() => {
  useMeetingStore.getState().reset();
});

describe("useMeetingStore", () => {
  it("MS-S1: initial state is idle with no timestamps", () => {
    const s = useMeetingStore.getState();
    expect(s.status).toBe("idle");
    expect(s.meetingId).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
  });

  it("MS-S2: start() flips idle → active and stamps startedAt + meetingId", () => {
    useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });

    const s = useMeetingStore.getState();
    expect(s.status).toBe("active");
    expect(s.meetingId).toBe("m-1");
    expect(s.startedAt).toBe(1_000);
    expect(s.endedAt).toBeNull();
  });

  it("MS-S2 (auto id): start() without meetingId generates a non-empty id", () => {
    useMeetingStore.getState().start({ now: 5 });

    const id = useMeetingStore.getState().meetingId;
    expect(typeof id).toBe("string");
    expect(id!.length).toBeGreaterThan(0);
  });

  it("MS-S3: start() is a no-op when already active (id + startedAt unchanged)", () => {
    useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });
    useMeetingStore.getState().start({ meetingId: "m-2", now: 9_999 });

    const s = useMeetingStore.getState();
    expect(s.status).toBe("active");
    expect(s.meetingId).toBe("m-1");
    expect(s.startedAt).toBe(1_000);
  });

  it("MS-S4: stop() flips active → ended and stamps endedAt", () => {
    useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });
    useMeetingStore.getState().stop({ now: 2_500 });

    const s = useMeetingStore.getState();
    expect(s.status).toBe("ended");
    expect(s.endedAt).toBe(2_500);
    // startedAt + meetingId preserved so the persistence layer (T-1.12) can write the row.
    expect(s.startedAt).toBe(1_000);
    expect(s.meetingId).toBe("m-1");
  });

  it("MS-S5: stop() while idle is a no-op", () => {
    useMeetingStore.getState().stop({ now: 1_000 });

    const s = useMeetingStore.getState();
    expect(s.status).toBe("idle");
    expect(s.endedAt).toBeNull();
  });

  it("MS-S6: reset() returns to the MS-S1 baseline", () => {
    useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });
    useMeetingStore.getState().stop({ now: 2_000 });

    useMeetingStore.getState().reset();

    const s = useMeetingStore.getState();
    expect(s.status).toBe("idle");
    expect(s.meetingId).toBeNull();
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
  });

  it("post-reset start() generates a fresh meetingId", () => {
    useMeetingStore.getState().start({ meetingId: "m-1", now: 1_000 });
    useMeetingStore.getState().stop({ now: 2_000 });
    useMeetingStore.getState().reset();
    useMeetingStore.getState().start({ now: 3_000 });

    const s = useMeetingStore.getState();
    expect(s.status).toBe("active");
    expect(s.meetingId).not.toBe("m-1");
    expect(s.startedAt).toBe(3_000);
  });
});
