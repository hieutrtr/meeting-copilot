// Phase 2 T-2.7 — Cost guard unit tests.
//
// AC traceability (see docs/tasks/phase-2/T-2.7-cost-guard.md):
//   CG-S1..S3   — construction (default + custom threshold + paused init)
//   CG-S4..S8   — counter math (AC-1, AC-2, AC-3)
//   CG-S9..S15  — threshold latch + warm-up gate (AC-4..AC-7, AC-13)
//   CG-S16..S19 — pause flag (AC-8, AC-9)
//   CG-S20..S22 — reset (AC-10)
//   CG-S23..S25 — defensive paths (AC-14)
//   CG-S26..S30 — guardedClassifyWithHaiku composer (AC-11, AC-12)

import { describe, expect, it, vi } from "vitest";

import {
  computeCostUsd,
  computeHaikuCostUsd,
  type AnthropicUsage,
} from "../llm/pricing";
import {
  createCostGuard,
  DEFAULT_MIN_ELAPSED_MS,
  DEFAULT_THRESHOLD_USD_PER_HOUR,
  guardedClassifyWithHaiku,
} from "./costGuard";

const MS_PER_HOUR = 3_600_000;

// ── Clock helper ────────────────────────────────────────────────────────────

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

// ── Construction (CG-S1..S3) ────────────────────────────────────────────────

describe("CG-S1: createCostGuard default construction", () => {
  it("returns a guard with all counters zero, paused=false, no latch, $0.50/h threshold", () => {
    const guard = createCostGuard();
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(0);
    expect(snap.haiku.costUsd).toBe(0);
    expect(snap.sonnet.calls).toBe(0);
    expect(snap.sonnet.costUsd).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.thresholdCrossed).toBe(false);
    expect(snap.paused).toBe(false);
    expect(snap.thresholdUsdPerHour).toBe(DEFAULT_THRESHOLD_USD_PER_HOUR);
    expect(snap.thresholdUsdPerHour).toBe(0.5);
    expect(typeof guard.recordHaikuUsage).toBe("function");
    expect(typeof guard.recordSonnetUsage).toBe("function");
    expect(typeof guard.setPaused).toBe("function");
    expect(typeof guard.isPaused).toBe("function");
    expect(typeof guard.reset).toBe("function");
  });
});

describe("CG-S2: custom thresholdUsdPerHour", () => {
  it("reflects the custom threshold in snapshot", () => {
    const guard = createCostGuard({ thresholdUsdPerHour: 1.25 });
    expect(guard.snapshot().thresholdUsdPerHour).toBe(1.25);
  });
});

describe("CG-S3: paused: true initial option", () => {
  it("starts paused when option is true", () => {
    const guard = createCostGuard({ paused: true });
    expect(guard.isPaused()).toBe(true);
    expect(guard.snapshot().paused).toBe(true);
  });
});

// ── Counter math (CG-S4..S8) ────────────────────────────────────────────────

describe("CG-S4: recordHaikuUsage updates counters via computeHaikuCostUsd", () => {
  it("increments calls + tokens + cost on a single record", () => {
    const guard = createCostGuard();
    const usage: AnthropicUsage = {
      input_tokens: 150,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
      output_tokens: 30,
    };
    guard.recordHaikuUsage(usage);
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(1);
    expect(snap.haiku.inputTokens).toBe(150);
    expect(snap.haiku.cacheCreationTokens).toBe(100);
    expect(snap.haiku.cacheReadTokens).toBe(200);
    expect(snap.haiku.outputTokens).toBe(30);
    expect(snap.haiku.costUsd).toBeCloseTo(computeHaikuCostUsd(usage), 12);
  });
});

describe("CG-S5: recordHaikuUsage sums across multiple calls", () => {
  it("sums tokens and cost across 3 records", () => {
    const guard = createCostGuard();
    const u1: AnthropicUsage = { input_tokens: 100, output_tokens: 20 };
    const u2: AnthropicUsage = {
      input_tokens: 50,
      cache_read_input_tokens: 1_000,
      output_tokens: 10,
    };
    const u3: AnthropicUsage = {
      input_tokens: 200,
      cache_creation_input_tokens: 500,
      output_tokens: 40,
    };
    guard.recordHaikuUsage(u1);
    guard.recordHaikuUsage(u2);
    guard.recordHaikuUsage(u3);
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(3);
    expect(snap.haiku.inputTokens).toBe(350);
    expect(snap.haiku.cacheCreationTokens).toBe(500);
    expect(snap.haiku.cacheReadTokens).toBe(1_000);
    expect(snap.haiku.outputTokens).toBe(70);
    const expectedCost =
      computeHaikuCostUsd(u1) + computeHaikuCostUsd(u2) + computeHaikuCostUsd(u3);
    expect(snap.haiku.costUsd).toBeCloseTo(expectedCost, 12);
  });
});

