// Phase 3 T-3.5 — STT provider pricing constants + helper.
//
// AC traceability (see docs/tasks/phase-3/T-3.5-cost-meter.md):
//   ST-S1   — constants verbatim against ARCH §3.2
//   ST-S2..S6 — `computeSttCostUsd` per-provider math
//   ST-S7..S8 — defensive paths (negative / zero)
//   ST-S9   — provider-id parity with Rust `ProviderKind::as_str()`

import { describe, expect, it } from "vitest";

import {
  DEEPGRAM_USD_PER_MINUTE,
  ELEVENLABS_USD_PER_HOUR,
  ELEVENLABS_USD_PER_MINUTE,
  STT_PROVIDER_IDS,
  STT_PROVIDER_USD_PER_MINUTE,
  computeSttCostUsd,
  isSttProviderId,
} from "./sttPricing";

describe("ST-S1: rate table verbatim against ARCH §3.2", () => {
  it("MLX = $0", () => {
    expect(STT_PROVIDER_USD_PER_MINUTE.mlx).toBe(0);
  });

  it("Fake = $0 (deterministic test stub)", () => {
    expect(STT_PROVIDER_USD_PER_MINUTE.fake).toBe(0);
  });

  it("Deepgram = $0.0043 / minute (ARCH §3.2 line 113)", () => {
    expect(STT_PROVIDER_USD_PER_MINUTE.deepgram).toBe(0.0043);
    expect(DEEPGRAM_USD_PER_MINUTE).toBe(0.0043);
  });

  it("ElevenLabs = $0.40 / hour → $0.40/60 per minute (ARCH §3.2 line 119)", () => {
    expect(ELEVENLABS_USD_PER_HOUR).toBe(0.4);
    expect(ELEVENLABS_USD_PER_MINUTE).toBeCloseTo(0.4 / 60, 12);
    expect(STT_PROVIDER_USD_PER_MINUTE.elevenlabs).toBe(ELEVENLABS_USD_PER_MINUTE);
  });
});

describe("ST-S2: MLX cost is always $0 regardless of duration", () => {
  it("3600s of MLX → $0", () => {
    expect(computeSttCostUsd("mlx", 3600)).toBe(0);
  });

  it("1s of MLX → $0", () => {
    expect(computeSttCostUsd("mlx", 1)).toBe(0);
  });
});

describe("ST-S3: Deepgram cost — 60s == $0.0043", () => {
  it("60 audio-seconds at $0.0043/min produces $0.0043", () => {
    expect(computeSttCostUsd("deepgram", 60)).toBeCloseTo(0.0043, 9);
  });
});

describe("ST-S4: Deepgram cost scales linearly", () => {
  it("600s == $0.043 (10 minutes)", () => {
    expect(computeSttCostUsd("deepgram", 600)).toBeCloseTo(0.043, 9);
  });

  it("3600s == $0.258 (1 hour, $0.0043 × 60)", () => {
    expect(computeSttCostUsd("deepgram", 3600)).toBeCloseTo(0.258, 9);
  });
});

describe("ST-S5: ElevenLabs cost — 3600s == $0.40 exactly", () => {
  it("1 full hour of ElevenLabs streaming → $0.40", () => {
    expect(computeSttCostUsd("elevenlabs", 3600)).toBeCloseTo(0.4, 9);
  });
});

describe("ST-S6: ElevenLabs cost scales linearly", () => {
  it("1800s == $0.20 (half hour)", () => {
    expect(computeSttCostUsd("elevenlabs", 1800)).toBeCloseTo(0.2, 9);
  });

  it("60s == $0.40/60 (1 minute)", () => {
    expect(computeSttCostUsd("elevenlabs", 60)).toBeCloseTo(0.4 / 60, 9);
  });
});

describe("ST-S7: defensive — negative/non-finite seconds clamp to 0", () => {
  it("negative seconds → $0", () => {
    expect(computeSttCostUsd("deepgram", -5)).toBe(0);
  });

  it("NaN seconds → $0", () => {
    expect(computeSttCostUsd("deepgram", Number.NaN)).toBe(0);
  });

  it("Infinity seconds → $0", () => {
    expect(computeSttCostUsd("deepgram", Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("ST-S8: zero seconds is $0 across all providers", () => {
  for (const id of STT_PROVIDER_IDS) {
    it(`${id} at 0s → $0`, () => {
      expect(computeSttCostUsd(id, 0)).toBe(0);
    });
  }
});

describe("ST-S9: provider IDs match Rust ProviderKind::as_str()", () => {
  // Rust source of truth: crates/stt-mlx/src/providers/mod.rs::ProviderKind::as_str
  // Drift here breaks settings v2 schema (T-3.6) — picker values round-trip across
  // both surfaces.
  it("STT_PROVIDER_IDS contains exactly the 4 Rust kinds", () => {
    expect([...STT_PROVIDER_IDS].sort()).toEqual(
      ["mlx", "fake", "deepgram", "elevenlabs"].sort(),
    );
  });

  it("isSttProviderId narrows known strings", () => {
    expect(isSttProviderId("mlx")).toBe(true);
    expect(isSttProviderId("deepgram")).toBe(true);
    expect(isSttProviderId("elevenlabs")).toBe(true);
    expect(isSttProviderId("fake")).toBe(true);
  });

  it("isSttProviderId rejects unknown values", () => {
    expect(isSttProviderId("whisper-cpp")).toBe(false);
    expect(isSttProviderId("")).toBe(false);
    expect(isSttProviderId(undefined)).toBe(false);
    expect(isSttProviderId(123)).toBe(false);
  });
});
