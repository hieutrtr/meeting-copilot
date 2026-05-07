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
//
// Phase 3 T-3.6 — Settings UI store extensions:
//   SS-S29      — defaults: sttProvider="mlx", apiKeys zero-filled
//   SS-S30..S31 — setSttProvider round-trip + bad-id rejection
//   SS-S32..S33 — setApiKey per-provider round-trip + isolation
//   SS-S34      — v1 → v2 migration preserves v1 fields, fills v2 defaults
//   SS-S35      — versioned storage key constants are v2 / v1 (legacy)

import { describe, expect, it, vi } from "vitest";

import { HAIKU_ADMIT_THRESHOLD, type HaikuClassification } from "../llm/haikuFilter";
import { createCostGuard, DEFAULT_THRESHOLD_USD_PER_HOUR } from "../cost/costGuard";
import { DEFAULT_SILENCE_MS } from "../detector/sliding-window";
import {
  classifyWithSettingsGate,
  createSettingsStore,
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_DEFAULTS,
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
  it("falls back silently when stored value is malformed JSON (v2 + v1 both bad)", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: "this is not json {",
      [LEGACY_SETTINGS_STORAGE_KEY]: "also bad {",
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
    expect(s.sttProvider).toBe("mlx"); // missing → default
    expect(s.apiKeys).toEqual({ deepgram: "", elevenlabs: "" });
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
    sttProvider: "mlx",
    apiKeys: { deepgram: "", elevenlabs: "" },
    privacyMode: "local-first",
    telemetryEnabled: false,
    setupCompleted: false,
    setHaikuConfidenceCutoff: () => undefined,
    setHaikuEnabled: () => undefined,
    setSilenceThresholdMs: () => undefined,
    setCostGuardThresholdUsdPerHour: () => undefined,
    setCostGuardPaused: () => undefined,
    setSttProvider: () => undefined,
    setApiKey: () => undefined,
    setPrivacyMode: () => undefined,
    setTelemetryEnabled: () => undefined,
    setSetupCompleted: () => undefined,
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

describe("SS-S26: SETTINGS_STORAGE_KEY constant (Phase 3 T-3.6 → v2)", () => {
  it("is exactly meeting-copilot:settings:v2", () => {
    expect(SETTINGS_STORAGE_KEY).toBe("meeting-copilot:settings:v2");
  });

  it("legacy v1 key constant is exposed for migration tests", () => {
    expect(LEGACY_SETTINGS_STORAGE_KEY).toBe("meeting-copilot:settings:v1");
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

// ── Phase 3 T-3.6 — STT provider picker + per-provider API keys ─────────────

describe("SS-S29: defaults — sttProvider=\"mlx\", apiKeys zero-filled", () => {
  it("matches SETTINGS_DEFAULTS exactly for the new fields", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    const s = store.getState();
    expect(s.sttProvider).toBe("mlx");
    expect(s.sttProvider).toBe(SETTINGS_DEFAULTS.sttProvider);
    expect(s.apiKeys).toEqual({ deepgram: "", elevenlabs: "" });
    expect(s.apiKeys).toEqual(SETTINGS_DEFAULTS.apiKeys);
  });
});

describe("SS-S30: setSttProvider round-trip", () => {
  it("updates state and persists to storage", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setSttProvider("deepgram");
    expect(store.getState().sttProvider).toBe("deepgram");
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.sttProvider).toBe("deepgram");
  });

  it("survives recreate from same storage (persistence parity)", () => {
    const storage = createMockStorage();
    const a = createSettingsStore({ storage });
    a.getState().setSttProvider("elevenlabs");
    const b = createSettingsStore({ storage });
    expect(b.getState().sttProvider).toBe("elevenlabs");
  });
});

describe("SS-S31: setSttProvider rejects unknown ids", () => {
  it("bogus provider id is a no-op (state unchanged, no throw)", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    const before = store.getState().sttProvider;
    expect(() =>
      // @ts-expect-error — intentionally bypassing the type guard.
      store.getState().setSttProvider("not-a-provider"),
    ).not.toThrow();
    expect(store.getState().sttProvider).toBe(before);
  });
});

describe("SS-S32: setApiKey round-trip per provider", () => {
  it("deepgram key stored + persisted", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setApiKey("deepgram", "dg-secret-abc");
    expect(store.getState().apiKeys.deepgram).toBe("dg-secret-abc");
    const written = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(written.apiKeys.deepgram).toBe("dg-secret-abc");
    expect(written.apiKeys.elevenlabs).toBe(""); // not touched
  });

  it("elevenlabs key stored + persisted; rejects non-string value", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setApiKey("elevenlabs", "el-secret-xyz");
    expect(store.getState().apiKeys.elevenlabs).toBe("el-secret-xyz");
    // @ts-expect-error — non-string defensive path.
    store.getState().setApiKey("elevenlabs", 1234);
    expect(store.getState().apiKeys.elevenlabs).toBe("el-secret-xyz");
  });

  it("clearing a key (empty string) is allowed — \"use env-var fallback\"", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setApiKey("deepgram", "abc");
    store.getState().setApiKey("deepgram", "");
    expect(store.getState().apiKeys.deepgram).toBe("");
  });
});

