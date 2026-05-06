// Phase 3 T-3.5 — Stream wiring test for the STT cost meter.
//
// AC traceability:
//   AS-S1 — subscribes to `transcript:chunk` and feeds chunks into the meter
//   AS-S2 — returned UnlistenFn propagates from subscribeTranscriptStream
//   AS-S3 — providerForChunk override routes a chunk to a different counter

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptChunk } from "../../shared/types";

const listeners: Array<(chunk: TranscriptChunk) => void> = [];
const unlistenSpy = vi.fn();

vi.mock("../hooks/useTranscriptStream", () => ({
  TRANSCRIPT_CHUNK_EVENT: "transcript:chunk",
  subscribeTranscriptStream: vi.fn(
    async (handler: (chunk: TranscriptChunk) => void) => {
      listeners.push(handler);
      return unlistenSpy;
    },
  ),
}));

const { attachSttCostMeter } = await import("./attachSttCostMeter");
const { createSttCostMeter } = await import("./sttCostMeter");

function fireChunk(payload: TranscriptChunk) {
  for (const handler of listeners) handler(payload);
}

beforeEach(() => {
  listeners.length = 0;
  unlistenSpy.mockClear();
});

afterEach(() => {
  listeners.length = 0;
});

describe("AS-S1: subscribes to transcript:chunk and feeds chunks to the meter", () => {
  it("each emitted chunk lands on the active provider's counter", async () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    const stop = await attachSttCostMeter(meter);
    expect(typeof stop).toBe("function");
    expect(listeners.length).toBe(1);

    fireChunk({
      id: "m1-0",
      meetingId: "m1",
      text: "first",
      startTs: 0,
      endTs: 2_000,
      isFinal: true,
    });
    fireChunk({
      id: "m1-1",
      meetingId: "m1",
      text: "second",
      startTs: 2_000,
      endTs: 4_000,
      isFinal: true,
    });

    const snap = meter.snapshot();
    // 2 × 2_000 ms chunks → 4 audio-seconds attributed to Deepgram.
    expect(snap.perProvider.deepgram.audioSeconds).toBe(4);
    expect(snap.perProvider.deepgram.costUsd).toBeGreaterThan(0);
    expect(snap.totalAudioSeconds).toBe(4);
  });
});

describe("AS-S2: returned UnlistenFn propagates from subscribeTranscriptStream", () => {
  it("calling stop() invokes the inner unlisten exactly once", async () => {
    const meter = createSttCostMeter({ initialProvider: "mlx" });
    const stop = await attachSttCostMeter(meter);
    stop();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});

describe("AS-S3: providerForChunk override routes per-chunk attribution", () => {
  it("resolver returning ElevenLabs charges the elevenlabs counter even when active is MLX", async () => {
    const meter = createSttCostMeter({ initialProvider: "mlx" });
    await attachSttCostMeter(meter, {
      providerForChunk: () => "elevenlabs",
    });

    fireChunk({
      id: "m1-0",
      meetingId: "m1",
      text: "x",
      startTs: 0,
      endTs: 60_000, // 1 minute
      isFinal: true,
    });

    const snap = meter.snapshot();
    expect(snap.perProvider.mlx.audioSeconds).toBe(0);
    expect(snap.perProvider.elevenlabs.audioSeconds).toBe(60);
    expect(snap.perProvider.elevenlabs.costUsd).toBeGreaterThan(0);
  });

  it("resolver returning null falls back to the meter's active provider", async () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    await attachSttCostMeter(meter, {
      providerForChunk: () => null,
    });

    fireChunk({
      id: "m1-0",
      meetingId: "m1",
      text: "x",
      startTs: 0,
      endTs: 2_000,
      isFinal: true,
    });

    expect(meter.snapshot().perProvider.deepgram.audioSeconds).toBe(2);
  });
});
