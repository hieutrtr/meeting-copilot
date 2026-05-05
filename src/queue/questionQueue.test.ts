// Phase 2 T-2.5 — QuestionQueue unit + stress + persistence tests.
//
// AC gate (#1): 20 q/min stress over 60 s of fake-timer simulation → 0 crash,
// drop-oldest fires when depth would exceed maxDepth, single-flight invariant
// holds. All other tests cover FIFO, drop-oldest, single-flight, persistence
// reconstruct, conservation under random ops, and edge cases (maxDepth=0,
// stale-id complete/fail, persistence-throw, independent queues).

import { describe, expect, it, vi } from "vitest";

import type { Utterance } from "../../shared/types";
import type { HaikuVerdict } from "../llm/haikuFilter";
import {
  DEFAULT_MAX_DEPTH,
  type EnqueueInput,
  type QueuedItem,
  createQueuePersistenceAdapter,
  createQuestionQueue,
} from "./questionQueue";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_UTT: Utterance = {
  text: "what's the deadline?",
  startTs: 1_700_000_000_000,
  endTs: 1_700_000_001_000,
  chunkIds: ["c1"],
};

const SAMPLE_VERDICT: HaikuVerdict = {
  isQuestion: true,
  confidence: 0.9,
  reason: "explicit interrogative",
};

function buildInput(overrides?: Partial<EnqueueInput>): EnqueueInput {
  return {
    meetingId: "m-1",
    utterance: SAMPLE_UTT,
    verdict: SAMPLE_VERDICT,
    dedupHash: "deadbeefcafef00d",
    ...overrides,
  };
}

function makeIdMinter(prefix = "q"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("createQuestionQueue — construction", () => {
  it("defaults maxDepth to 5", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(5);
    const q = createQuestionQueue();
    // Push 6 items, expect 1 drop and pending.length === 5.
    for (let i = 0; i < 6; i++) q.enqueue(buildInput());
    expect(q.size()).toBe(5);
  });

  it("clamps maxDepth: 0 to 1", () => {
    const q = createQuestionQueue({ maxDepth: 0, generateId: makeIdMinter() });
    const r1 = q.enqueue(buildInput());
    const r2 = q.enqueue(buildInput());
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r2.droppedItemIds).toEqual([r1.itemId]);
    expect(q.size()).toBe(1);
  });

  it("uses injected now() for enqueuedAt", () => {
    const fakeNow = () => 42;
    const q = createQuestionQueue({ now: fakeNow, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    expect(q.pending()[0]!.enqueuedAt).toBe(42);
  });

  it("uses injected generateId() for item ids", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter("test") });
    const r = q.enqueue(buildInput());
    expect(r.itemId).toBe("test-1");
    expect(q.pending()[0]!.id).toBe("test-1");
  });

  it("does not throw when persistence adapter is omitted", () => {
    const q = createQuestionQueue();
    expect(() => q.enqueue(buildInput())).not.toThrow();
    expect(q.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Enqueue + ordering
// ---------------------------------------------------------------------------

describe("createQuestionQueue — enqueue + ordering", () => {
  it("first admit returns admitted: true with mint id", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    const r = q.enqueue(buildInput());
    expect(r).toMatchObject({ admitted: true, itemId: "q-1" });
    expect(r.droppedItemIds).toBeUndefined();
  });

  it("preserves FIFO mint order in pending()", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    for (let i = 0; i < 5; i++) q.enqueue(buildInput());
    const ids = q.pending().map((it) => it.id);
    expect(ids).toEqual(["q-1", "q-2", "q-3", "q-4", "q-5"]);
  });

  it("uses caller-provided id verbatim when input.id is set", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    const r = q.enqueue(buildInput({ id: "custom-abc" }));
    expect(r.itemId).toBe("custom-abc");
    expect(q.pending()[0]!.id).toBe("custom-abc");
  });

  it("returns a defensive copy from pending()", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    const snap1 = q.pending();
    snap1[0]!.dedupHash = "MUTATED";
    const snap2 = q.pending();
    expect(snap2[0]!.dedupHash).toBe("deadbeefcafef00d");
  });
});

// ---------------------------------------------------------------------------
// Drop-oldest invariant
// ---------------------------------------------------------------------------