describe("SS-S33: setApiKey is per-key isolated", () => {
  it("setting deepgram does not change elevenlabs and vice-versa", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setApiKey("deepgram", "DG-KEY");
    store.getState().setApiKey("elevenlabs", "EL-KEY");
    const a = store.getState().apiKeys;
    expect(a.deepgram).toBe("DG-KEY");
    expect(a.elevenlabs).toBe("EL-KEY");

    store.getState().setApiKey("deepgram", "DG-KEY-2");
    const b = store.getState().apiKeys;
    expect(b.deepgram).toBe("DG-KEY-2");
    expect(b.elevenlabs).toBe("EL-KEY"); // unchanged
  });

  it("rejects unknown provider id", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    expect(() =>
      // @ts-expect-error — bogus key.
      store.getState().setApiKey("openai", "should-not-set"),
    ).not.toThrow();
    expect(store.getState().apiKeys).toEqual({ deepgram: "", elevenlabs: "" });
  });
});

describe("SS-S34: v1 → v2 migration", () => {
  it("loads v1 payload when v2 is absent and lifts into v2 shape", () => {
    const v1Payload = {
      haikuConfidenceCutoff: 0.92,
      haikuEnabled: false,
      silenceThresholdMs: 1500,
      costGuardThresholdUsdPerHour: 1.25,
      costGuardPaused: true,
    };
    const storage = createMockStorage({
      [LEGACY_SETTINGS_STORAGE_KEY]: JSON.stringify(v1Payload),
    });
    const store = createSettingsStore({ storage });
    const s = store.getState();
    // v1 fields preserved byte-identically
    expect(s.haikuConfidenceCutoff).toBe(0.92);
    expect(s.haikuEnabled).toBe(false);
    expect(s.silenceThresholdMs).toBe(1500);
    expect(s.costGuardThresholdUsdPerHour).toBe(1.25);
    expect(s.costGuardPaused).toBe(true);
    // v2 additions zero-fill from defaults
    expect(s.sttProvider).toBe("mlx");
    expect(s.apiKeys).toEqual({ deepgram: "", elevenlabs: "" });
    // After migration, v2 key has been written
    const inspected = storage.inspect();
    expect(inspected[SETTINGS_STORAGE_KEY]).toBeDefined();
    const persisted = JSON.parse(inspected[SETTINGS_STORAGE_KEY]!);
    expect(persisted.haikuConfidenceCutoff).toBe(0.92);
    expect(persisted.sttProvider).toBe("mlx");
    // v1 left in place (non-destructive — downgrade rollback safe)
    expect(inspected[LEGACY_SETTINGS_STORAGE_KEY]).toBeDefined();
  });

  it("v2 takes precedence when both keys are present", () => {
    const storage = createMockStorage({
      [LEGACY_SETTINGS_STORAGE_KEY]: JSON.stringify({
        haikuConfidenceCutoff: 0.5,
      }),
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        haikuConfidenceCutoff: 0.99,
        sttProvider: "elevenlabs",
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().haikuConfidenceCutoff).toBe(0.99);
    expect(store.getState().sttProvider).toBe("elevenlabs");
  });
});

describe("SS-S35: SETTINGS_DEFAULTS shape includes v2 fields", () => {
  it("has both v1 and v2 fields with the documented defaults", () => {
    expect(SETTINGS_DEFAULTS.sttProvider).toBe("mlx");
    expect(SETTINGS_DEFAULTS.apiKeys).toEqual({
      deepgram: "",
      elevenlabs: "",
    });
    // v1 fields stay at the documented constants
    expect(SETTINGS_DEFAULTS.haikuConfidenceCutoff).toBe(0.7);
    expect(SETTINGS_DEFAULTS.haikuEnabled).toBe(true);
  });
});

// ── Phase 3 T-3.8 — Privacy mode picker + auto-revert ───────────────────────

describe("SS-S36: default privacyMode is 'local-first' (privacy by default)", () => {
  it("defaults match SETTINGS_DEFAULTS.privacyMode and ARCH §11", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    expect(store.getState().privacyMode).toBe("local-first");
    expect(SETTINGS_DEFAULTS.privacyMode).toBe("local-first");
  });
});

