// Phase 3 T-3.5 — STT cost meter unit tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.5-cost-meter.md):
//   SCM-S1..S2  — construction (default + initialProvider)
//   SCM-S3..S6  — recordAudioSeconds path (no-op + active provider + override + zero-cost MLX)
//   SCM-S7..S8  — provider-switch + cumulative monotonic (the AC bullet)
//   SCM-S9..S11 — recordTranscriptChunk derivation + defensive paths
//   SCM-S12..S13 — projection warm-up gate + math
//   SCM-S14..S15 — reset
//   SCM-S16..S17 — onUpdate event sink + defensive snapshot copies
//   SCM-S18..S20 — independence + per-provider integrity + quiet path

import { describe, expect, it, vi } from "vitest";

import type { TranscriptChunk } from "../../shared/types";
import {
  computeSttCostUsd,
  DEEPGRAM_USD_PER_MINUTE,
  ELEVENLABS_USD_PER_MINUTE,
  STT_PROVIDER_IDS,
} from "../llm/sttPricing";
import {
  createSttCostMeter,
  DEFAULT_MIN_ELAPSED_MS,
  type SttCostSnapshot,
} from "./sttCostMeter";

const MS_PER_HOUR = 3_600_000;

function fixedClock(initial: number) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
    current: () => t,
  };
}

function makeChunk(partial: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    id: "m1-0",
    meetingId: "m1",
    text: "hello",
    startTs: 0,
    endTs: 2_000,
    isFinal: true,
    ...partial,
  };
}

// ── Construction (SCM-S1..S2) ───────────────────────────────────────────────

describe("SCM-S1: default construction", () => {
  it("counters zero, activeProvider null, projected $/h = 0", () => {
    const meter = createSttCostMeter();
    const snap = meter.snapshot();
    expect(snap.activeProvider).toBeNull();
    expect(snap.totalAudioSeconds).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.projectedCostPerHourUsd).toBe(0);
    for (const id of STT_PROVIDER_IDS) {
      expect(snap.perProvider[id].audioSeconds).toBe(0);
      expect(snap.perProvider[id].costUsd).toBe(0);
    }
    expect(typeof meter.recordAudioSeconds).toBe("function");
    expect(typeof meter.recordTranscriptChunk).toBe("function");
    expect(typeof meter.setActiveProvider).toBe("function");
    expect(typeof meter.getActiveProvider).toBe("function");
    expect(typeof meter.snapshot).toBe("function");
    expect(typeof meter.reset).toBe("function");
  });
});

describe("SCM-S2: initialProvider option", () => {
  it("activeProvider matches initialProvider on construction", () => {
    const meter = createSttCostMeter({ initialProvider: "mlx" });
    expect(meter.getActiveProvider()).toBe("mlx");
    expect(meter.snapshot().activeProvider).toBe("mlx");
  });
});

// ── Record path (SCM-S3..S6) ────────────────────────────────────────────────

