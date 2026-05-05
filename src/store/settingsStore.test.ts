// Phase 2 T-2.9 — Settings store unit tests.
//
// AC traceability (see docs/tasks/phase-2/T-2.9-settings.md):
//   SS-S1..S3   — defaults / corrupted storage fallback (AC-1, AC-5)
//   SS-S4..S8   — setter round-trip per field (AC-2, AC-3)
//   SS-S9       — persistence across recreate (AC-4)
//   SS-S10..S16 — clamping + NaN rejection (AC-6)
//   SS-S17      — reset() (AC-7)
//   SS-S18..S24 — classifyWithSettingsGate composer + admit math (AC-3, AC-8..AC-10, AC-15)
//   SS-S25      — setItem-throws swallowed (AC-11)
//   SS-S26..S27 — versioned storage key (AC-14)
//   SS-S28      — null-storage scope guard (AC-5)

import { describe, expect, it, vi } from "vitest";

import { HAIKU_ADMIT_THRESHOLD, type HaikuClassification } from "../llm/haikuFilter";
import { createCostGuard, DEFAULT_THRESHOLD_USD_PER_HOUR } from "../cost/costGuard";
import { DEFAULT_SILENCE_MS } from "../detector/sliding-window";
import {
  classifyWithSettingsGate,
  createSettingsStore,
  SETTINGS_STORAGE_KEY,
  type SettingsState,
  type StorageLike,
} from "./settingsStore";

// ── Storage mock ────────────────────────────────────────────────────────────

function createMockStorage(seed?: Record<string, string>): StorageLike & {
  inspect(): Record<string, string>;
} {
  const data = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    inspect: () => Object.fromEntries(data),
  };
}

function makeUsage(): HaikuClassification["usage"] {
  return {
    input_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100,
    output_tokens: 12,
  };
}

function makeClassification(
  isQuestion: boolean,
  confidence: number,
): HaikuClassification {
  return {
    isQuestion,
    confidence,
    reason: "test",
    rawText: isQuestion ? "YES test" : "NO test",
    latencyMs: 42,
    usage: makeUsage(),
    costUsd: 0.0001,
  };
}

// ── SS-S1..S3: defaults + corrupted storage fallback ────────────────────────

describe("SS-S1: defaults on empty storage", () => {
  it("constructs with the documented defaults verbatim", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    const s = store.getState();
    expect(s.haikuConfidenceCutoff).toBe(HAIKU_ADMIT_THRESHOLD);
    expect(s.haikuConfidenceCutoff).toBe(0.7);
    expect(s.haikuEnabled).toBe(true);
    expect(s.silenceThresholdMs).toBe(DEFAULT_SILENCE_MS);
    expect(s.silenceThresholdMs).toBe(800);
    expect(s.costGuardThresholdUsdPerHour).toBe(
      DEFAULT_THRESHOLD_USD_PER_HOUR,
    );
    expect(s.costGuardThresholdUsdPerHour).toBe(0.5);
    expect(s.costGuardPaused).toBe(false);
  });
});

describe("SS-S2: defaults on corrupted JSON in storage", () => {
  it("falls back silently when stored value is malformed JSON", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: "this is not json {",
    });
    const store = createSettingsStore({ storage });
    const s = store.getState();
    expect(s.haikuConfidenceCutoff).toBe(0.7);
    expect(s.haikuEnabled).toBe(true);
    expect(s.silenceThresholdMs).toBe(800);
    expect(s.costGuardThresholdUsdPerHour).toBe(0.5);
    expect(s.costGuardPaused).toBe(false);
  });
});

describe("SS-S3: defaults on partial-shape JSON", () => {
  it("merges any present fields with defaults; bad-shape values are coerced to default", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        haikuConfidenceCutoff: 0.85,
        // other fields missing
        haikuEnabled: "not a boolean",
      }),
    });
    const store = createSettingsStore({ storage });
    const s = store.getState();
    expect(s.haikuConfidenceCutoff).toBe(0.85);
    expect(s.haikuEnabled).toBe(true); // bad shape → default
    expect(s.silenceThresholdMs).toBe(800); // missing → default
    expect(s.costGuardThresholdUsdPerHour).toBe(0.5);
    expect(s.costGuardPaused).toBe(false);
  });
});