describe("SS-S37: setPrivacyMode round-trip + persistence", () => {
  it("updates state and persists to storage", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    store.getState().setPrivacyMode("cloud");
    expect(store.getState().privacyMode).toBe("cloud");
    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.privacyMode).toBe("cloud");
  });

  it("survives recreate from same storage", () => {
    const storage = createMockStorage();
    const a = createSettingsStore({ storage });
    a.getState().setPrivacyMode("mixed");
    const b = createSettingsStore({ storage });
    expect(b.getState().privacyMode).toBe("mixed");
  });
});

describe("SS-S38: auto-revert when current STT provider becomes disallowed", () => {
  it("Cloud→deepgram, switch to local-first → sttProvider snaps to 'mlx'", () => {
    const storage = createMockStorage();
    const store = createSettingsStore({ storage });
    // Set up an allowed combination first
    store.getState().setPrivacyMode("cloud");
    store.getState().setSttProvider("deepgram");
    expect(store.getState().sttProvider).toBe("deepgram");

    // Switching to local-first must revert sttProvider to mlx in the same call
    store.getState().setPrivacyMode("local-first");
    expect(store.getState().privacyMode).toBe("local-first");
    expect(store.getState().sttProvider).toBe("mlx");

    // Persistence reflects the revert
    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.privacyMode).toBe("local-first");
    expect(persisted.sttProvider).toBe("mlx");
  });

  it("Cloud→elevenlabs, switch to mixed → sttProvider snaps to 'mlx'", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setPrivacyMode("cloud");
    store.getState().setSttProvider("elevenlabs");
    store.getState().setPrivacyMode("mixed");
    expect(store.getState().sttProvider).toBe("mlx");
  });
});

describe("SS-S39: setPrivacyMode rejects unknown modes", () => {
  it("bogus mode is a no-op", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    const before = store.getState().privacyMode;
    expect(() =>
      // @ts-expect-error — bogus mode value
      store.getState().setPrivacyMode("offline"),
    ).not.toThrow();
    expect(store.getState().privacyMode).toBe(before);
  });
});

describe("SS-S40: auto-revert is a no-op when current provider is still allowed", () => {
  it("Cloud→mlx, switch to local-first → sttProvider stays mlx", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setPrivacyMode("cloud");
    // Provider stays at default `mlx`
    expect(store.getState().sttProvider).toBe("mlx");
    store.getState().setPrivacyMode("local-first");
    expect(store.getState().sttProvider).toBe("mlx");
    expect(store.getState().privacyMode).toBe("local-first");
  });

  it("Cloud→deepgram, switch to cloud (no-op) → sttProvider stays deepgram", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setPrivacyMode("cloud");
    store.getState().setSttProvider("deepgram");
    store.getState().setPrivacyMode("cloud");
    expect(store.getState().sttProvider).toBe("deepgram");
  });
});

// ── Phase 3 T-3.9 — Telemetry opt-in toggle ────────────────────────────────

describe("SS-S41: default telemetryEnabled is false (opt-in)", () => {
  it("matches SETTINGS_DEFAULTS.telemetryEnabled", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    expect(store.getState().telemetryEnabled).toBe(false);
    expect(SETTINGS_DEFAULTS.telemetryEnabled).toBe(false);
  });
});