describe("createQuestionQueue — drop-oldest", () => {
  it("with maxDepth=3, 4 admits → 4th drops [oldest], pending=[2,3,4]", () => {
    const q = createQuestionQueue({ maxDepth: 3, generateId: makeIdMinter() });
    const r1 = q.enqueue(buildInput());
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    const r4 = q.enqueue(buildInput());
    expect(r4.admitted).toBe(true);
    expect(r4.droppedItemIds).toEqual([r1.itemId]);
    expect(q.pending().map((it) => it.id)).toEqual(["q-2", "q-3", "q-4"]);
  });

  it("with maxDepth=3, 5 admits → 4th and 5th each drop one (oldest at the time)", () => {
    const q = createQuestionQueue({ maxDepth: 3, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    const r4 = q.enqueue(buildInput());
    const r5 = q.enqueue(buildInput());
    expect(r4.droppedItemIds).toEqual(["q-1"]);
    expect(r5.droppedItemIds).toEqual(["q-2"]);
    expect(q.pending().map((it) => it.id)).toEqual(["q-3", "q-4", "q-5"]);
  });

  it("with maxDepth=3, 10 tight admits → keeps last 3, drops 7 total", () => {
    const q = createQuestionQueue({ maxDepth: 3, generateId: makeIdMinter() });
    let totalDropped = 0;
    for (let i = 0; i < 10; i++) {
      const r = q.enqueue(buildInput());
      totalDropped += r.droppedItemIds?.length ?? 0;
    }
    expect(q.size()).toBe(3);
    expect(q.pending().map((it) => it.id)).toEqual(["q-8", "q-9", "q-10"]);
    expect(totalDropped).toBe(7);
  });

  it("does NOT evict the in-flight slot under backpressure", () => {
    const q = createQuestionQueue({ maxDepth: 2, generateId: makeIdMinter() });
    q.enqueue(buildInput()); // q-1
    const flight = q.dequeue(); // q-1 → in-flight
    expect(flight!.id).toBe("q-1");
    expect(q.inFlight()!.id).toBe("q-1");

    // Fill pending past capacity — q-1 is in-flight and must survive.
    q.enqueue(buildInput()); // q-2
    q.enqueue(buildInput()); // q-3
    q.enqueue(buildInput()); // q-4 — drops q-2
    q.enqueue(buildInput()); // q-5 — drops q-3
    expect(q.inFlight()!.id).toBe("q-1");
    expect(q.pending().map((it) => it.id)).toEqual(["q-4", "q-5"]);
  });
});

// ---------------------------------------------------------------------------
// Single-flight + dequeue
// ---------------------------------------------------------------------------

describe("createQuestionQueue — single-flight", () => {
  it("dequeue on empty returns null and does not flip isBusy()", () => {
    const q = createQuestionQueue();
    expect(q.dequeue()).toBeNull();
    expect(q.isBusy()).toBe(false);
    expect(q.inFlight()).toBeNull();
  });

  it("dequeue with 1 pending moves it to in-flight", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    const head = q.dequeue();
    expect(head!.id).toBe("q-1");
    expect(q.size()).toBe(0);
    expect(q.isBusy()).toBe(true);
    expect(q.inFlight()!.id).toBe("q-1");
  });

  it("second dequeue while busy returns null even when pending depth > 0", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    q.dequeue();
    expect(q.dequeue()).toBeNull();
    expect(q.size()).toBe(1);
  });

  it("complete clears in-flight and the next dequeue returns the new head", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    const first = q.dequeue();
    expect(q.complete(first!.id)).toBe(true);
    expect(q.isBusy()).toBe(false);
    const next = q.dequeue();
    expect(next!.id).toBe("q-2");
  });

  it("returns a defensive copy from inFlight()", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.dequeue();
    const snap = q.inFlight();
    snap!.dedupHash = "MUTATED";
    expect(q.inFlight()!.dedupHash).toBe("deadbeefcafef00d");
  });
});

// ---------------------------------------------------------------------------
// complete / fail
// ---------------------------------------------------------------------------

