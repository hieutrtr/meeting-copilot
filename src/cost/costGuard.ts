// Phase 2 T-2.7 — Cost guard: per-meeting token counter + threshold alert.
//
// Pipeline position (per ARCH §13 + INDEX dep graph):
//   T-2.3 Haiku filter (usage event) ──┐
//                                       ├─→ THIS module ──→ T-2.8 banner
//   T-2.6 worker onItemDone(usage) ────┘                  └─ T-2.9 pause toggle
//
// Invariants:
//   1. recordHaikuUsage / recordSonnetUsage are pure side-effects on the
//      closure-scoped counter — no module-level mutable state.
//   2. onAlert fires AT MOST ONCE per meeting (latched). reset() un-latches.
//   3. Projection = totalCostUsd / elapsedMs * 3_600_000, gated by a warm-up
//      window (default 60_000 ms) to suppress false alarms when a single
//      expensive call lands in the first few seconds of the meeting.
//   4. setPaused() is a SIGNAL not an INTERLOCK — the cost guard does not
//      itself prevent recording. Callers (guardedClassifyWithHaiku) honor it.
//   5. Defensive copies on snapshot() so React state can compare cheaply and
//      consumer mutation cannot corrupt the closure state.
//
// The cost guard is framework-agnostic. T-2.8 will wire it into the AnswerPanel
// header + a banner via an event bus / polling re-snap; T-2.9 will bind a
// checkbox to setPaused() with localStorage persistence.

import {
  computeCostUsd,
  computeHaikuCostUsd,
  type AnthropicUsage,
} from "../llm/pricing";

export const DEFAULT_THRESHOLD_USD_PER_HOUR = 0.5 as const;
export const DEFAULT_MIN_ELAPSED_MS = 60_000 as const;
const MS_PER_HOUR = 3_600_000;

export interface CostCounter {
  calls: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSnapshot {
  haiku: CostCounter;
  sonnet: CostCounter;
  totalCostUsd: number;
  elapsedMs: number;
  projectedCostPerHourUsd: number;
  thresholdUsdPerHour: number;
  thresholdCrossed: boolean;
  paused: boolean;
}

export interface CreateCostGuardOptions {
  thresholdUsdPerHour?: number;
  minElapsedMsForProjection?: number;
  meetingStartTs?: number;
  now?: () => number;
  onAlert?: (snapshot: CostSnapshot) => void;
  paused?: boolean;
}

export interface CostGuard {
  recordHaikuUsage(usage: AnthropicUsage): CostSnapshot;
  recordSonnetUsage(usage: AnthropicUsage): CostSnapshot;
  snapshot(): CostSnapshot;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  reset(): void;
}

function emptyCounter(): CostCounter {
  return {
    calls: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function addUsage(c: CostCounter, u: AnthropicUsage, costUsd: number): void {
  c.calls += 1;
  c.inputTokens += u.input_tokens ?? 0;
  c.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
  c.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  c.outputTokens += u.output_tokens ?? 0;
  c.costUsd += costUsd;
}

function copyCounter(c: CostCounter): CostCounter {
  return { ...c };
}

export function createCostGuard(opts?: CreateCostGuardOptions): CostGuard {
  const threshold = opts?.thresholdUsdPerHour ?? DEFAULT_THRESHOLD_USD_PER_HOUR;
  const minElapsed = opts?.minElapsedMsForProjection ?? DEFAULT_MIN_ELAPSED_MS;
  const clock = opts?.now ?? Date.now;
  const onAlert = opts?.onAlert;

  let haiku = emptyCounter();
  let sonnet = emptyCounter();
  let alertFired = false;
  let paused = opts?.paused ?? false;
  let meetingStart = opts?.meetingStartTs ?? clock();

  function buildSnapshot(): CostSnapshot {
    const total = haiku.costUsd + sonnet.costUsd;
    const elapsed = Math.max(0, clock() - meetingStart);
    const projected =
      elapsed < minElapsed ? 0 : (total / elapsed) * MS_PER_HOUR;
    return {
      haiku: copyCounter(haiku),
      sonnet: copyCounter(sonnet),
      totalCostUsd: total,
      elapsedMs: elapsed,
      projectedCostPerHourUsd: projected,
      thresholdUsdPerHour: threshold,
      thresholdCrossed: alertFired,
      paused,
    };
  }

  function maybeFireAlert(): void {
    if (alertFired) return;
    const total = haiku.costUsd + sonnet.costUsd;
    const elapsed = Math.max(0, clock() - meetingStart);
    if (elapsed < minElapsed) return;
    const projected = (total / elapsed) * MS_PER_HOUR;
    if (projected > threshold) {
      alertFired = true;
      const fired = buildSnapshot();
      try {
        onAlert?.(fired);
      } catch {
        // Swallow consumer errors so a hostile callback cannot break the
        // recording path. Telemetry-only by design.
      }
    }
  }

  function recordHaikuUsage(usage: AnthropicUsage): CostSnapshot {
    const cost = computeHaikuCostUsd(usage);
    addUsage(haiku, usage, cost);
    maybeFireAlert();
    return buildSnapshot();
  }

  function recordSonnetUsage(usage: AnthropicUsage): CostSnapshot {
    const cost = computeCostUsd(usage);
    addUsage(sonnet, usage, cost);
    maybeFireAlert();
    return buildSnapshot();
  }

  function snapshot(): CostSnapshot {
    return buildSnapshot();
  }

  function setPaused(p: boolean): void {
    paused = p;
  }

  function isPaused(): boolean {
    return paused;
  }

  function reset(): void {
    haiku = emptyCounter();
    sonnet = emptyCounter();
    alertFired = false;
    meetingStart = clock();
  }

  return {
    recordHaikuUsage,
    recordSonnetUsage,
    snapshot,
    setPaused,
    isPaused,
    reset,
  };
}

// ── Composer wrapper ────────────────────────────────────────────────────────
//
// `guardedClassifyWithHaiku` is the canonical integration point for T-2.3.
// Short-circuits when the guard is paused (no SDK call), otherwise records the
// returned usage for cost accounting. The inner classifier is supplied by the
// caller so this stays trivially testable + framework-agnostic.

export interface GuardedClassifyOptions {
  apiKey?: string;
}

export type GuardedClassifyStatus = "classified" | "skipped-paused";

export interface GuardedClassifyResult<R> {
  status: GuardedClassifyStatus;
  result?: R;
}

export interface ClassifyWithUsage<R extends { usage: AnthropicUsage }> {
  (text: string, opts?: GuardedClassifyOptions): Promise<R>;
}

export async function guardedClassifyWithHaiku<
  R extends { usage: AnthropicUsage },
>(
  text: string,
  classify: ClassifyWithUsage<R>,
  guard: CostGuard,
  opts?: GuardedClassifyOptions,
): Promise<GuardedClassifyResult<R>> {
  if (guard.isPaused()) {
    return { status: "skipped-paused" };
  }
  const result = await classify(text, opts);
  guard.recordHaikuUsage(result.usage);
  return { status: "classified", result };
}
