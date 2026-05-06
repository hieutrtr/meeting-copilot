// Phase 3 T-3.5 — Stream wiring: attach an `SttCostMeter` to the existing
// `transcript:chunk` Tauri event. Surfaces cost events out of the provider event
// stream without modifying `subscribeTranscriptStream` (Phase 1 T-1.6 seam).
//
// Use case: Settings sheet (T-3.6) builds a meter, calls `setActiveProvider`
// when the picker changes, and calls `attachSttCostMeter(meter)` once per session
// to start charging audio seconds. The returned `UnlistenFn` hangs off the
// React effect cleanup.

import type { UnlistenFn } from "@tauri-apps/api/event";

import type { TranscriptChunk } from "../../shared/types";
import { subscribeTranscriptStream } from "../hooks/useTranscriptStream";
import type { SttProviderId } from "../llm/sttPricing";
import type { SttCostMeter } from "./sttCostMeter";

export interface AttachSttCostMeterOptions {
  /**
   * Resolve the provider that should be charged for a given chunk. Returning `null`
   * (or omitting the resolver entirely) falls back to the meter's `activeProvider`.
   * Forward-compat hook for T-3.9 telemetry: per-segment attribution if
   * `TranscriptChunk` ever carries a `provider` field.
   */
  providerForChunk?: (chunk: TranscriptChunk) => SttProviderId | null;
}

export async function attachSttCostMeter(
  meter: SttCostMeter,
  opts?: AttachSttCostMeterOptions,
): Promise<UnlistenFn> {
  const resolve = opts?.providerForChunk;
  return await subscribeTranscriptStream((chunk) => {
    const override = resolve?.(chunk) ?? undefined;
    meter.recordTranscriptChunk(chunk, override ?? undefined);
  });
}
