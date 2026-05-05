// Phase 2 T-2.5 — Bounded admit queue + single-flight + optional persistence.
//
// Pipeline position (per ARCH §3 + §5 + INDEX dep graph):
//   detector pipeline (T-2.1 → T-2.2 → T-2.3 → T-2.4) → THIS module → T-2.6 worker.
//
// Invariants:
//   1. FIFO admit/dequeue order.
//   2. `pending().length <= maxDepth` always (drop-oldest on overflow).
//   3. At most one in-flight item; `dequeue()` is the only transition into it.
//   4. Persistence snapshot = pending ++ in-flight (an in-flight item replays
//      as pending head on reconstruct — Sonnet calls are stateless so retry
//      is safe).
//   5. No module-level mutable state — each `createQuestionQueue()` returns
//      an independent closure.

import type { HaikuVerdict } from "../llm/haikuFilter";
import type { Utterance } from "../../shared/types";

export interface QueuedItem {
  id: string;
  meetingId: string;
  utterance: Utterance;
  verdict: HaikuVerdict;
  dedupHash: string;
  enqueuedAt: number;
}

export type DropReason = "backpressure";

export interface EnqueueResult {
  admitted: boolean;
  itemId: string;
  droppedItemIds?: string[];
  reason?: DropReason;
}

export interface QueuePersistenceAdapter {
  load(): QueuedItem[];
  save(items: QueuedItem[]): void;
  clear(): void;
}

export interface CreateQueueOptions {
  maxDepth?: number;
  persistence?: QueuePersistenceAdapter;
  now?: () => number;
  generateId?: () => string;
}

export interface EnqueueInput {
  meetingId: string;
  utterance: Utterance;
  verdict: HaikuVerdict;
  dedupHash: string;
  id?: string;
}

export interface QuestionQueue {
  enqueue(input: EnqueueInput): EnqueueResult;
  dequeue(): QueuedItem | null;
  complete(itemId: string): boolean;
  fail(itemId: string, reason?: string): boolean;
  pending(): QueuedItem[];
  inFlight(): QueuedItem | null;
  size(): number;
  isBusy(): boolean;
  clear(): void;
}

export const DEFAULT_MAX_DEPTH = 5 as const;

function defaultGenerateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `q-${c.randomUUID()}`;
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Reference Map-backed adapter. Tests + ad-hoc callers can pass a shared Map
// across queue reconstructs to simulate "queue persists across restart"
// without wiring a real disk path. localStorage / SQLite adapters are future
// drop-ins behind the same interface.
export function createQueuePersistenceAdapter(
  store: Map<string, QueuedItem[]>,
  meetingId: string,
): QueuePersistenceAdapter {
  return {
    load(): QueuedItem[] {
      const saved = store.get(meetingId);
      return saved ? saved.map((it) => ({ ...it })) : [];
    },
    save(items: QueuedItem[]): void {
      // Defensive copy — caller mutations to its own arrays must not bleed
      // into the persisted snapshot.
      store.set(
        meetingId,
        items.map((it) => ({ ...it })),
      );
    },
    clear(): void {
      store.delete(meetingId);
    },
  };
}

export function createQuestionQueue(opts?: CreateQueueOptions): QuestionQueue {
  const maxDepth = Math.max(1, opts?.maxDepth ?? DEFAULT_MAX_DEPTH);
  const clock = opts?.now ?? Date.now;
  const mintId = opts?.generateId ?? defaultGenerateId;
  const persistence = opts?.persistence;

  // Hydrate from persistence on construct. An in-flight item from a prior
  // session is indistinguishable from pending in the snapshot (they're
  // unioned per the persistence semantics in the spec); on reconstruct we
  // treat all loaded items as pending, with `current` left null. The worker
  // (T-2.6) drives the next dequeue → retry.
  const loaded = persistence ? persistence.load() : [];
  const pending: QueuedItem[] = loaded.map((it) => ({ ...it }));
  let current: QueuedItem | null = null;

  function snapshot(): QueuedItem[] {
    // Persisted union order: pending head-to-tail, then in-flight last.
    // (On reconstruct we replay all of these as pending; the relative order
    // matters only for FIFO of pending, not for the in-flight slot which
    // resolves separately.)
    const out: QueuedItem[] = pending.map((it) => ({ ...it }));
    if (current) out.push({ ...current });
    return out;
  }

  function persist(): void {
    if (!persistence) return;
    try {
      persistence.save(snapshot());
    } catch {
      // Persistence failures are telemetry-only by design (see spec risk
      // table). The queue stays consistent in memory; the next save attempt
      // retries the whole snapshot. We swallow rather than propagate so a
      // disk error never crashes the detector pipeline mid-meeting.
    }
  }

  function enqueue(input: EnqueueInput): EnqueueResult {
    const itemId = input.id ?? mintId();
    const item: QueuedItem = {
      id: itemId,
      meetingId: input.meetingId,
      utterance: input.utterance,
      verdict: input.verdict,
      dedupHash: input.dedupHash,
      enqueuedAt: clock(),
    };

    // Drop-oldest: prune pending head until adding this item leaves us at
    // exactly maxDepth (or below). In-flight slot is structurally separate
    // and never participates in eviction.
    const droppedItemIds: string[] = [];
    while (pending.length + 1 > maxDepth) {
      const evicted = pending.shift();
      if (!evicted) break; // unreachable when maxDepth >= 1, but typesafe.
      droppedItemIds.push(evicted.id);
    }

    pending.push(item);
    persist();

    const result: EnqueueResult = { admitted: true, itemId };
    if (droppedItemIds.length > 0) result.droppedItemIds = droppedItemIds;
    return result;
  }

  function dequeue(): QueuedItem | null {
    if (current) return null;
    const head = pending.shift();
    if (!head) return null;
    current = head;
    persist();
    return { ...head };
  }

  function complete(itemId: string): boolean {
    if (!current || current.id !== itemId) return false;
    current = null;
    persist();
    return true;
  }

  function fail(itemId: string, _reason?: string): boolean {
    if (!current || current.id !== itemId) return false;
    current = null;
    persist();
    return true;
  }

  function pendingSnapshot(): QueuedItem[] {
    return pending.map((it) => ({ ...it }));
  }

  function inFlight(): QueuedItem | null {
    return current ? { ...current } : null;
  }

  function size(): number {
    return pending.length;
  }

  function isBusy(): boolean {
    return current !== null;
  }

  function clear(): void {
    pending.length = 0;
    current = null;
    if (persistence) {
      try {
        persistence.clear();
      } catch {
        // Same telemetry-only swallow as persist().
      }
    }
  }

  return {
    enqueue,
    dequeue,
    complete,
    fail,
    pending: pendingSnapshot,
    inFlight,
    size,
    isBusy,
    clear,
  };
}