describe("CG-S6: recordSonnetUsage uses computeCostUsd (Sonnet pricing)", () => {
  it("1 MTok input → cost === $3.0 (Sonnet uncached rate)", () => {
    const guard = createCostGuard();
    guard.recordSonnetUsage({ input_tokens: 1_000_000, output_tokens: 0 });
    expect(guard.snapshot().sonnet.costUsd).toBeCloseTo(3.0, 6);
  });

  it("Sonnet recording does NOT touch the Haiku counter", () => {
    const guard = createCostGuard();
    guard.recordSonnetUsage({ input_tokens: 100, output_tokens: 50 });
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(0);
    expect(snap.haiku.costUsd).toBe(0);
    expect(snap.sonnet.calls).toBe(1);
    expect(snap.sonnet.costUsd).toBeGreaterThan(0);
  });
});

describe("CG-S7: totalCostUsd === haiku.costUsd + sonnet.costUsd", () => {
  it("sums correctly across mixed records", () => {
    const guard = createCostGuard();
    guard.recordHaikuUsage({ input_tokens: 1_000, output_tokens: 100 });
    guard.recordSonnetUsage({ input_tokens: 500, output_tokens: 200 });
    guard.recordHaikuUsage({ input_tokens: 2_000, output_tokens: 50 });
    const snap = guard.snapshot();
    expect(snap.totalCostUsd).toBeCloseTo(
      snap.haiku.costUsd + snap.sonnet.costUsd,
      12,
    );
  });
});

describe("CG-S8: independent guards do not share state", () => {
  it("two guards have separate counters", () => {
    const a = createCostGuard();
    const b = createCostGuard();
    a.recordHaikuUsage({ input_tokens: 100, output_tokens: 10 });
    expect(a.snapshot().haiku.calls).toBe(1);
    expect(b.snapshot().haiku.calls).toBe(0);
  });
});

// ── Threshold latch (CG-S9..S15) ────────────────────────────────────────────

describe("CG-S9: threshold-crossing alert fires exactly once (AC-4)", () => {
  it("fires on first crossing, not on subsequent records past threshold", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0, // disable warm-up for this test
    });
    // Advance to 1 hour elapsed.
    clock.advance(MS_PER_HOUR);
    // $0.51 in 1 h → projection $0.51/h > $0.50 → fire.
    // Use Sonnet output: $15/MTok output → 34_000 output tokens = $0.51.
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 34_000 });
    expect(onAlert).toHaveBeenCalledTimes(1);
    // Subsequent records should NOT re-fire.
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 1_000 });
    guard.recordHaikuUsage({ input_tokens: 1_000, output_tokens: 100 });
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

describe("CG-S10: below-threshold record does NOT fire alert (AC-5)", () => {
  it("does not fire when projection < threshold", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0,
    });
    clock.advance(MS_PER_HOUR);
    // $0.30 in 1 h → projection $0.30/h < $0.50 → no fire.
    // 20_000 output tokens × $15/MTok = $0.30 (Sonnet).
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 20_000 });
    expect(onAlert).not.toHaveBeenCalled();
    expect(guard.snapshot().thresholdCrossed).toBe(false);
  });
});

describe("CG-S11: alert callback receives snapshot with thresholdCrossed=true (AC-6)", () => {
  it("fired snapshot has thresholdCrossed=true and projection > threshold", () => {
    const clock = fixedClock(1_000);
    let captured: ReturnType<ReturnType<typeof createCostGuard>["snapshot"]> | null =
      null;
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert: (snap) => {
        captured = snap;
      },
      minElapsedMsForProjection: 0,
    });
    clock.advance(MS_PER_HOUR);
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 50_000 });
    expect(captured).not.toBeNull();
    expect(captured!.thresholdCrossed).toBe(true);
    expect(captured!.projectedCostPerHourUsd).toBeGreaterThan(0.5);
    expect(captured!.totalCostUsd).toBeGreaterThan(0.5);
  });
});

describe("CG-S12: default threshold is $0.50/h (AC-13)", () => {
  it("default snapshot.thresholdUsdPerHour === 0.5", () => {
    expect(createCostGuard().snapshot().thresholdUsdPerHour).toBe(0.5);
  });
});