// ── SS-S4..S8: setter round-trips ───────────────────────────────────────────

describe("SS-S4: setHaikuConfidenceCutoff round-trip", () => {
  it("updates state and persists to storage", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setHaikuConfidenceCutoff(0.85);
    expect(store.getState().haikuConfidenceCutoff).toBe(0.85);
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.haikuConfidenceCutoff).toBe(0.85);
  });
});

describe("SS-S5: setSilenceThresholdMs round-trip", () => {
  it("updates state and persists", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setSilenceThresholdMs(1500);
    expect(store.getState().silenceThresholdMs).toBe(1500);
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.silenceThresholdMs).toBe(1500);
  });
});

describe("SS-S6: setCostGuardThresholdUsdPerHour round-trip", () => {
  it("updates state and persists", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setCostGuardThresholdUsdPerHour(0.75);
    expect(store.getState().costGuardThresholdUsdPerHour).toBe(0.75);
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.costGuardThresholdUsdPerHour).toBe(0.75);
  });
});

describe("SS-S7: setHaikuEnabled round-trip", () => {
  it("toggles haikuEnabled and persists", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setHaikuEnabled(false);
    expect(store.getState().haikuEnabled).toBe(false);
    store.getState().setHaikuEnabled(true);
    expect(store.getState().haikuEnabled).toBe(true);
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.haikuEnabled).toBe(true);
  });
});

describe("SS-S8: setCostGuardPaused round-trip", () => {
  it("toggles costGuardPaused and persists", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setCostGuardPaused(true);
    expect(store.getState().costGuardPaused).toBe(true);
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.costGuardPaused).toBe(true);
  });
});

// ── SS-S9: persistence across recreate (AC-4) ───────────────────────────────

describe("SS-S9: persistence across reload", () => {
  it("recreating the store with the same storage restores all 5 fields", () => {
    const storage = createMockStorage();
    const a = createSettingsStore({ storage });
    a.getState().setHaikuConfidenceCutoff(0.92);
    a.getState().setHaikuEnabled(false);
    a.getState().setSilenceThresholdMs(1200);
    a.getState().setCostGuardThresholdUsdPerHour(1.5);
    a.getState().setCostGuardPaused(true);

    const b = createSettingsStore({ storage });
    const s = b.getState();
    expect(s.haikuConfidenceCutoff).toBe(0.92);
    expect(s.haikuEnabled).toBe(false);
    expect(s.silenceThresholdMs).toBe(1200);
    expect(s.costGuardThresholdUsdPerHour).toBe(1.5);
    expect(s.costGuardPaused).toBe(true);
  });
});

// ── SS-S10..S16: clamping + NaN rejection (AC-6) ────────────────────────────

describe("SS-S10: setHaikuConfidenceCutoff(-0.1) clamps to 0", () => {
  it("negative input clamped to 0", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setHaikuConfidenceCutoff(-0.1);
    expect(store.getState().haikuConfidenceCutoff).toBe(0);
  });
});

describe("SS-S11: setHaikuConfidenceCutoff(1.5) clamps to 1", () => {
  it("above-1 input clamped to 1", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setHaikuConfidenceCutoff(1.5);
    expect(store.getState().haikuConfidenceCutoff).toBe(1);
  });
});

describe("SS-S12: setHaikuConfidenceCutoff(NaN) rejected", () => {
  it("NaN input leaves state unchanged", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    const before = store.getState().haikuConfidenceCutoff;
    store.getState().setHaikuConfidenceCutoff(NaN);
    expect(store.getState().haikuConfidenceCutoff).toBe(before);
  });
});

describe("SS-S13: setSilenceThresholdMs(50) clamps to 200", () => {
  it("below-200 input clamped to 200 (lower bound)", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setSilenceThresholdMs(50);
    expect(store.getState().silenceThresholdMs).toBe(200);
  });
});

describe("SS-S14: setSilenceThresholdMs(20_000) clamps to 10_000", () => {
  it("above-10000 input clamped to 10000 (upper bound)", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setSilenceThresholdMs(20_000);
    expect(store.getState().silenceThresholdMs).toBe(10_000);
  });
});