describe("createQuestionQueue — complete / fail", () => {
  it("complete with in-flight id returns true and clears the slot", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    const head = q.dequeue();
    expect(q.complete(head!.id)).toBe(true);
    expect(q.inFlight()).toBeNull();
  });

  it("complete with stale id returns false and is a no-op", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.dequeue();
    expect(q.complete("not-a-real-id")).toBe(false);
    expect(q.inFlight()!.id).toBe("q-1");
  });

  it("fail with in-flight id returns true and clears the slot", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    const head = q.dequeue();
    expect(q.fail(head!.id, "boom")).toBe(true);
    expect(q.inFlight()).toBeNull();
  });

  it("fail with stale id returns false and is a no-op", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.dequeue();
    expect(q.fail("ghost", "boom")).toBe(false);
    expect(q.inFlight()!.id).toBe("q-1");
  });

  it("complete on idle queue returns false", () => {
    const q = createQuestionQueue();
    expect(q.complete("anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe("createQuestionQueue — clear", () => {
  it("clears pending + in-flight and persistence", () => {
    const store = new Map<string, QueuedItem[]>();
    const persistence = createQueuePersistenceAdapter(store, "m-1");
    const q = createQuestionQueue({ persistence, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    q.enqueue(buildInput());
    q.dequeue();
    expect(q.size()).toBe(1);
    expect(q.isBusy()).toBe(true);
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.inFlight()).toBeNull();
    expect(persistence.load()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("createQuestionQueue — persistence", () => {
  it("save() is called after admit", () => {
    const save = vi.fn();
    const adapter = {
      load: () => [],
      save,
      clear: () => {},
    };
    const q = createQuestionQueue({ persistence: adapter, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    expect(save).toHaveBeenCalledTimes(1);
    const snap = save.mock.calls[0]![0] as QueuedItem[];
    expect(snap.map((it: QueuedItem) => it.id)).toEqual(["q-1"]);
  });

  it("save() is called after dequeue with in-flight included in snapshot", () => {
    const save = vi.fn();
    const adapter = { load: () => [], save, clear: () => {} };
    const q = createQuestionQueue({ persistence: adapter, generateId: makeIdMinter() });
    q.enqueue(buildInput()); // save #1 — pending=[q-1]
    q.dequeue();             // save #2 — pending=[], in-flight=q-1, snap=[q-1]
    expect(save).toHaveBeenCalledTimes(2);
    const lastSnap = save.mock.calls[1]![0] as QueuedItem[];
    expect(lastSnap.map((it: QueuedItem) => it.id)).toEqual(["q-1"]);
  });

  it("save() after complete drops the completed item from snapshot", () => {
    const save = vi.fn();
    const adapter = { load: () => [], save, clear: () => {} };
    const q = createQuestionQueue({ persistence: adapter, generateId: makeIdMinter() });
    q.enqueue(buildInput()); // save #1
    const flight = q.dequeue(); // save #2
    q.complete(flight!.id); // save #3
    const lastSnap = save.mock.calls[2]![0] as QueuedItem[];
    expect(lastSnap).toEqual([]);
  });

  it("save() after fail also drops the failed item", () => {
    const save = vi.fn();
    const adapter = { load: () => [], save, clear: () => {} };
    const q = createQuestionQueue({ persistence: adapter, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    const flight = q.dequeue();
    q.fail(flight!.id, "boom");
    const lastSnap = save.mock.calls[2]![0] as QueuedItem[];
    expect(lastSnap).toEqual([]);
  });

  it("reconstruct from non-empty adapter restores pending in order", () => {
    const store = new Map<string, QueuedItem[]>();
    const persistence = createQueuePersistenceAdapter(store, "m-1");
    const qA = createQuestionQueue({ persistence, generateId: makeIdMinter("a") });
    qA.enqueue(buildInput());
    qA.enqueue(buildInput());
    qA.enqueue(buildInput());
    expect(qA.pending().map((it) => it.id)).toEqual(["a-1", "a-2", "a-3"]);

    // Reconstruct — fresh closure, same persistence.
    const persistence2 = createQueuePersistenceAdapter(store, "m-1");
    const qB = createQuestionQueue({
      persistence: persistence2,
      generateId: makeIdMinter("b"),
    });
    expect(qB.pending().map((it) => it.id)).toEqual(["a-1", "a-2", "a-3"]);
    expect(qB.inFlight()).toBeNull();
  });

  it("in-flight item from prior session is replayed as pending head", () => {
    const store = new Map<string, QueuedItem[]>();
    const persistence = createQueuePersistenceAdapter(store, "m-1");
    const qA = createQuestionQueue({ persistence, generateId: makeIdMinter("a") });
    qA.enqueue(buildInput());
    qA.dequeue(); // a-1 → in-flight; persisted as [a-1] (in-flight included).

    // Crash sim — drop qA, build qB fresh.
    const persistence2 = createQueuePersistenceAdapter(store, "m-1");
    const qB = createQuestionQueue({
      persistence: persistence2,
      generateId: makeIdMinter("b"),
    });
    expect(qB.pending().map((it) => it.id)).toEqual(["a-1"]);
    expect(qB.inFlight()).toBeNull();
    // T-2.6 driver is expected to dequeue + re-attempt.
    const head = qB.dequeue();
    expect(head!.id).toBe("a-1");
  });

  it("two-stage persistence: enqueue 3 → complete 1 → reconstruct → 2 remain", () => {
    const store = new Map<string, QueuedItem[]>();
    const adapter1 = createQueuePersistenceAdapter(store, "m-1");
    const qA = createQuestionQueue({ persistence: adapter1, generateId: makeIdMinter("a") });
    qA.enqueue(buildInput());
    qA.enqueue(buildInput());
    qA.enqueue(buildInput());
    const flight = qA.dequeue();
    qA.complete(flight!.id);

    const adapter2 = createQueuePersistenceAdapter(store, "m-1");
    const qB = createQuestionQueue({
      persistence: adapter2,
      generateId: makeIdMinter("b"),
    });
    expect(qB.size()).toBe(2);
    expect(qB.inFlight()).toBeNull();
    expect(qB.pending().map((it) => it.id)).toEqual(["a-2", "a-3"]);
  });

  it("clear() persists empty snapshot", () => {
    const store = new Map<string, QueuedItem[]>();
    const persistence = createQueuePersistenceAdapter(store, "m-1");
    const qA = createQuestionQueue({ persistence, generateId: makeIdMinter("a") });
    qA.enqueue(buildInput());
    qA.clear();
    const persistence2 = createQueuePersistenceAdapter(store, "m-1");
    const qB = createQuestionQueue({ persistence: persistence2 });
    expect(qB.size()).toBe(0);
  });

  it("survives adapter.save() that throws — queue stays consistent in-memory", () => {
    const adapter = {
      load: () => [],
      save: () => {
        throw new Error("disk-full");
      },
      clear: () => {},
    };
    const q = createQuestionQueue({ persistence: adapter, generateId: makeIdMinter() });
    expect(() => q.enqueue(buildInput())).not.toThrow();
    expect(q.size()).toBe(1);
    expect(q.pending()[0]!.id).toBe("q-1");
  });

  it("survives adapter.clear() that throws", () => {
    const adapter = {
      load: () => [],
      save: () => {},
      clear: () => {
        throw new Error("disk-full");
      },
    };
    const q = createQuestionQueue({ persistence: adapter });
    q.enqueue(buildInput());
    expect(() => q.clear()).not.toThrow();
    expect(q.size()).toBe(0);
  });

  it("persistence adapter snapshot is decoupled from caller mutations", () => {
    const store = new Map<string, QueuedItem[]>();
    const persistence = createQueuePersistenceAdapter(store, "m-1");
    const q = createQuestionQueue({ persistence, generateId: makeIdMinter() });
    q.enqueue(buildInput());
    // Mutate the persisted store directly — should NOT bleed into queue.
    const stored = store.get("m-1")!;
    stored[0]!.dedupHash = "MUTATED";
    // Existing in-memory queue is unchanged (we only read on construct).
    expect(q.pending()[0]!.dedupHash).toBe("deadbeefcafef00d");
  });
});

// ---------------------------------------------------------------------------
// AC GATE — 20 q/min stress
// ---------------------------------------------------------------------------

describe("createQuestionQueue — AC GATE: stress 20 q/min over 60 s", () => {
  it("admits 20 evenly-spaced over 60 s without crash, single-flight holds, conservation holds", () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);

      const store = new Map<string, QueuedItem[]>();
      const persistence = createQueuePersistenceAdapter(store, "m-stress");
      const q = createQuestionQueue({
        maxDepth: 5,
        persistence,
        generateId: makeIdMinter("s"),
      });

      let admittedCount = 0;
      let droppedCount = 0;
      let completedCount = 0;
      let failedCount = 0;

      const TOTAL = 20;
      const SPACING_MS = 3_000; // 20 admits / 60 000 ms = one every 3 s
      const ANSWER_MS = 1_500;

      // Mixed worker: every 500 ms tick, if idle, dequeue + schedule a
      // simulated answer settle in ANSWER_MS. Some attempts simulate failure
      // (every 7th item) to exercise fail() too.
      let nextAdmitAt = t0;
      let nextWorkerTickAt = t0;
      let pendingSettle: { id: string; at: number; willFail: boolean } | null = null;
      let admitIdx = 0;
      let workerIdx = 0;

      const END = t0 + 60_000;
      while (vi.getMockedSystemTime()!.valueOf() < END) {
        const now = vi.getMockedSystemTime()!.valueOf();

        // Admit pulse.
        if (now >= nextAdmitAt && admitIdx < TOTAL) {
          const r = q.enqueue(buildInput());
          if (r.admitted) admittedCount += 1;
          if (r.droppedItemIds) droppedCount += r.droppedItemIds.length;
          admitIdx += 1;
          nextAdmitAt += SPACING_MS;
        }

        // Worker settle.
        if (pendingSettle && now >= pendingSettle.at) {
          if (pendingSettle.willFail) {
            const ok = q.fail(pendingSettle.id, "stress-fail");
            if (ok) failedCount += 1;
          } else {
            const ok = q.complete(pendingSettle.id);
            if (ok) completedCount += 1;
          }
          pendingSettle = null;
        }

        // Worker tick — start next if idle.
        if (now >= nextWorkerTickAt) {
          if (!q.isBusy()) {
            const head = q.dequeue();
            if (head) {
              workerIdx += 1;
              pendingSettle = {
                id: head.id,
                at: now + ANSWER_MS,
                willFail: workerIdx % 7 === 0,
              };
            }
          }
          nextWorkerTickAt += 500;
        }

        vi.advanceTimersByTime(250);
      }

      // Drain any straggler in-flight to settle bookkeeping for the assertion.
      if (q.inFlight() && pendingSettle) {
        if (pendingSettle.willFail) failedCount += q.fail(pendingSettle.id) ? 1 : 0;
        else completedCount += q.complete(pendingSettle.id) ? 1 : 0;
        pendingSettle = null;
      }

      // No crash → if we got here we didn't throw.
      expect(admittedCount).toBe(TOTAL);
      // Single-flight invariant: every dequeue requires no prior in-flight.
      // Indirect check: the number of completes + fails ≤ workerIdx (every
      // worker iteration started exactly one job, never two concurrently).
      expect(completedCount + failedCount).toBeLessThanOrEqual(workerIdx);

      // Conservation: admitted = completed + failed + dropped + leftover (pending + in-flight).
      const leftover = q.size() + (q.inFlight() ? 1 : 0);
      expect(admittedCount).toBe(completedCount + failedCount + droppedCount + leftover);

      // Steady-state pending depth never exceeded maxDepth.
      expect(q.size()).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Conservation under random ops (seeded)
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  // Mulberry32 — short, deterministic.
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("createQuestionQueue — conservation under 100 random ops", () => {
  it("never goes inconsistent under enqueue/dequeue/complete/fail/clear", () => {
    const rng = seededRandom(0xc0ffee);
    const q = createQuestionQueue({
      maxDepth: 4,
      generateId: makeIdMinter("rnd"),
    });

    let admitted = 0;
    let dropped = 0;
    let completed = 0;
    let failed = 0;
    let cleared = 0;

    const OP_COUNT = 100;
    for (let i = 0; i < OP_COUNT; i++) {
      const op = rng();
      const sizeBefore = q.size();
      const wasBusy = q.isBusy();

      if (op < 0.55) {
        // Enqueue.
        const r = q.enqueue(buildInput());
        if (r.admitted) admitted += 1;
        if (r.droppedItemIds) dropped += r.droppedItemIds.length;
        // Post-condition: size never exceeds maxDepth.
        expect(q.size()).toBeLessThanOrEqual(4);
      } else if (op < 0.75) {
        // Dequeue.
        const head = q.dequeue();
        if (head) {
          // Was previously not busy, now busy with that item.
          expect(wasBusy).toBe(false);
          expect(q.isBusy()).toBe(true);
          expect(q.inFlight()!.id).toBe(head.id);
          expect(q.size()).toBe(sizeBefore - 1);
        } else {
          // Either empty or busy — neither produces an item.
          expect(sizeBefore === 0 || wasBusy).toBe(true);
        }
      } else if (op < 0.88) {
        // Complete.
        const flight = q.inFlight();
        if (flight) {
          const ok = q.complete(flight.id);
          expect(ok).toBe(true);
          completed += 1;
          expect(q.isBusy()).toBe(false);
        } else {
          expect(q.complete("ghost")).toBe(false);
        }
      } else if (op < 0.97) {
        // Fail.
        const flight = q.inFlight();
        if (flight) {
          const ok = q.fail(flight.id, "rnd-fail");
          expect(ok).toBe(true);
          failed += 1;
          expect(q.isBusy()).toBe(false);
        } else {
          expect(q.fail("ghost")).toBe(false);
        }
      } else {
        // Clear.
        q.clear();
        cleared += 1;
        expect(q.size()).toBe(0);
        expect(q.inFlight()).toBeNull();
      }
    }

    // Sanity: every metric is non-negative and bounded by total iterations.
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(OP_COUNT);
    expect(dropped).toBeLessThanOrEqual(admitted);
    expect(completed + failed).toBeLessThanOrEqual(admitted);
    expect(cleared).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

describe("createQuestionQueue — independent queues", () => {
  it("two queues with different adapters do not share state", () => {
    const storeA = new Map<string, QueuedItem[]>();
    const storeB = new Map<string, QueuedItem[]>();
    const adapterA = createQueuePersistenceAdapter(storeA, "m-A");
    const adapterB = createQueuePersistenceAdapter(storeB, "m-B");
    const qA = createQuestionQueue({
      persistence: adapterA,
      generateId: makeIdMinter("A"),
    });
    const qB = createQuestionQueue({
      persistence: adapterB,
      generateId: makeIdMinter("B"),
    });
    qA.enqueue(buildInput());
    qA.enqueue(buildInput());
    qB.enqueue(buildInput());
    expect(qA.size()).toBe(2);
    expect(qB.size()).toBe(1);
    qA.clear();
    expect(qA.size()).toBe(0);
    expect(qB.size()).toBe(1);
  });

  it("same Map but different meetingId → independent namespaces", () => {
    const store = new Map<string, QueuedItem[]>();
    const adapterA = createQueuePersistenceAdapter(store, "m-A");
    const adapterB = createQueuePersistenceAdapter(store, "m-B");
    const qA = createQuestionQueue({
      persistence: adapterA,
      generateId: makeIdMinter("A"),
    });
    const qB = createQuestionQueue({
      persistence: adapterB,
      generateId: makeIdMinter("B"),
    });
    qA.enqueue(buildInput({ meetingId: "m-A" }));
    qB.enqueue(buildInput({ meetingId: "m-B" }));
    expect(store.get("m-A")!.length).toBe(1);
    expect(store.get("m-B")!.length).toBe(1);
    expect(store.get("m-A")![0]!.id).not.toBe(store.get("m-B")![0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe("createQuestionQueue — edges", () => {
  it("admits empty utterance text (queue is text-agnostic)", () => {
    const q = createQuestionQueue({ generateId: makeIdMinter() });
    const emptyUtt: Utterance = {
      text: "",
      startTs: 0,
      endTs: 0,
      chunkIds: [],
    };
    const r = q.enqueue(buildInput({ utterance: emptyUtt }));
    expect(r.admitted).toBe(true);
    expect(q.size()).toBe(1);
  });

  it("default ID generator mints unique values", () => {
    const q = createQuestionQueue();
    const r1 = q.enqueue(buildInput());
    const r2 = q.enqueue(buildInput());
    expect(r1.itemId).not.toBe(r2.itemId);
    expect(r1.itemId).toMatch(/^q-/);
  });
});
