// Phase 2 T-2.6 — Auto-trigger worker.
//
// Pipeline position (per ARCH §3 + INDEX dep graph):
//   detector pipeline (T-2.1 → T-2.2 → T-2.3 → T-2.4) → T-2.5 queue → THIS
//   module → existing T-1.10 askClaude (Sonnet streaming) → caller-supplied
//   render layer (AnswerPanel via T-2.8 useQueueWorker hook).
//
// Invariants:
//   1. Single-flight: queue.dequeue() is the only transition into in-flight,
//      and the worker awaits the ask() generator to completion before the
//      next dequeue (FIFO drain).
//   2. ask() error (sync throw OR mid-stream throw) → queue.fail(itemId),
//      onItemError fires with the partial-aggregated text (if any), drain
//      proceeds to the next item.
//   3. notify() is idempotent. Re-entrant calls during an in-flight job are
//      coalesced — at most one drain loop is alive at any time.
//   4. stop() prevents future dequeues; the in-flight item completes naturally
//      (the underlying askClaude stream is not aborted at this layer; that's
//      a Phase-2.x concern via AbortController plumbing).
//   5. No module-level mutable state — each createQueueWorker() returns an
//      independent closure.
//
// The worker is framework-agnostic. T-2.8 will wrap it in a React hook to
// surface streaming events to AnswerPanel. T-2.7 will read `result.usage` /
// `result.costUsd` from onItemDone() to drive the cost guard.

import type {
  AskClaudeEvent,
  AskClaudeInput,
  AskClaudeResult,
} from "../llm/claudeClient";
import type { QueuedItem, QuestionQueue } from "./questionQueue";
import type { Question } from "../../shared/types";

export type AskFn = (
  input: AskClaudeInput,
) => AsyncGenerator<AskClaudeEvent, AskClaudeResult, void>;

export interface MarkAutoOpts {
  meetingId?: string;
  detectedTs?: number;
  confidence?: number;
  id?: string;
}

// Minimal slice of useQuestionStore consumed by the worker. Decoupled from
// zustand so the worker stays trivially testable without a React tree.
export interface QueueWorkerStore {
  markAuto: (text: string, opts?: MarkAutoOpts) => Question | null;
}

export interface QueueWorkerMetric {
  firstTokenLatencyMs: number;
  endToEndLatencyMs: number;
  totalDeltas: number;
}

export interface CreateQueueWorkerOptions {
  queue: QuestionQueue;
  ask: AskFn;
  store: QueueWorkerStore;
  getContextDoc: () => string;
  getRecentTranscript?: () => string | undefined;
  // Lifecycle callbacks. All optional; suppression of any of them is safe.
  onItemStart?: (item: QueuedItem, question: Question | null) => void;
  onItemDelta?: (item: QueuedItem, delta: string, accumulated: string) => void;
  onItemDone?: (item: QueuedItem, result: AskClaudeResult) => void;
  onItemError?: (item: QueuedItem, error: Error, partial?: string) => void;
  onMetric?: (item: QueuedItem, metric: QueueWorkerMetric) => void;
  // Injectable clock — tests use a fake `now()` that the production caller
  // would not pass (we default to Date.now()).
  now?: () => number;
}

export interface QueueWorker {
  notify(): void;
  stop(): void;
  isRunning(): boolean;
  // Resolves when the drain loop is idle (no in-flight item AND queue empty).
  // Useful for tests + meeting-end teardown.
  waitIdle(): Promise<void>;
}