describe("SCM-S3: recordAudioSeconds with no active provider + no override is a no-op", () => {
  it("counters stay zero", () => {
    const meter = createSttCostMeter();
    const snap = meter.recordAudioSeconds(60);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.totalAudioSeconds).toBe(0);
  });

  it("does NOT fire onUpdate", () => {
    const onUpdate = vi.fn();
    const meter = createSttCostMeter({ onUpdate });
    meter.recordAudioSeconds(60);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("SCM-S4: setActiveProvider then record charges the active provider", () => {
  it("Deepgram active → 60s charged at $0.0043", () => {
    const meter = createSttCostMeter();
    meter.setActiveProvider("deepgram");
    const snap = meter.recordAudioSeconds(60);
    expect(snap.activeProvider).toBe("deepgram");
    expect(snap.perProvider.deepgram.audioSeconds).toBe(60);
    expect(snap.perProvider.deepgram.costUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
    expect(snap.totalCostUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
  });
});

describe("SCM-S5: providerOverride routes to a different counter", () => {
  it("override charges ElevenLabs even when active is MLX", () => {
    const meter = createSttCostMeter({ initialProvider: "mlx" });
    const snap = meter.recordAudioSeconds(60, "elevenlabs");
    expect(snap.perProvider.mlx.audioSeconds).toBe(0);
    expect(snap.perProvider.elevenlabs.audioSeconds).toBe(60);
    expect(snap.perProvider.elevenlabs.costUsd).toBeCloseTo(ELEVENLABS_USD_PER_MINUTE, 9);
    // activeProvider stays MLX — override does NOT mutate selection.
    expect(snap.activeProvider).toBe("mlx");
  });
});

describe("SCM-S6: MLX records audio seconds but cost stays $0", () => {
  it("60s MLX → audioSeconds=60, costUsd=0", () => {
    const meter = createSttCostMeter({ initialProvider: "mlx" });
    const snap = meter.recordAudioSeconds(60);
    expect(snap.perProvider.mlx.audioSeconds).toBe(60);
    expect(snap.perProvider.mlx.costUsd).toBe(0);
    expect(snap.totalAudioSeconds).toBe(60);
    expect(snap.totalCostUsd).toBe(0);
  });
});

// ── Provider switch + monotonic (SCM-S7..S8) — THE AC BULLET ────────────────

describe("SCM-S7: switch MLX → Deepgram → cumulative cost increases at expected rate", () => {
  it("ARCH §3.2 cost ladder reflected across a session", () => {
    const meter = createSttCostMeter();
    // Phase A — MLX active for 60s. Cumulative cost stays 0.
    meter.setActiveProvider("mlx");
    let snap = meter.recordAudioSeconds(60);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.totalAudioSeconds).toBe(60);

    // Phase B — switch to Deepgram, record 60s. Cumulative cost jumps to $0.0043.
    meter.setActiveProvider("deepgram");
    snap = meter.recordAudioSeconds(60);
    expect(snap.totalCostUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
    expect(snap.totalAudioSeconds).toBe(120);

    // Phase C — switch back to MLX, record 60s. Cumulative cost stays at $0.0043
    // (MLX adds seconds but no cost).
    meter.setActiveProvider("mlx");
    snap = meter.recordAudioSeconds(60);
    expect(snap.totalCostUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
    expect(snap.totalAudioSeconds).toBe(180);

    // Phase D — switch to ElevenLabs, record 60s. Total = Deepgram + ElevenLabs/min.
    meter.setActiveProvider("elevenlabs");
    snap = meter.recordAudioSeconds(60);
    expect(snap.totalCostUsd).toBeCloseTo(
      DEEPGRAM_USD_PER_MINUTE + ELEVENLABS_USD_PER_MINUTE,
      9,
    );

    // Per-provider attribution intact across the run.
    expect(snap.perProvider.mlx.audioSeconds).toBe(120);
    expect(snap.perProvider.mlx.costUsd).toBe(0);
    expect(snap.perProvider.deepgram.audioSeconds).toBe(60);
    expect(snap.perProvider.deepgram.costUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
    expect(snap.perProvider.elevenlabs.audioSeconds).toBe(60);
    expect(snap.perProvider.elevenlabs.costUsd).toBeCloseTo(ELEVENLABS_USD_PER_MINUTE, 9);
  });
});

describe("SCM-S8: cumulative total never decreases across a sequence of records", () => {
  it("monotonic over 100 mixed records", () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      // Alternate providers; some are zero-cost MLX records.
      if (i % 3 === 0) meter.setActiveProvider("mlx");
      else if (i % 3 === 1) meter.setActiveProvider("deepgram");
      else meter.setActiveProvider("elevenlabs");
      const snap = meter.recordAudioSeconds(2);
      expect(snap.totalCostUsd).toBeGreaterThanOrEqual(prev);
      expect(snap.totalAudioSeconds).toBeGreaterThanOrEqual(0);
      prev = snap.totalCostUsd;
    }
  });
});

// ── Transcript-chunk path (SCM-S9..S11) ─────────────────────────────────────

describe("SCM-S9: recordTranscriptChunk derives audio seconds from endTs - startTs", () => {
  it("a 2_000 ms chunk → 2 audio-seconds", () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    const snap = meter.recordTranscriptChunk(makeChunk({ startTs: 0, endTs: 2_000 }));
    expect(snap.perProvider.deepgram.audioSeconds).toBe(2);
    expect(snap.perProvider.deepgram.costUsd).toBeCloseTo(
      computeSttCostUsd("deepgram", 2),
      12,
    );
  });
});

describe("SCM-S10: negative-duration chunk is a no-op", () => {
  it("counters unchanged when endTs < startTs", () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    const snap = meter.recordTranscriptChunk(
      makeChunk({ startTs: 5_000, endTs: 4_000 }),
    );
    expect(snap.totalAudioSeconds).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
  });

  it("zero-duration chunk is a no-op", () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    const snap = meter.recordTranscriptChunk(
      makeChunk({ startTs: 1_000, endTs: 1_000 }),
    );
    expect(snap.totalAudioSeconds).toBe(0);
  });
});

describe("SCM-S11: out-of-order chunks accumulate seconds additively", () => {
  it("two chunks landing in reverse order both count", () => {
    const meter = createSttCostMeter({ initialProvider: "elevenlabs" });
    meter.recordTranscriptChunk(makeChunk({ startTs: 4_000, endTs: 6_000 }));
    meter.recordTranscriptChunk(makeChunk({ startTs: 0, endTs: 2_000 }));
    const snap = meter.snapshot();
    expect(snap.perProvider.elevenlabs.audioSeconds).toBe(4);
    expect(snap.perProvider.elevenlabs.costUsd).toBeCloseTo(
      computeSttCostUsd("elevenlabs", 4),
      12,
    );
  });
});

// ── Projection (SCM-S12..S13) ───────────────────────────────────────────────

describe("SCM-S12: projection inside warm-up window returns 0", () => {
  it("at 30s elapsed the projection is 0 even with cost recorded", () => {
    const clock = fixedClock(0);
    const meter = createSttCostMeter({
      initialProvider: "deepgram",
      meetingStartTs: 0,
      now: clock.now,
      minElapsedMsForProjection: DEFAULT_MIN_ELAPSED_MS, // 60_000 ms
    });
    clock.advance(30_000);
    const snap = meter.recordAudioSeconds(60);
    expect(snap.elapsedMs).toBe(30_000);
    expect(snap.projectedCostPerHourUsd).toBe(0);
    expect(snap.totalCostUsd).toBeGreaterThan(0);
  });
});

describe("SCM-S13: projection outside warm-up uses (cost / elapsed) × 1h", () => {
  it("at 1 hour elapsed with $0.0043 cost, projection ≈ $0.0043/h", () => {
    const clock = fixedClock(0);
    const meter = createSttCostMeter({
      initialProvider: "deepgram",
      meetingStartTs: 0,
      now: clock.now,
      minElapsedMsForProjection: 0, // disable warm-up
    });
    meter.recordAudioSeconds(60); // $0.0043
    clock.advance(MS_PER_HOUR);
    const snap = meter.snapshot();
    expect(snap.projectedCostPerHourUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
  });

  it("at 30 min elapsed with $0.0043 cost, projection ≈ $0.0086/h (half-elapsed = double-rate)", () => {
    const clock = fixedClock(0);
    const meter = createSttCostMeter({
      initialProvider: "deepgram",
      meetingStartTs: 0,
      now: clock.now,
      minElapsedMsForProjection: 0,
    });
    meter.recordAudioSeconds(60); // $0.0043 in the first 0 ms
    clock.advance(MS_PER_HOUR / 2);
    const snap = meter.snapshot();
    expect(snap.projectedCostPerHourUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE * 2, 9);
  });
});

// ── Reset (SCM-S14..S15) ────────────────────────────────────────────────────

describe("SCM-S14: reset zeroes counters and advances meetingStart", () => {
  it("post-reset elapsed === 0 and counters zero", () => {
    const clock = fixedClock(1_000);
    const meter = createSttCostMeter({
      initialProvider: "deepgram",
      meetingStartTs: 1_000,
      now: clock.now,
    });
    clock.advance(MS_PER_HOUR);
    meter.recordAudioSeconds(60);
    expect(meter.snapshot().totalCostUsd).toBeGreaterThan(0);

    clock.advance(5_000);
    meter.reset();
    const snap = meter.snapshot();
    expect(snap.totalAudioSeconds).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.elapsedMs).toBe(0);
    expect(snap.perProvider.deepgram.audioSeconds).toBe(0);
    expect(snap.perProvider.deepgram.costUsd).toBe(0);
  });
});

describe("SCM-S15: reset preserves activeProvider", () => {
  it("picker selection survives reset", () => {
    const meter = createSttCostMeter();
    meter.setActiveProvider("elevenlabs");
    meter.recordAudioSeconds(60);
    meter.reset();
    expect(meter.getActiveProvider()).toBe("elevenlabs");
    expect(meter.snapshot().activeProvider).toBe("elevenlabs");
  });
});

// ── Event sink (SCM-S16..S17) ───────────────────────────────────────────────

describe("SCM-S16: onUpdate fires after every state-mutating call", () => {
  it("fires once per record + once per reset + once per setActiveProvider change", () => {
    const onUpdate = vi.fn();
    const meter = createSttCostMeter({ initialProvider: "deepgram", onUpdate });

    meter.recordAudioSeconds(60); // 1
    meter.recordAudioSeconds(60); // 2
    meter.setActiveProvider("elevenlabs"); // 3 — change
    meter.setActiveProvider("elevenlabs"); // no-op (already active)
    meter.recordAudioSeconds(60); // 4
    meter.reset(); // 5

    expect(onUpdate).toHaveBeenCalledTimes(5);
    // Last snapshot reflects the post-reset state.
    const last = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0] as SttCostSnapshot;
    expect(last.totalCostUsd).toBe(0);
    expect(last.totalAudioSeconds).toBe(0);
    expect(last.activeProvider).toBe("elevenlabs");
  });

  it("throwing onUpdate is swallowed (does not break record path)", () => {
    const meter = createSttCostMeter({
      initialProvider: "deepgram",
      onUpdate: () => {
        throw new Error("hostile callback");
      },
    });
    expect(() => meter.recordAudioSeconds(60)).not.toThrow();
    expect(meter.snapshot().totalCostUsd).toBeGreaterThan(0);
  });
});

describe("SCM-S17: snapshot returns defensive copies", () => {
  it("mutating a returned snapshot does not corrupt the next one", () => {
    const meter = createSttCostMeter({ initialProvider: "deepgram" });
    meter.recordAudioSeconds(60);
    const snap1 = meter.snapshot();
    snap1.perProvider.deepgram.audioSeconds = 99_999;
    snap1.perProvider.deepgram.costUsd = 99_999;
    snap1.totalCostUsd = 99_999;
    const snap2 = meter.snapshot();
    expect(snap2.perProvider.deepgram.audioSeconds).toBe(60);
    expect(snap2.perProvider.deepgram.costUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
    expect(snap2.totalCostUsd).toBeCloseTo(DEEPGRAM_USD_PER_MINUTE, 9);
  });
});

// ── Independence + integrity + quiet path (SCM-S18..S20) ────────────────────

describe("SCM-S18: per-provider counter sum equals total", () => {
  it("totals match sum of per-provider entries to 12 decimals", () => {
    const meter = createSttCostMeter();
    meter.setActiveProvider("deepgram");
    meter.recordAudioSeconds(120);
    meter.setActiveProvider("elevenlabs");
    meter.recordAudioSeconds(60);
    meter.setActiveProvider("mlx");
    meter.recordAudioSeconds(300);
    const snap = meter.snapshot();
    const sumAudio =
      snap.perProvider.mlx.audioSeconds +
      snap.perProvider.fake.audioSeconds +
      snap.perProvider.deepgram.audioSeconds +
      snap.perProvider.elevenlabs.audioSeconds;
    const sumCost =
      snap.perProvider.mlx.costUsd +
      snap.perProvider.fake.costUsd +
      snap.perProvider.deepgram.costUsd +
      snap.perProvider.elevenlabs.costUsd;
    expect(snap.totalAudioSeconds).toBeCloseTo(sumAudio, 12);
    expect(snap.totalCostUsd).toBeCloseTo(sumCost, 12);
  });
});

describe("SCM-S19: independent meters do not share state", () => {
  it("two instances accumulate separately", () => {
    const a = createSttCostMeter({ initialProvider: "deepgram" });
    const b = createSttCostMeter({ initialProvider: "deepgram" });
    a.recordAudioSeconds(60);
    expect(a.snapshot().totalCostUsd).toBeGreaterThan(0);
    expect(b.snapshot().totalCostUsd).toBe(0);
  });
});

describe("SCM-S20: zero-second record is a quiet no-op", () => {
  it("does not fire onUpdate", () => {
    const onUpdate = vi.fn();
    const meter = createSttCostMeter({ initialProvider: "deepgram", onUpdate });
    meter.recordAudioSeconds(0);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(meter.snapshot().totalAudioSeconds).toBe(0);
  });

  it("non-finite seconds are quiet no-ops", () => {
    const onUpdate = vi.fn();
    const meter = createSttCostMeter({ initialProvider: "deepgram", onUpdate });
    meter.recordAudioSeconds(Number.NaN);
    meter.recordAudioSeconds(Number.POSITIVE_INFINITY);
    meter.recordAudioSeconds(-5);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