describe("CG-S13: warm-up window suppresses false alarms (AC-7)", () => {
  it("inside warm-up: projection=0, no alert; outside warm-up: projection real, alert may fire", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: DEFAULT_MIN_ELAPSED_MS, // 60_000
    });
    // Inside warm-up — only 30 seconds elapsed.
    clock.advance(30_000);
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 100_000 }); // $1.50 cost
    expect(guard.snapshot().projectedCostPerHourUsd).toBe(0);
    expect(onAlert).not.toHaveBeenCalled();
    // Cross the warm-up boundary.
    clock.advance(70_000); // total elapsed = 100_000 ms
    // Projection now = $1.50 / 100_000 ms × 3_600_000 = $54/h → way over.
    guard.recordHaikuUsage({ input_tokens: 1, output_tokens: 1 });
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

describe("CG-S14: minElapsedMsForProjection: 0 disables warm-up", () => {
  it("projection is computed even at very short elapsed when warm-up is 0", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0,
    });
    clock.advance(1); // 1 ms elapsed, but warm-up is 0
    // 1 token Sonnet output @ $15/MTok = $0.000015. Projection = $0.000015 / 1 ms × 3_600_000 = $54/h.
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 1 });
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

describe("CG-S15: Sonnet-only crossing fires alert (AC-4)", () => {
  it("alert fires from Sonnet alone with no Haiku activity", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0,
    });
    clock.advance(MS_PER_HOUR);
    // $0.60 Sonnet cost only → above threshold.
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 40_000 });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(guard.snapshot().haiku.calls).toBe(0);
  });
});

// ── Pause flag (CG-S16..S19) ────────────────────────────────────────────────

describe("CG-S16: setPaused round-trips (AC-8)", () => {
  it("setPaused(true) → isPaused() === true; setPaused(false) reverses", () => {
    const guard = createCostGuard();
    expect(guard.isPaused()).toBe(false);
    guard.setPaused(true);
    expect(guard.isPaused()).toBe(true);
    expect(guard.snapshot().paused).toBe(true);
    guard.setPaused(false);
    expect(guard.isPaused()).toBe(false);
    expect(guard.snapshot().paused).toBe(false);
  });
});

describe("CG-S17: paused: true initial option respected (AC-8)", () => {
  it("starts paused", () => {
    const guard = createCostGuard({ paused: true });
    expect(guard.isPaused()).toBe(true);
  });
});

describe("CG-S18: paused state does NOT prevent recording (AC-9)", () => {
  it("recordHaikuUsage still increments counters when paused", () => {
    const guard = createCostGuard({ paused: true });
    guard.recordHaikuUsage({ input_tokens: 100, output_tokens: 20 });
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(1);
    expect(snap.haiku.inputTokens).toBe(100);
    expect(snap.paused).toBe(true);
  });
});

describe("CG-S19: snapshot.paused reflects current pause state", () => {
  it("snapshot.paused mirrors setPaused", () => {
    const guard = createCostGuard();
    expect(guard.snapshot().paused).toBe(false);
    guard.setPaused(true);
    expect(guard.snapshot().paused).toBe(true);
  });
});

// ── Reset (CG-S20..S22) ─────────────────────────────────────────────────────

describe("CG-S20: reset() zeroes counters + un-latches alert (AC-10)", () => {
  it("post-reset snapshot has zeroed counters and thresholdCrossed=false", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0,
    });
    clock.advance(MS_PER_HOUR);
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 50_000 });
    expect(onAlert).toHaveBeenCalledTimes(1);
    // Advance + reset.
    clock.advance(1_000);
    guard.reset();
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(0);
    expect(snap.haiku.costUsd).toBe(0);
    expect(snap.sonnet.calls).toBe(0);
    expect(snap.sonnet.costUsd).toBe(0);
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.thresholdCrossed).toBe(false);
    // meetingStart advanced to current clock — elapsed is 0 immediately after reset.
    expect(snap.elapsedMs).toBe(0);
  });
});

describe("CG-S21: alert can fire again post-reset (AC-10)", () => {
  it("re-feeds same usage after reset → second alert fires", () => {
    const clock = fixedClock(1_000);
    const onAlert = vi.fn();
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert,
      minElapsedMsForProjection: 0,
    });
    // First crossing.
    clock.advance(MS_PER_HOUR);
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 50_000 });
    expect(onAlert).toHaveBeenCalledTimes(1);
    // Reset, advance by another hour, cross again.
    guard.reset();
    clock.advance(MS_PER_HOUR);
    guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 50_000 });
    expect(onAlert).toHaveBeenCalledTimes(2);
  });
});