describe("SS-S15: setCostGuardThresholdUsdPerHour(-1) clamps to 0", () => {
  it("negative input clamped to 0", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setCostGuardThresholdUsdPerHour(-1);
    expect(store.getState().costGuardThresholdUsdPerHour).toBe(0);
  });
});

describe("SS-S16: setCostGuardThresholdUsdPerHour(150) clamps to 100", () => {
  it("above-100 input clamped to 100", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setCostGuardThresholdUsdPerHour(150);
    expect(store.getState().costGuardThresholdUsdPerHour).toBe(100);
  });
});

// ── SS-S17: reset() (AC-7) ──────────────────────────────────────────────────

describe("SS-S17: reset() restores defaults in-memory + on disk", () => {
  it("after mutation, reset() returns every field to default and rewrites storage", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setHaikuConfidenceCutoff(0.85);
    store.getState().setHaikuEnabled(false);
    store.getState().setSilenceThresholdMs(2000);
    store.getState().setCostGuardThresholdUsdPerHour(2);
    store.getState().setCostGuardPaused(true);

    store.getState().reset();

    const s = store.getState();
    expect(s.haikuConfidenceCutoff).toBe(0.7);
    expect(s.haikuEnabled).toBe(true);
    expect(s.silenceThresholdMs).toBe(800);
    expect(s.costGuardThresholdUsdPerHour).toBe(0.5);
    expect(s.costGuardPaused).toBe(false);

    // Re-create from storage → also defaults.
    const recreated = createSettingsStore({ storage });
    expect(recreated.getState().haikuConfidenceCutoff).toBe(0.7);
    expect(recreated.getState().haikuEnabled).toBe(true);
  });
});

// ── SS-S18..S24: classifyWithSettingsGate composer + admit math ─────────────

function snapshotFor(overrides: Partial<SettingsState>): SettingsState {
  const base: SettingsState = {
    haikuConfidenceCutoff: 0.7,
    haikuEnabled: true,
    silenceThresholdMs: 800,
    costGuardThresholdUsdPerHour: 0.5,
    costGuardPaused: false,
    setHaikuConfidenceCutoff: () => undefined,
    setHaikuEnabled: () => undefined,
    setSilenceThresholdMs: () => undefined,
    setCostGuardThresholdUsdPerHour: () => undefined,
    setCostGuardPaused: () => undefined,
    reset: () => undefined,
  };
  return { ...base, ...overrides };
}

describe("SS-S18: classifyWithSettingsGate skipped-disabled when haikuEnabled === false", () => {
  it("returns skipped-disabled and does NOT invoke classifier", async () => {
    const settings = snapshotFor({ haikuEnabled: false });
    const guard = createCostGuard();
    const classifier = vi.fn(async () => makeClassification(true, 0.9));
    const out = await classifyWithSettingsGate("anything", classifier, settings, guard);
    expect(out).toEqual({ status: "skipped-disabled" });
    expect(classifier).not.toHaveBeenCalled();
  });
});

describe("SS-S19: classifyWithSettingsGate skipped-paused when guard paused (haiku enabled)", () => {
  it("returns skipped-paused and does NOT invoke classifier", async () => {
    const settings = snapshotFor({ haikuEnabled: true });
    const guard = createCostGuard({ paused: true });
    const classifier = vi.fn(async () => makeClassification(true, 0.9));
    const out = await classifyWithSettingsGate("anything", classifier, settings, guard);
    expect(out).toEqual({ status: "skipped-paused" });
    expect(classifier).not.toHaveBeenCalled();
  });
});

describe("SS-S20: skipped-disabled wins over skipped-paused (precedence)", () => {
  it("disabled + paused → returns skipped-disabled, classifier NOT called", async () => {
    const settings = snapshotFor({ haikuEnabled: false });
    const guard = createCostGuard({ paused: true });
    const classifier = vi.fn(async () => makeClassification(true, 0.9));
    const out = await classifyWithSettingsGate("anything", classifier, settings, guard);
    expect(out).toEqual({ status: "skipped-disabled" });
    expect(classifier).not.toHaveBeenCalled();
  });
});

