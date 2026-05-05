// Phase 2 T-2.9 — Settings store: detector sensitivity + Haiku toggle +
// cost-guard limit, persisted to localStorage.
//
// Pipeline position (per ARCH §5.1 + INDEX dep graph):
//   T-2.1 heuristic (no knob) ─┐
//   T-2.2 sliding window ──────┤
//   T-2.3 Haiku filter ────────┼─→ THIS store ──→ T-2.10 E2E (deterministic
//   T-2.7 cost guard ──────────┘                  config) + Phase-2.x sheet
//
// Invariants:
//   1. Pure factory + module-level singleton. The factory takes an injected
//      `Storage` so tests can pass a Map-backed mock without DOM.
//   2. Defaults match the source-of-truth constants verbatim
//      (`HAIKU_ADMIT_THRESHOLD`, `DEFAULT_SILENCE_MS`,
//      `DEFAULT_THRESHOLD_USD_PER_HOUR`). Drift between the store and any of
//      those constants is a Phase-2 bug.
//   3. Setters clamp out-of-range numeric inputs to the documented bounds and
//      reject NaN (state unchanged) so the downstream pipeline never sees a
//      degenerate cutoff/threshold.
//   4. Storage writes are best-effort. A throwing `setItem` (quota exceeded,
//      security policy) is swallowed — settings reads never fail; persistence
//      is the one part that may degrade.
//   5. Versioned storage key (`meeting-copilot:settings:v1`) so Phase-3
//      provider/model fields can land under `:v2` with a coercion helper.
//
// The Settings store is framework-agnostic state. The Phase-2.x React Settings
// sheet (deferred per spec) wraps it with input controls; T-2.10 E2E uses it
// directly to dial the synthetic-fixture detector to a deterministic config.

import { create, type StoreApi, type UseBoundStore } from "zustand";

import { HAIKU_ADMIT_THRESHOLD } from "../llm/haikuFilter";
import {
  DEFAULT_THRESHOLD_USD_PER_HOUR,
  guardedClassifyWithHaiku,
  type CostGuard,
  type GuardedClassifyOptions,
} from "../cost/costGuard";
import { DEFAULT_SILENCE_MS } from "../detector/sliding-window";
import type { HaikuClassification } from "../llm/haikuFilter";

export const SETTINGS_STORAGE_KEY = "meeting-copilot:settings:v1" as const;

// Documented bounds — see T-2.9-settings.md AC-6.
export const HAIKU_CONFIDENCE_MIN = 0;
export const HAIKU_CONFIDENCE_MAX = 1;
export const SILENCE_MS_MIN = 200;
export const SILENCE_MS_MAX = 10_000;
export const COST_THRESHOLD_MIN = 0;
export const COST_THRESHOLD_MAX = 100;

// A subset of the Web Storage API — enough for `setItem` / `getItem` /
// `removeItem`. Tests pass a Map-backed mock; production passes
// `globalThis.localStorage` (or `null` in environments where it is absent —
// the Tauri webview pre-init window or a pure-Node test runner).
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SettingsValues {
  haikuConfidenceCutoff: number;
  haikuEnabled: boolean;
  silenceThresholdMs: number;
  costGuardThresholdUsdPerHour: number;
  costGuardPaused: boolean;
}

export interface SettingsState extends SettingsValues {
  setHaikuConfidenceCutoff: (n: number) => void;
  setHaikuEnabled: (b: boolean) => void;
  setSilenceThresholdMs: (n: number) => void;
  setCostGuardThresholdUsdPerHour: (n: number) => void;
  setCostGuardPaused: (b: boolean) => void;
  reset: () => void;
}

export interface CreateSettingsStoreOptions {
  storage?: StorageLike | null;
  storageKey?: string;
}