describe("CG-S22: reset() does NOT change threshold or pause flag", () => {
  it("threshold and paused state survive reset", () => {
    const clock = fixedClock(1_000);
    const guard = createCostGuard({
      thresholdUsdPerHour: 1.25,
      paused: true,
      now: clock.now,
    });
    guard.reset();
    const snap = guard.snapshot();
    expect(snap.thresholdUsdPerHour).toBe(1.25);
    expect(snap.paused).toBe(true);
  });
});

// ── Defensive paths (CG-S23..S25) ───────────────────────────────────────────

describe("CG-S23: onAlert callback throw does not propagate (AC-14)", () => {
  it("throwing onAlert is swallowed", () => {
    const clock = fixedClock(1_000);
    const guard = createCostGuard({
      thresholdUsdPerHour: 0.5,
      now: clock.now,
      onAlert: () => {
        throw new Error("hostile callback");
      },
      minElapsedMsForProjection: 0,
    });
    clock.advance(MS_PER_HOUR);
    expect(() =>
      guard.recordSonnetUsage({ input_tokens: 0, output_tokens: 50_000 }),
    ).not.toThrow();
    // Latch still set even though callback threw.
    expect(guard.snapshot().thresholdCrossed).toBe(true);
  });
});

describe("CG-S24: snapshot returns defensive copies", () => {
  it("mutating a returned snapshot does not corrupt the next one", () => {
    const guard = createCostGuard();
    guard.recordHaikuUsage({ input_tokens: 100, output_tokens: 10 });
    const snap1 = guard.snapshot();
    snap1.haiku.calls = 99999;
    snap1.haiku.costUsd = 99999;
    const snap2 = guard.snapshot();
    expect(snap2.haiku.calls).toBe(1);
    expect(snap2.haiku.costUsd).toBeCloseTo(
      computeHaikuCostUsd({ input_tokens: 100, output_tokens: 10 }),
      12,
    );
  });
});

describe("CG-S25: missing optional usage fields treated as 0", () => {
  it("recording with no cache fields produces correct counters and cost", () => {
    const guard = createCostGuard();
    guard.recordHaikuUsage({ input_tokens: 100, output_tokens: 50 });
    const snap = guard.snapshot();
    expect(snap.haiku.cacheCreationTokens).toBe(0);
    expect(snap.haiku.cacheReadTokens).toBe(0);
    expect(snap.haiku.costUsd).toBeCloseTo(
      computeHaikuCostUsd({ input_tokens: 100, output_tokens: 50 }),
      12,
    );
  });
});

// ── Composer wrapper (CG-S26..S30) ──────────────────────────────────────────

interface FakeHaikuResult {
  isQuestion: boolean;
  confidence: number;
  reason: string;
  rawText: string;
  latencyMs: number;
  usage: AnthropicUsage;
  costUsd: number;
}

function makeFakeClassifier(
  result: FakeHaikuResult,
): { fn: (text: string, opts?: { apiKey?: string }) => Promise<FakeHaikuResult>; calls: Array<{ text: string; opts?: { apiKey?: string } }> } {
  const calls: Array<{ text: string; opts?: { apiKey?: string } }> = [];
  return {
    calls,
    fn: async (text: string, opts?: { apiKey?: string }) => {
      calls.push({ text, opts });
      return result;
    },
  };
}

describe("CG-S26: guardedClassifyWithHaiku short-circuits when paused (AC-11)", () => {
  it("paused → status=skipped-paused, classifier NOT invoked, no usage recorded", async () => {
    const guard = createCostGuard({ paused: true });
    const fakeUsage: AnthropicUsage = { input_tokens: 100, output_tokens: 10 };
    const { fn, calls } = makeFakeClassifier({
      isQuestion: true,
      confidence: 0.9,
      reason: "test",
      rawText: "YES test",
      latencyMs: 5,
      usage: fakeUsage,
      costUsd: computeHaikuCostUsd(fakeUsage),
    });
    const out = await guardedClassifyWithHaiku("hello?", fn, guard);
    expect(out.status).toBe("skipped-paused");
    expect(out.result).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(guard.snapshot().haiku.calls).toBe(0);
  });
});