describe("SS-S21: classifies + records usage when enabled and not paused", () => {
  it("invokes classifier once, records usage on guard", async () => {
    const settings = snapshotFor({ haikuEnabled: true, haikuConfidenceCutoff: 0.7 });
    const guard = createCostGuard();
    const cls = makeClassification(true, 0.9);
    const classifier = vi.fn(async () => cls);
    const out = await classifyWithSettingsGate("hello?", classifier, settings, guard);
    expect(out.status).toBe("classified");
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(classifier).toHaveBeenCalledWith("hello?", undefined);
    expect(guard.snapshot().haiku.calls).toBe(1);
    if (out.status === "classified") {
      expect(out.result).toBe(cls);
      expect(out.admit).toBe(true);
    }
  });
});

describe("SS-S22: admit === true when confidence ≥ cutoff", () => {
  it("0.9 ≥ 0.85 → admit true", async () => {
    const settings = snapshotFor({
      haikuEnabled: true,
      haikuConfidenceCutoff: 0.85,
    });
    const guard = createCostGuard();
    const classifier = async () => makeClassification(true, 0.9);
    const out = await classifyWithSettingsGate("hello?", classifier, settings, guard);
    if (out.status !== "classified") throw new Error("expected classified");
    expect(out.admit).toBe(true);
  });
});

describe("SS-S23: admit === false when confidence < cutoff", () => {
  it("0.70 < 0.85 → admit false", async () => {
    const settings = snapshotFor({
      haikuEnabled: true,
      haikuConfidenceCutoff: 0.85,
    });
    const guard = createCostGuard();
    const classifier = async () => makeClassification(true, 0.7);
    const out = await classifyWithSettingsGate("hello?", classifier, settings, guard);
    if (out.status !== "classified") throw new Error("expected classified");
    expect(out.admit).toBe(false);
  });
});

describe("SS-S24: admit requires isQuestion === true", () => {
  it("isQuestion=false + confidence=0.99 still admit=false", async () => {
    const settings = snapshotFor({
      haikuEnabled: true,
      haikuConfidenceCutoff: 0.5,
    });
    const guard = createCostGuard();
    const classifier = async () => makeClassification(false, 0.99);
    const out = await classifyWithSettingsGate("hello?", classifier, settings, guard);
    if (out.status !== "classified") throw new Error("expected classified");
    expect(out.admit).toBe(false);
  });
});

// ── SS-S25: setItem-throws swallowed (AC-11) ────────────────────────────────

describe("SS-S25: setItem throwing does not propagate out of setter", () => {
  it("in-memory state still mutates; setter does not throw", () => {
    const throwingStorage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const store = createSettingsStore({ storage: throwingStorage });
    expect(() => store.getState().setHaikuConfidenceCutoff(0.9)).not.toThrow();
    expect(store.getState().haikuConfidenceCutoff).toBe(0.9);
  });
});

// ── SS-S26..S27: versioned storage key (AC-14) ──────────────────────────────

describe("SS-S26: SETTINGS_STORAGE_KEY constant", () => {
  it("is exactly meeting-copilot:settings:v1", () => {
    expect(SETTINGS_STORAGE_KEY).toBe("meeting-copilot:settings:v1");
  });
});

describe("SS-S27: storage written under exactly the versioned key", () => {
  it("setItem call writes only that key (no global namespace pollution)", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setHaikuConfidenceCutoff(0.55);
    const inspected = storage.inspect();
    expect(Object.keys(inspected)).toEqual([SETTINGS_STORAGE_KEY]);
  });
});

// ── SS-S28: null-storage scope guard ────────────────────────────────────────

describe("SS-S28: store works when storage is null", () => {
  it("constructs with defaults; setters update memory; no throw", () => {
    const store = createSettingsStore({ storage: null });
    expect(store.getState().haikuConfidenceCutoff).toBe(0.7);
    expect(() => store.getState().setHaikuConfidenceCutoff(0.85)).not.toThrow();
    expect(store.getState().haikuConfidenceCutoff).toBe(0.85);
  });
});