export const SETTINGS_DEFAULTS: SettingsValues = {
  haikuConfidenceCutoff: HAIKU_ADMIT_THRESHOLD,
  haikuEnabled: true,
  silenceThresholdMs: DEFAULT_SILENCE_MS,
  costGuardThresholdUsdPerHour: DEFAULT_THRESHOLD_USD_PER_HOUR,
  costGuardPaused: false,
};

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function coerceLoaded(raw: unknown): SettingsValues {
  if (!raw || typeof raw !== "object") return { ...SETTINGS_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const cutoffRaw = r.haikuConfidenceCutoff;
  const silenceRaw = r.silenceThresholdMs;
  const costRaw = r.costGuardThresholdUsdPerHour;
  return {
    haikuConfidenceCutoff: isFiniteNumber(cutoffRaw)
      ? clamp(cutoffRaw, HAIKU_CONFIDENCE_MIN, HAIKU_CONFIDENCE_MAX)
      : SETTINGS_DEFAULTS.haikuConfidenceCutoff,
    haikuEnabled:
      typeof r.haikuEnabled === "boolean"
        ? r.haikuEnabled
        : SETTINGS_DEFAULTS.haikuEnabled,
    silenceThresholdMs: isFiniteNumber(silenceRaw)
      ? clamp(silenceRaw, SILENCE_MS_MIN, SILENCE_MS_MAX)
      : SETTINGS_DEFAULTS.silenceThresholdMs,
    costGuardThresholdUsdPerHour: isFiniteNumber(costRaw)
      ? clamp(costRaw, COST_THRESHOLD_MIN, COST_THRESHOLD_MAX)
      : SETTINGS_DEFAULTS.costGuardThresholdUsdPerHour,
    costGuardPaused:
      typeof r.costGuardPaused === "boolean"
        ? r.costGuardPaused
        : SETTINGS_DEFAULTS.costGuardPaused,
  };
}

function loadFromStorage(
  storage: StorageLike | null | undefined,
  key: string,
): SettingsValues {
  if (!storage) return { ...SETTINGS_DEFAULTS };
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
  if (raw == null) return { ...SETTINGS_DEFAULTS };
  try {
    return coerceLoaded(JSON.parse(raw));
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function persistToStorage(
  storage: StorageLike | null | undefined,
  key: string,
  values: SettingsValues,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(values));
  } catch {
    // Best-effort. Quota / security policy errors are swallowed; the
    // in-memory state is the source of truth for the live session.
  }
}

function pickValues(s: SettingsValues): SettingsValues {
  return {
    haikuConfidenceCutoff: s.haikuConfidenceCutoff,
    haikuEnabled: s.haikuEnabled,
    silenceThresholdMs: s.silenceThresholdMs,
    costGuardThresholdUsdPerHour: s.costGuardThresholdUsdPerHour,
    costGuardPaused: s.costGuardPaused,
  };
}

export function createSettingsStore(
  opts?: CreateSettingsStoreOptions,
): UseBoundStore<StoreApi<SettingsState>> {
  const storage = opts?.storage ?? null;
  const key = opts?.storageKey ?? SETTINGS_STORAGE_KEY;
  const initial = loadFromStorage(storage, key);

  const store = create<SettingsState>((set, get) => ({
    ...initial,
    setHaikuConfidenceCutoff: (n: number) => {
      if (!isFiniteNumber(n)) return;
      const v = clamp(n, HAIKU_CONFIDENCE_MIN, HAIKU_CONFIDENCE_MAX);
      set({ haikuConfidenceCutoff: v });
      persistToStorage(storage, key, pickValues(get()));
    },
    setHaikuEnabled: (b: boolean) => {
      set({ haikuEnabled: !!b });
      persistToStorage(storage, key, pickValues(get()));
    },
    setSilenceThresholdMs: (n: number) => {
      if (!isFiniteNumber(n)) return;
      const v = clamp(n, SILENCE_MS_MIN, SILENCE_MS_MAX);
      set({ silenceThresholdMs: v });
      persistToStorage(storage, key, pickValues(get()));
    },
    setCostGuardThresholdUsdPerHour: (n: number) => {
      if (!isFiniteNumber(n)) return;
      const v = clamp(n, COST_THRESHOLD_MIN, COST_THRESHOLD_MAX);
      set({ costGuardThresholdUsdPerHour: v });
      persistToStorage(storage, key, pickValues(get()));
    },
    setCostGuardPaused: (b: boolean) => {
      set({ costGuardPaused: !!b });
      persistToStorage(storage, key, pickValues(get()));
    },
    reset: () => {
      set({ ...SETTINGS_DEFAULTS });
      persistToStorage(storage, key, { ...SETTINGS_DEFAULTS });
    },
  }));

  return store;
}

// Default singleton — wired against the real `localStorage` when available.
// Tests should NOT import this; they call `createSettingsStore({ storage })`
// with a Map-backed mock so each test has an isolated store.
function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as unknown as { localStorage?: StorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export const useSettingsStore = createSettingsStore({
  storage: defaultStorage(),
});

// ── Composer wrapper ────────────────────────────────────────────────────────
//
// `classifyWithSettingsGate` is the integration seam the detector pipeline
// uses (Phase 2.x or T-2.10 wiring). Precedence:
//   1. settings.haikuEnabled === false → { status: "skipped-disabled" }
//   2. costGuard.isPaused() === true → { status: "skipped-paused" }
//   3. classify; admit = isQuestion && confidence ≥ cutoff
//
// The cost guard records usage on classification (delegated to
// `guardedClassifyWithHaiku` from T-2.7). The original `result` is preserved
// verbatim so callers retain access to `usage`, `latencyMs`, etc.

export type SettingsGateStatus =
  | "classified"
  | "skipped-disabled"
  | "skipped-paused";

export interface SettingsGateClassified {
  status: "classified";
  result: HaikuClassification;
  admit: boolean;
}

export interface SettingsGateSkipped {
  status: "skipped-disabled" | "skipped-paused";
}

export type SettingsGateResult = SettingsGateClassified | SettingsGateSkipped;

export interface ClassifyFn {
  (text: string, opts?: GuardedClassifyOptions): Promise<HaikuClassification>;
}

export async function classifyWithSettingsGate(
  text: string,
  classify: ClassifyFn,
  settings: SettingsValues,
  guard: CostGuard,
  opts?: GuardedClassifyOptions,
): Promise<SettingsGateResult> {
  if (!settings.haikuEnabled) {
    return { status: "skipped-disabled" };
  }
  const guarded = await guardedClassifyWithHaiku(text, classify, guard, opts);
  if (guarded.status === "skipped-paused") {
    return { status: "skipped-paused" };
  }
  const result = guarded.result!;
  const admit =
    result.isQuestion && result.confidence >= settings.haikuConfidenceCutoff;
  return { status: "classified", result, admit };
}