describe("CG-S27: guardedClassifyWithHaiku invokes classifier when not paused (AC-12)", () => {
  it("not paused → status=classified, classifier invoked once, usage recorded", async () => {
    const guard = createCostGuard();
    const fakeUsage: AnthropicUsage = { input_tokens: 150, output_tokens: 30 };
    const fakeResult: FakeHaikuResult = {
      isQuestion: true,
      confidence: 0.9,
      reason: "deadline asked",
      rawText: "YES asks for deadline",
      latencyMs: 200,
      usage: fakeUsage,
      costUsd: computeHaikuCostUsd(fakeUsage),
    };
    const { fn, calls } = makeFakeClassifier(fakeResult);
    const out = await guardedClassifyWithHaiku("when's the deadline?", fn, guard);
    expect(out.status).toBe("classified");
    expect(out.result).toEqual(fakeResult);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toBe("when's the deadline?");
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(1);
    expect(snap.haiku.inputTokens).toBe(150);
    expect(snap.haiku.outputTokens).toBe(30);
    expect(snap.haiku.costUsd).toBeCloseTo(computeHaikuCostUsd(fakeUsage), 12);
  });
});

describe("CG-S28: wrapper passes opts through to inner classifier (AC-12)", () => {
  it("apiKey opt is forwarded verbatim", async () => {
    const guard = createCostGuard();
    const { fn, calls } = makeFakeClassifier({
      isQuestion: false,
      confidence: 0.1,
      reason: "no",
      rawText: "NO no",
      latencyMs: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
      costUsd: 0,
    });
    await guardedClassifyWithHaiku("hi", fn, guard, { apiKey: "sk-test-123" });
    expect(calls.length).toBe(1);
    expect(calls[0].opts).toEqual({ apiKey: "sk-test-123" });
  });
});

describe("CG-S29: wrapper records usage from classifier result (AC-12)", () => {
  it("recordHaikuUsage receives the result.usage exactly", async () => {
    const guard = createCostGuard();
    const usage: AnthropicUsage = {
      input_tokens: 200,
      cache_read_input_tokens: 1_000,
      output_tokens: 25,
    };
    const { fn } = makeFakeClassifier({
      isQuestion: true,
      confidence: 0.9,
      reason: "yes",
      rawText: "YES",
      latencyMs: 150,
      usage,
      costUsd: computeHaikuCostUsd(usage),
    });
    await guardedClassifyWithHaiku("Q?", fn, guard);
    const snap = guard.snapshot();
    expect(snap.haiku.cacheReadTokens).toBe(1_000);
    expect(snap.haiku.inputTokens).toBe(200);
    expect(snap.haiku.outputTokens).toBe(25);
    expect(snap.haiku.costUsd).toBeCloseTo(computeHaikuCostUsd(usage), 12);
  });
});

describe("CG-S30: paused wrapper does NOT record usage (AC-11)", () => {
  it("post-pause: counters stay at 0", async () => {
    const guard = createCostGuard({ paused: true });
    const { fn } = makeFakeClassifier({
      isQuestion: true,
      confidence: 0.9,
      reason: "yes",
      rawText: "YES",
      latencyMs: 150,
      usage: { input_tokens: 999, output_tokens: 999 },
      costUsd: 999,
    });
    await guardedClassifyWithHaiku("anything", fn, guard);
    const snap = guard.snapshot();
    expect(snap.haiku.calls).toBe(0);
    expect(snap.haiku.inputTokens).toBe(0);
    expect(snap.haiku.outputTokens).toBe(0);
    expect(snap.haiku.costUsd).toBe(0);
  });
});

// ── Sanity sums (cross-check with pricing helpers) ──────────────────────────

describe("CG-Sanity: counter cost equals pricing helper sum exactly (AC-1)", () => {
  it("Sonnet+Haiku mix matches helper sum to 12 decimal places", () => {
    const guard = createCostGuard();
    const haikuUsages: AnthropicUsage[] = [
      { input_tokens: 100, output_tokens: 20 },
      { input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 10 },
    ];
    const sonnetUsages: AnthropicUsage[] = [
      { input_tokens: 200, output_tokens: 50 },
      { input_tokens: 0, cache_creation_input_tokens: 1_000, output_tokens: 30 },
    ];
    haikuUsages.forEach((u) => guard.recordHaikuUsage(u));
    sonnetUsages.forEach((u) => guard.recordSonnetUsage(u));
    const expectedHaiku = haikuUsages
      .map(computeHaikuCostUsd)
      .reduce((a, b) => a + b, 0);
    const expectedSonnet = sonnetUsages
      .map(computeCostUsd)
      .reduce((a, b) => a + b, 0);
    const snap = guard.snapshot();
    expect(snap.haiku.costUsd).toBeCloseTo(expectedHaiku, 12);
    expect(snap.sonnet.costUsd).toBeCloseTo(expectedSonnet, 12);
    expect(snap.totalCostUsd).toBeCloseTo(expectedHaiku + expectedSonnet, 12);
  });
});