export function createQueueWorker(opts: CreateQueueWorkerOptions): QueueWorker {
  const {
    queue,
    ask,
    store,
    getContextDoc,
    getRecentTranscript,
    onItemStart,
    onItemDelta,
    onItemDone,
    onItemError,
    onMetric,
  } = opts;
  const clock = opts.now ?? Date.now;

  let stopped = false;
  let running = false;
  // When drain is busy and notify() comes in, we set this flag so the loop
  // knows to recheck after the current item finishes. Functions like a level-
  // triggered interrupt (vs. edge-triggered) so multiple notify()s during a
  // single job collapse into "drain again when done".
  let pendingNotify = false;
  // Resolvers waiting on waitIdle().
  const idleWaiters: Array<() => void> = [];

  function flushIdleWaiters(): void {
    while (idleWaiters.length > 0) {
      const w = idleWaiters.shift()!;
      try {
        w();
      } catch {
        // waitIdle resolvers should never throw, but a defensive try/catch
        // keeps the drain loop alive even if a test passes a hostile resolver.
      }
    }
  }

  async function processOne(item: QueuedItem): Promise<void> {
    const enqueuedAt = item.enqueuedAt;
    let firstTokenAt: number | null = null;
    let aggregated = "";
    let totalDeltas = 0;

    // Mark the question into the store BEFORE the ask, so the chip can render
    // alongside the streaming answer (T-2.8). If markAuto throws we treat
    // that as a failure path — the worker reports it via onItemError + calls
    // queue.fail, but does NOT call ask (no question to attach the answer to).
    let question: Question | null = null;
    try {
      question = store.markAuto(item.utterance.text, {
        meetingId: item.meetingId,
        detectedTs: item.utterance.endTs,
        confidence: item.verdict.confidence,
        id: item.id,
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        queue.fail(item.id, e.message);
      } catch {
        /* queue.fail should never throw; defensive only */
      }
      try {
        onItemError?.(item, e, "");
      } catch {
        /* swallow callback errors */
      }
      return;
    }

    try {
      onItemStart?.(item, question);
    } catch {
      /* swallow callback errors */
    }

    let gen: AsyncGenerator<AskClaudeEvent, AskClaudeResult, void>;
    try {
      gen = ask({
        question: item.utterance.text,
        contextDoc: getContextDoc(),
        recentTranscript: getRecentTranscript?.(),
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        queue.fail(item.id, e.message);
      } catch {
        /* defensive */
      }
      try {
        onItemError?.(item, e, aggregated);
      } catch {
        /* swallow */
      }
      return;
    }

    let result: AskClaudeResult | null = null;
    try {
      while (true) {
        const step = await gen.next();
        if (step.done) {
          result = step.value;
          break;
        }
        const event = step.value;
        if (event.type === "delta") {
          if (firstTokenAt === null) firstTokenAt = clock();
          aggregated += event.text;
          totalDeltas += 1;
          try {
            onItemDelta?.(item, event.text, aggregated);
          } catch {
            /* swallow */
          }
        }
        // usage + stopReason are folded into the final `result.value`; we
        // ignore intermediate events. (T-2.7 reads them off `result.usage` /
        // `result.costUsd` in onItemDone instead.)
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        queue.fail(item.id, e.message);
      } catch {
        /* defensive */
      }
      try {
        onItemError?.(item, e, aggregated);
      } catch {
        /* swallow */
      }
      return;
    }

    const endAt = clock();
    try {
      queue.complete(item.id);
    } catch {
      /* defensive */
    }
    try {
      onItemDone?.(item, result!);
    } catch {
      /* swallow */
    }
    try {
      onMetric?.(item, {
        firstTokenLatencyMs:
          firstTokenAt !== null ? Math.max(0, firstTokenAt - enqueuedAt) : 0,
        endToEndLatencyMs: Math.max(0, endAt - enqueuedAt),
        totalDeltas,
      });
    } catch {
      /* swallow */
    }
  }

  async function drain(): Promise<void> {
    if (running) {
      pendingNotify = true;
      return;
    }
    running = true;
    try {
      while (!stopped) {
        const next = queue.dequeue();
        if (!next) break;
        await processOne(next);
        // After each item we either continue (more pending) or fall out of
        // the loop. pendingNotify is consumed implicitly by the while-loop
        // recheck; we just clear the flag.
        pendingNotify = false;
      }
    } finally {
      running = false;
      // If a notify came in while we were finishing the last item, drain
      // again. This prevents the lost-wakeup hazard where:
      //   t0: drain about to exit (pending empty)
      //   t0+ε: enqueue + notify lands (would set pendingNotify but we're not
      //         inside drain anymore so the flag wouldn't help)
      // We capture the flag while still inside `running=true` then re-enter.
      // (The check below catches the race because `running` is set false
      // after the loop exit but before the sync flag check.)
      if (pendingNotify && !stopped) {
        pendingNotify = false;
        // Re-enter via microtask to keep the call stack flat.
        queueMicrotask(() => {
          // Defensive: re-check `running` because another caller may have
          // beaten us to drain in the same microtask tick.
          if (!running && !stopped) void drain();
        });
        return;
      }
    }
    // Drain is idle. Wake any waiters.
    if (!queue.isBusy() && queue.size() === 0) {
      flushIdleWaiters();
    }
  }

  function notify(): void {
    if (stopped) return;
    if (running) {
      pendingNotify = true;
      return;
    }
    void drain();
  }

  function stop(): void {
    stopped = true;
    // Wake any waitIdle() callers — they're not interested in a graceful
    // post-stop drain; they want to know the worker won't pull more work.
    flushIdleWaiters();
  }

  function isRunning(): boolean {
    return running;
  }

  function waitIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // If already idle (queue empty + not busy + drain not running), resolve
      // on next microtask so callers can chain off `notify(); await waitIdle()`
      // without races against pending microtask state.
      if (!running && !queue.isBusy() && queue.size() === 0) {
        queueMicrotask(resolve);
        return;
      }
      idleWaiters.push(resolve);
    });
  }

  return { notify, stop, isRunning, waitIdle };
}
