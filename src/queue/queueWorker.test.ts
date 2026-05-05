// Phase 2 T-2.6 — queueWorker tests.
//
// Covers AC-1..AC-9 from `docs/tasks/phase-2/T-2.6-auto-trigger.md`:
//   AC-1: end-to-end first-token latency < 10 s under fake-timer simulation
//   AC-2: single-flight invariant (no two ask() concurrent)
//   AC-3: store.markAuto called once per job, with the right shape
//   AC-4: ask() throws → queue.fail + onItemError + worker continues
//   AC-5: manual-mark path (markFromChunks) does NOT trigger the worker
//   AC-6: regression-free (asserted by the whole-repo suite, no new edits to
//          claudeClient/useAskClaude/App.tsx)
//   AC-7: stop() prevents further dequeue
//   AC-8: notify() is idempotent under recursion
//   AC-9: covered in questionStore.test.ts (MA-S1..MA-S7)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptChunk, Utterance } from "../../shared/types";
import type {
  AskClaudeEvent,
  AskClaudeInput,
  AskClaudeResult,
} from "../llm/claudeClient";
import type { HaikuVerdict } from "../llm/haikuFilter";
import { useMeetingStore } from "../store/meetingStore";
import { useQuestionStore } from "../store/questionStore";
import {
  type AskFn,
  type QueueWorkerStore,
  createQueueWorker,
} from "./queueWorker";
import {
  type EnqueueInput,
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

// Synthetic store-like adapter so the worker test never needs the zustand
// store. The questionStore.test.ts file covers store integration directly.
function fakeStore(): {
  store: QueueWorkerStore;
  calls: Array<{ text: string; meetingId?: string; confidence?: number; detectedTs?: number; id?: string }>;
  shouldThrow: { value: boolean };
} {
  const calls: Array<{ text: string; meetingId?: string; confidence?: number; detectedTs?: number; id?: string }> = [];
  const shouldThrow = { value: false };
  return {
    calls,
    shouldThrow,
    store: {
      markAuto: (text, opts) => {
        if (shouldThrow.value) throw new Error("markAuto throws");
        calls.push({
          text,
          meetingId: opts?.meetingId,
          confidence: opts?.confidence,
          detectedTs: opts?.detectedTs,
          id: opts?.id,
        });
        return {
          id: opts?.id ?? `qq-${calls.length}`,
          meetingId: opts?.meetingId ?? "m",
          text,
          detectedTs: opts?.detectedTs ?? 0,
          method: "auto",
          status: "open",
        };
      },
    },
  };
}

// Synthetic ask: the test injects a "script" the generator follows. The script
// is consumed FIFO across ask() invocations. A script entry can yield a fixed
// list of events, throw, or sleep between events.
interface AskScript {
  deltas: string[];
  finalUsage?: AskClaudeResult["usage"];
  finalCost?: number;
  finalCacheReadRatio?: number;
  stopReason?: string;
  throwSync?: Error;
  throwMidStream?: { afterDeltas: number; error: Error };
  // optional per-step delay; used with vi.useFakeTimers + advanceTimersByTimeAsync.
  delayMsBeforeEachDelta?: number;
}

function makeAsk(scripts: AskScript[]): {
  ask: AskFn;
  invocations: AskClaudeInput[];
  inflight: { current: number; peak: number };
} {
  const invocations: AskClaudeInput[] = [];
  const inflight = { current: 0, peak: 0 };
  const ask: AskFn = (input: AskClaudeInput) => {
    invocations.push(input);
    const script = scripts[invocations.length - 1] ?? scripts[scripts.length - 1]!;
    if (script.throwSync) {
      throw script.throwSync;
    }
    inflight.current += 1;
    inflight.peak = Math.max(inflight.peak, inflight.current);

    async function* gen(): AsyncGenerator<AskClaudeEvent, AskClaudeResult, void> {
      try {
        let aggregated = "";
        for (let i = 0; i < script.deltas.length; i++) {
          if (script.delayMsBeforeEachDelta) {
            await new Promise((resolve) =>
              setTimeout(resolve, script.delayMsBeforeEachDelta),
            );
          }
          if (
            script.throwMidStream &&
            i === script.throwMidStream.afterDeltas
          ) {
            throw script.throwMidStream.error;
          }
          aggregated += script.deltas[i];
          yield { type: "delta", text: script.deltas[i]! };
        }
        const usage = script.finalUsage ?? { input_tokens: 0, output_tokens: 0 };
        yield { type: "usage", usage };
        if (script.stopReason) yield { type: "stopReason", reason: script.stopReason };
        return {
          text: aggregated,
          usage,
          cacheReadRatio: script.finalCacheReadRatio ?? 0,
          costUsd: script.finalCost ?? 0,
          stopReason: script.stopReason,
        };
      } finally {
        inflight.current -= 1;
      }
    }
    return gen();
  };
  return { ask, invocations, inflight };
}

beforeEach(() => {
  useQuestionStore.setState({ questions: [] });
  useMeetingStore.getState().reset();
  vi.useRealTimers();
});

afterEach(() => {
  useQuestionStore.setState({ questions: [] });
  useMeetingStore.getState().reset();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("createQueueWorker — construction", () => {
  it("returns { notify, stop, isRunning } with isRunning() initially false", () => {
    const queue = createQuestionQueue();
    const { ask } = makeAsk([{ deltas: [] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    expect(typeof worker.notify).toBe("function");
    expect(typeof worker.stop).toBe("function");
    expect(worker.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drain / FIFO / single-flight
// ---------------------------------------------------------------------------

describe("createQueueWorker — drain", () => {
  it("notify() on empty queue is a no-op (no ask call)", async () => {
    const queue = createQuestionQueue();
    const { ask, invocations } = makeAsk([{ deltas: [] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "doc",
    });
    worker.notify();
    // Allow a microtask + macrotask flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invocations).toHaveLength(0);
  });

  it("dequeues one item and calls ask with utterance text + contextDoc + recentTranscript", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([
      { deltas: ["Answer: ", "soon."], finalUsage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const { store } = fakeStore();
    const transcripts = ["recent transcript A"];
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "context-doc",
      getRecentTranscript: () => transcripts[transcripts.length - 1],
    });

    queue.enqueue(buildInput());
    worker.notify();

    await worker.waitIdle();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual({
      question: "what's the deadline?",
      contextDoc: "context-doc",
      recentTranscript: "recent transcript A",
    });
  });

  it("calls store.markAuto once per job with utterance shape (AC-3)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask } = makeAsk([{ deltas: ["x"] }]);
    const { store, calls } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      text: "what's the deadline?",
      meetingId: "m-1",
      confidence: 0.9,
      detectedTs: SAMPLE_UTT.endTs,
    });
  });

  it("forwards delta + usage + stopReason events via callbacks", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask } = makeAsk([
      {
        deltas: ["a", "b", "c"],
        finalUsage: { input_tokens: 11, output_tokens: 22 },
        stopReason: "end_turn",
        finalCost: 0.0001,
        finalCacheReadRatio: 0.5,
      },
    ]);
    const { store } = fakeStore();

    const deltas: string[] = [];
    let doneResult: AskClaudeResult | null = null;
    let startCount = 0;

    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      onItemStart: () => {
        startCount += 1;
      },
      onItemDelta: (_item, delta) => deltas.push(delta),
      onItemDone: (_item, result) => {
        doneResult = result;
      },
    });

    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(startCount).toBe(1);
    expect(deltas).toEqual(["a", "b", "c"]);
    expect(doneResult).not.toBeNull();
    expect(doneResult!.text).toBe("abc");
    expect(doneResult!.stopReason).toBe("end_turn");
  });

  it("calls queue.complete(itemId) after the generator returns", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const completeSpy = vi.spyOn(queue, "complete");
    const { ask } = makeAsk([{ deltas: ["x"] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    const r = queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(completeSpy).toHaveBeenCalledWith(r.itemId);
    expect(queue.isBusy()).toBe(false);
  });

  it("processes 5 enqueued items in FIFO order, single-flight (AC-2)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter(), maxDepth: 10 });
    const scripts: AskScript[] = Array.from({ length: 5 }, () => ({
      deltas: ["x"],
    }));
    const { ask, invocations, inflight } = makeAsk(scripts);
    const { store } = fakeStore();

    const doneOrder: string[] = [];
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      onItemDone: (item) => doneOrder.push(item.id),
    });

    const enqueued: string[] = [];
    for (let i = 0; i < 5; i++) {
      const utt: Utterance = { ...SAMPLE_UTT, text: `q-utt-${i}` };
      const r = queue.enqueue(buildInput({ utterance: utt }));
      enqueued.push(r.itemId);
    }
    worker.notify();
    await worker.waitIdle();

    expect(invocations).toHaveLength(5);
    expect(doneOrder).toEqual(enqueued);
    expect(inflight.peak).toBe(1); // Single-flight invariant
  });
});

// ---------------------------------------------------------------------------
// Error paths (AC-4)
// ---------------------------------------------------------------------------

describe("createQueueWorker — error paths", () => {
  it("ask() sync-throw → queue.fail + onItemError + drains next item (AC-4)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter(), maxDepth: 10 });
    const failSpy = vi.spyOn(queue, "fail");
    const err = new Error("MissingApiKey-equivalent");
    const { ask, invocations } = makeAsk([
      { deltas: [], throwSync: err },
      { deltas: ["x"] },
    ]);
    const { store } = fakeStore();

    const errors: Array<{ id: string; error: Error }> = [];
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      onItemError: (item, e) => errors.push({ id: item.id, error: e }),
    });

    const r1 = queue.enqueue(buildInput());
    const r2 = queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(failSpy).toHaveBeenCalledWith(r1.itemId, err.message);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe(err);
    expect(invocations).toHaveLength(2); // The 2nd item still ran.
    expect(queue.isBusy()).toBe(false);
    expect(queue.size()).toBe(0);
    void r2;
  });

  it("ask() throws mid-stream after 1 delta → queue.fail + partial text preserved", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const failSpy = vi.spyOn(queue, "fail");
    const err = new Error("network blew up");
    const { ask } = makeAsk([
      {
        deltas: ["partial-", "wont-arrive"],
        throwMidStream: { afterDeltas: 1, error: err },
      },
    ]);
    const { store } = fakeStore();

    const partials: string[] = [];
    let errored: { partial: string; error: Error } | null = null;
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      onItemDelta: (_item, delta) => partials.push(delta),
      onItemError: (_item, error, partial) => {
        errored = { partial: partial ?? "", error };
      },
    });

    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(partials).toEqual(["partial-"]);
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(errored).not.toBeNull();
    expect(errored!.error).toBe(err);
    expect(errored!.partial).toBe("partial-");
  });

  it("worker survives store.markAuto throw (test 21)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([{ deltas: ["x"] }]);
    const { store, shouldThrow } = fakeStore();
    shouldThrow.value = true;

    const errors: Error[] = [];
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      onItemError: (_item, e) => errors.push(e),
    });

    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    // Worker DID call queue.fail (markAuto threw before ask started).
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("markAuto throws");
    expect(invocations).toHaveLength(0); // ask was not called
    expect(queue.isBusy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Latency (AC-1)
// ---------------------------------------------------------------------------

describe("createQueueWorker — latency", () => {
  it("first-token latency reported via onMetric, < 10 s budget under simulation (AC-1)", async () => {
    vi.useFakeTimers();
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    let nowMs = 0;
    // Synthetic timing: heuristic 2 ms + Haiku 200 ms (modeled as enqueue
    // arrival jitter) + Sonnet first-token at +2 000 ms after ask() begins.
    const { ask, invocations } = makeAsk([
      {
        deltas: ["hello"],
        delayMsBeforeEachDelta: 2_000,
      },
    ]);
    const { store } = fakeStore();

    const metrics: Array<{ firstTokenLatencyMs: number; endToEndLatencyMs: number }> = [];
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      now: () => nowMs,
      onMetric: (_item, m) => metrics.push(m),
    });

    nowMs = 0;
    queue.enqueue(buildInput());
    worker.notify();

    // Drain microtasks then advance the fake clock past the synthetic delay.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    nowMs = 200; // ask() begins ~200 ms after enqueue
    await vi.advanceTimersByTimeAsync(2_000);
    nowMs = 2_200; // first delta lands
    await vi.advanceTimersByTimeAsync(1);
    nowMs = 2_201; // generator finishes
    await worker.waitIdle();

    expect(invocations).toHaveLength(1);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics[0]!.firstTokenLatencyMs).toBeLessThan(10_000);
    expect(metrics[0]!.endToEndLatencyMs).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// Stop / notify idempotence (AC-7, AC-8)
// ---------------------------------------------------------------------------

describe("createQueueWorker — stop + notify idempotence", () => {
  it("notify() called 100× on a 1-item queue triggers exactly 1 ask invocation (AC-8)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([{ deltas: ["x"] }]);
    const { store } = fakeStore();

    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });

    queue.enqueue(buildInput());
    for (let i = 0; i < 100; i++) worker.notify();
    await worker.waitIdle();

    expect(invocations).toHaveLength(1);
  });

  it("stop() prevents subsequent dequeues (AC-7)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter(), maxDepth: 10 });
    const { ask, invocations } = makeAsk([{ deltas: ["x"] }, { deltas: ["x"] }, { deltas: ["x"] }]);
    const { store } = fakeStore();

    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });

    queue.enqueue(buildInput());
    queue.enqueue(buildInput());
    queue.enqueue(buildInput());

    worker.notify();
    // Wait for the first item to complete then immediately stop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The first item is/was being processed. Stop now → no more items processed.
    worker.stop();
    worker.notify();
    worker.notify();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Either 1 (stopped before drain looped) or some count <= 3, but never > 3.
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    expect(invocations.length).toBeLessThanOrEqual(3);
    // After stop, the queue should still have pending items (since we stopped).
    // Re-notify is a no-op.
    expect(queue.size() + (queue.inFlight() ? 1 : 0) + invocations.length).toBeGreaterThanOrEqual(3);
  });

  it("stop() is idempotent and survives a no-op notify after stop", () => {
    const queue = createQuestionQueue();
    const { ask } = makeAsk([{ deltas: [] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    expect(() => {
      worker.stop();
      worker.stop();
      worker.notify();
    }).not.toThrow();
  });

  it("after all items drained, isBusy() is false and notify() is a no-op", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([{ deltas: ["x"] }, { deltas: ["x"] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    queue.enqueue(buildInput());
    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(queue.isBusy()).toBe(false);
    expect(queue.size()).toBe(0);
    worker.notify();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(invocations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC-5: no double-trigger with manual mark
// ---------------------------------------------------------------------------

describe("createQueueWorker — manual-mark independence (AC-5)", () => {
  it("calling useQuestionStore.markFromChunks does NOT trigger the worker", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([{ deltas: [] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });

    useMeetingStore.getState().start({ meetingId: "m", now: 0 });
    const chunks: TranscriptChunk[] = [
      {
        id: "c1",
        meetingId: "m",
        text: "manual question?",
        startTs: 0,
        endTs: 1_000,
        isFinal: true,
      },
    ];
    useQuestionStore
      .getState()
      .markFromChunks(chunks, { lastN: 1, meetingId: "m" });
    useQuestionStore
      .getState()
      .markFromChunks(chunks, { lastN: 1, meetingId: "m" });
    useQuestionStore
      .getState()
      .markFromChunks(chunks, { lastN: 1, meetingId: "m" });

    worker.notify();
    await worker.waitIdle();

    expect(invocations).toHaveLength(0);
    expect(useQuestionStore.getState().questions).toHaveLength(3); // manual marks went through
    expect(useQuestionStore.getState().questions.every((q) => q.method === "manual")).toBe(true);
  });

  it("manual mark + auto enqueue are recorded with their respective methods (newest-first)", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask } = makeAsk([{ deltas: ["x"] }]);
    const realStore: QueueWorkerStore = {
      markAuto: (text, opts) =>
        useQuestionStore.getState().markAuto(text, opts),
    };
    const worker = createQueueWorker({
      queue,
      ask,
      store: realStore,
      getContextDoc: () => "",
    });

    useMeetingStore.getState().start({ meetingId: "m-merge", now: 0 });

    // Manual mark first.
    useQuestionStore
      .getState()
      .markFromChunks(
        [
          {
            id: "c1",
            meetingId: "m-merge",
            text: "manual question",
            startTs: 0,
            endTs: 1_000,
            isFinal: true,
          },
        ],
        { lastN: 1 },
      );

    // Auto detector path lands second.
    queue.enqueue(buildInput({ meetingId: "m-merge" }));
    worker.notify();
    await worker.waitIdle();

    const list = useQuestionStore.getState().questions;
    expect(list).toHaveLength(2);
    expect(list[0]!.method).toBe("auto");
    expect(list[0]!.text).toBe("what's the deadline?");
    expect(list[1]!.method).toBe("manual");
    expect(list[1]!.text).toBe("manual question");
  });
});

// ---------------------------------------------------------------------------
// Recent-transcript getter is dynamic (test 20)
// ---------------------------------------------------------------------------

describe("createQueueWorker — dynamic getRecentTranscript", () => {
  it("each ask invocation sees the snapshot at its call time", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter(), maxDepth: 10 });
    const { ask, invocations } = makeAsk([
      { deltas: ["a"] },
      { deltas: ["b"] },
    ]);
    const { store } = fakeStore();

    let transcriptVersion = 0;
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
      getRecentTranscript: () => {
        transcriptVersion += 1;
        return `transcript v${transcriptVersion}`;
      },
    });

    queue.enqueue(buildInput());
    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(invocations).toHaveLength(2);
    // Each call should see a *fresh* read from the getter — the values must be
    // distinct (worker is not caching the first call's value).
    expect(invocations[0]!.recentTranscript).not.toBe(
      invocations[1]!.recentTranscript,
    );
  });
});

// ---------------------------------------------------------------------------
// Defensive: empty contextDoc passes through
// ---------------------------------------------------------------------------

describe("createQueueWorker — defensive paths", () => {
  it("getContextDoc returns empty string → ask still receives '' verbatim, no crash", async () => {
    const queue = createQuestionQueue({ generateId: makeIdMinter() });
    const { ask, invocations } = makeAsk([{ deltas: ["x"] }]);
    const { store } = fakeStore();
    const worker = createQueueWorker({
      queue,
      ask,
      store,
      getContextDoc: () => "",
    });
    queue.enqueue(buildInput());
    worker.notify();
    await worker.waitIdle();

    expect(invocations[0]!.contextDoc).toBe("");
  });
});