describe("SS-S42: setTelemetryEnabled round-trip + persistence", () => {
  it("toggle on persists; recreate from same storage carries forward", () => {
    const storage = createMockStorage();
    const a = createSettingsStore({ storage });
    a.getState().setTelemetryEnabled(true);
    expect(a.getState().telemetryEnabled).toBe(true);

    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.telemetryEnabled).toBe(true);

    const b = createSettingsStore({ storage });
    expect(b.getState().telemetryEnabled).toBe(true);
  });

  it("toggle off round-trips; coerced to boolean from non-boolean input", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setTelemetryEnabled(true);
    store.getState().setTelemetryEnabled(false);
    expect(store.getState().telemetryEnabled).toBe(false);

    // Coercion: truthy non-bool → true, falsy → false (mirrors setHaikuEnabled).
    // @ts-expect-error — defensive runtime path.
    store.getState().setTelemetryEnabled(1);
    expect(store.getState().telemetryEnabled).toBe(true);
    // @ts-expect-error
    store.getState().setTelemetryEnabled(0);
    expect(store.getState().telemetryEnabled).toBe(false);
  });
});

describe("SS-S43: v1 migration zero-fills telemetryEnabled to false", () => {
  it("v1 payload (no telemetry field) lifts into v2 with telemetryEnabled = false", () => {
    const storage = createMockStorage({
      [LEGACY_SETTINGS_STORAGE_KEY]: JSON.stringify({
        haikuConfidenceCutoff: 0.9,
        // no telemetryEnabled
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().telemetryEnabled).toBe(false);
    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.telemetryEnabled).toBe(false);
  });

  it("malformed telemetryEnabled value coerces to default (false)", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        telemetryEnabled: "yes please",
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().telemetryEnabled).toBe(false);
  });
});

// ── Phase-W T-W.7 — Setup wizard sign-off flag ──────────────────────────────

describe("SS-S44: default setupCompleted is false (fresh-install gate)", () => {
  it("matches SETTINGS_DEFAULTS.setupCompleted", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    expect(store.getState().setupCompleted).toBe(false);
    expect(SETTINGS_DEFAULTS.setupCompleted).toBe(false);
  });
});

describe("SS-S45: setSetupCompleted round-trip + persistence", () => {
  it("flip to true persists; recreate from same storage carries forward", () => {
    const storage = createMockStorage();
    const a = createSettingsStore({ storage });
    a.getState().setSetupCompleted(true);
    expect(a.getState().setupCompleted).toBe(true);

    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.setupCompleted).toBe(true);

    const b = createSettingsStore({ storage });
    expect(b.getState().setupCompleted).toBe(true);
  });

  it("flip back to false round-trips; coerced to boolean from non-boolean input", () => {
    const store = createSettingsStore({ storage: createMockStorage() });
    store.getState().setSetupCompleted(true);
    store.getState().setSetupCompleted(false);
    expect(store.getState().setupCompleted).toBe(false);

    // @ts-expect-error — defensive runtime path.
    store.getState().setSetupCompleted(1);
    expect(store.getState().setupCompleted).toBe(true);
    // @ts-expect-error
    store.getState().setSetupCompleted(0);
    expect(store.getState().setupCompleted).toBe(false);
  });
});

describe("SS-S46: migration safety — pre-T-W.7 storage payloads default setupCompleted=false", () => {
  it("v1 payload (no setupCompleted field) lifts into v2 with setupCompleted=false", () => {
    const storage = createMockStorage({
      [LEGACY_SETTINGS_STORAGE_KEY]: JSON.stringify({
        haikuConfidenceCutoff: 0.9,
        // no setupCompleted — pre-T-W.7 v1 user
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().setupCompleted).toBe(false);
    const persisted = JSON.parse(storage.inspect()[SETTINGS_STORAGE_KEY]!);
    expect(persisted.setupCompleted).toBe(false);
  });

  it("v2 payload missing the field reads as false (existing user without wizard run)", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        telemetryEnabled: true,
        // no setupCompleted — existing v2 user from before T-W.7
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().setupCompleted).toBe(false);
    expect(store.getState().telemetryEnabled).toBe(true);
  });

  it("malformed setupCompleted value coerces to default (false)", () => {
    const storage = createMockStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        setupCompleted: "yes",
      }),
    });
    const store = createSettingsStore({ storage });
    expect(store.getState().setupCompleted).toBe(false);
  });
});
