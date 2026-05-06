// Phase 3 T-3.5 — Per-provider STT cost meter.
//
// Pipeline position (Phase 3):
//   helper-daemon `transcript:chunk` events ──→ THIS module ──→ Settings sheet $/h indicator
//                                                              └─ Telemetry log line items (T-3.9)
//
// Mirrors the closure-scoped pattern from `src/cost/costGuard.ts` (T-2.7) so the two
// cost surfaces compose naturally at the UI layer (Settings sheet sums their
// `totalCostUsd` + `projectedCostPerHourUsd`). Independent state, identical lifecycle.
//
// Invariants:
//   1. State is closure-scoped — no module-level mutable state. Two meter instances
//      are fully independent.
//   2. `recordAudioSeconds` is a NO-OP when no active provider is set and no override
//      is supplied. The meter never throws on the hot path; the caller (UI) drives
//      provider selection via `setActiveProvider` before audio starts flowing.
//   3. `recordTranscriptChunk(c)` derives seconds from `(c.endTs - c.startTs) / 1000`.
//      Non-positive durations are dropped from the cost ledger (out-of-order or empty
//      partial). The transcript stream itself is unaffected — the meter only watches.
//   4. `setActiveProvider` is stateful — the meter remembers the last picked provider
//      across record calls. Already-recorded seconds stay attributed to whatever
//      provider was active at record time (provider switches do not retroactively
//      re-bill).
//   5. `snapshot()` returns defensive copies (per-provider counter + `perProvider`
//      object). Mutating a returned snapshot does not corrupt the next one — matches
//      the cost-guard contract for cheap React state comparison.
//   6. Projection uses the same warm-up gate as the cost guard
//      (`minElapsedMsForProjection`, default 60_000 ms). Inside the warm-up window
//      `projectedCostPerHourUsd === 0` to suppress noisy first-second extrapolations.
//   7. `onUpdate` (when supplied) fires AFTER every state-mutating call with the
//      newly-built snapshot. Quiet calls (no-op `recordAudioSeconds(0)` or
//      record without active provider) DO NOT fire — the contract is "fire on real
//      state change" so subscribers can throttle on reference identity.

import type { TranscriptChunk } from "../../shared/types";
import {
  computeSttCostUsd,
  isSttProviderId,
  STT_PROVIDER_IDS,
  type SttProviderId,
} from "../llm/sttPricing";

export const DEFAULT_MIN_ELAPSED_MS = 60_000 as const;
const MS_PER_HOUR = 3_600_000;

export interface SttProviderCounter {
  audioSeconds: number;
  costUsd: number;
}

export type SttPerProviderCounters = Record<SttProviderId, SttProviderCounter>;

export interface SttCostSnapshot {
  activeProvider: SttProviderId | null;
  perProvider: SttPerProviderCounters;
  totalAudioSeconds: number;
  totalCostUsd: number;
  elapsedMs: number;
  projectedCostPerHourUsd: number;
}

export interface CreateSttCostMeterOptions {
  initialProvider?: SttProviderId;
  meetingStartTs?: number;
  now?: () => number;
  minElapsedMsForProjection?: number;
  onUpdate?: (snapshot: SttCostSnapshot) => void;
}

export interface SttCostMeter {
  setActiveProvider(provider: SttProviderId): SttCostSnapshot;
  getActiveProvider(): SttProviderId | null;
  recordAudioSeconds(audioSeconds: number, providerOverride?: SttProviderId): SttCostSnapshot;
  recordTranscriptChunk(
    chunk: TranscriptChunk,
    providerOverride?: SttProviderId,
  ): SttCostSnapshot;
  snapshot(): SttCostSnapshot;
  reset(): void;
}

function emptyCounter(): SttProviderCounter {
  return { audioSeconds: 0, costUsd: 0 };
}

function emptyPerProvider(): SttPerProviderCounters {
  const map = {} as SttPerProviderCounters;
  for (const id of STT_PROVIDER_IDS) {
    map[id] = emptyCounter();
  }
  return map;
}

function copyPerProvider(src: SttPerProviderCounters): SttPerProviderCounters {
  const out = {} as SttPerProviderCounters;
  for (const id of STT_PROVIDER_IDS) {
    out[id] = { ...src[id] };
  }
  return out;
}

export function createSttCostMeter(opts?: CreateSttCostMeterOptions): SttCostMeter {
  const minElapsed = opts?.minElapsedMsForProjection ?? DEFAULT_MIN_ELAPSED_MS;
  const clock = opts?.now ?? Date.now;
  const onUpdate = opts?.onUpdate;

  let perProvider = emptyPerProvider();
  let activeProvider: SttProviderId | null = opts?.initialProvider ?? null;
  let meetingStart = opts?.meetingStartTs ?? clock();

  function totals(): { audio: number; cost: number } {
    let audio = 0;
    let cost = 0;
    for (const id of STT_PROVIDER_IDS) {
      audio += perProvider[id].audioSeconds;
      cost += perProvider[id].costUsd;
    }
    return { audio, cost };
  }

  function buildSnapshot(): SttCostSnapshot {
    const { audio, cost } = totals();
    const elapsed = Math.max(0, clock() - meetingStart);
    const projected =
      elapsed < minElapsed ? 0 : (cost / elapsed) * MS_PER_HOUR;
    return {
      activeProvider,
      perProvider: copyPerProvider(perProvider),
      totalAudioSeconds: audio,
      totalCostUsd: cost,
      elapsedMs: elapsed,
      projectedCostPerHourUsd: projected,
    };
  }

  function emit(snap: SttCostSnapshot): void {
    if (!onUpdate) return;
    try {
      onUpdate(snap);
    } catch {
      // Swallow consumer errors — telemetry-only by design (mirrors costGuard onAlert).
    }
  }

  function setActiveProvider(provider: SttProviderId): SttCostSnapshot {
    if (!isSttProviderId(provider)) {
      // Defensive — bad input from a caller that bypassed the type check (e.g. user
      // settings JSON with a bogus value). Snapshot stays unchanged.
      return buildSnapshot();
    }
    if (activeProvider === provider) {
      return buildSnapshot();
    }
    activeProvider = provider;
    const snap = buildSnapshot();
    emit(snap);
    return snap;
  }

  function recordAudioSeconds(
    audioSeconds: number,
    providerOverride?: SttProviderId,
  ): SttCostSnapshot {
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
      return buildSnapshot();
    }
    const provider = providerOverride ?? activeProvider;
    if (!provider) {
      return buildSnapshot();
    }
    const cost = computeSttCostUsd(provider, audioSeconds);
    perProvider[provider].audioSeconds += audioSeconds;
    perProvider[provider].costUsd += cost;
    const snap = buildSnapshot();
    emit(snap);
    return snap;
  }

  function recordTranscriptChunk(
    chunk: TranscriptChunk,
    providerOverride?: SttProviderId,
  ): SttCostSnapshot {
    const seconds = (chunk.endTs - chunk.startTs) / 1000;
    return recordAudioSeconds(seconds, providerOverride);
  }

  function snapshot(): SttCostSnapshot {
    return buildSnapshot();
  }

  function reset(): void {
    perProvider = emptyPerProvider();
    meetingStart = clock();
    // activeProvider preserved — picker selection survives reset.
    emit(buildSnapshot());
  }

  function getActiveProvider(): SttProviderId | null {
    return activeProvider;
  }

  return {
    setActiveProvider,
    getActiveProvider,
    recordAudioSeconds,
    recordTranscriptChunk,
    snapshot,
    reset,
  };
}
