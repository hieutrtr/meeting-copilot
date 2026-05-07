// Phase 2 T-2.9 — Settings store: detector sensitivity + Haiku toggle +
// cost-guard limit, persisted to localStorage.
// Phase 3 T-3.6 — extended with STT provider picker + per-provider API keys.
// Schema bumped to `:v2` with first-read migration from `:v1`.
//
// Pipeline position (per ARCH §5.1 + Phase 3 INDEX dep graph):
//   T-2.1 heuristic (no knob) ─┐
//   T-2.2 sliding window ──────┤
//   T-2.3 Haiku filter ────────┼─→ THIS store ──→ T-2.10 E2E + T-3.6 SettingsSheet
//   T-2.7 cost guard ──────────┤
//   T-3.5 STT cost meter ──────┘
//
// Invariants:
//   1. Pure factory + module-level singleton. The factory takes an injected
//      `Storage` so tests can pass a Map-backed mock without DOM.
//   2. Defaults match the source-of-truth constants verbatim
//      (`HAIKU_ADMIT_THRESHOLD`, `DEFAULT_SILENCE_MS`,
//      `DEFAULT_THRESHOLD_USD_PER_HOUR`). Drift between the store and any of
//      those constants is a Phase-2 bug. STT provider default is `"mlx"`
//      (privacy-first; matches ARCH §11 "Local-first" mode).
//   3. Setters clamp out-of-range numeric inputs to the documented bounds and
//      reject NaN (state unchanged) so the downstream pipeline never sees a
//      degenerate cutoff/threshold. `setSttProvider` rejects unknown ids.
//   4. Storage writes are best-effort. A throwing `setItem` (quota exceeded,
//      security policy) is swallowed — settings reads never fail; persistence
//      is the one part that may degrade.
//   5. Versioned storage key (`meeting-copilot:settings:v2`). On first read
//      we look for v2; if absent we fall back to v1 and lift the payload
//      into v2 shape (zero-filling new keys), then write v2 back. The v1 key
//      is left in place (non-destructive — survives a downgrade rollback).
//   6. API keys are stored verbatim in the same `localStorage` slot as the
//      rest of settings. Empty string == "fall back to env-var at adapter
//      construction time" (the Rust factory already reads `DEEPGRAM_API_KEY`
//      / `ELEVENLABS_API_KEY`). Phase 3.x will swap `defaultStorage()` for a
//      Tauri-keychain-backed `StorageLike` — single point of change.

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
import { isSttProviderId, type SttProviderId } from "../llm/sttPricing";
import {
  DEFAULT_PRIVACY_MODE,
  fallbackSttProviderFor,
  isPrivacyMode,
  isSttProviderAllowed,
  type PrivacyMode,
} from "../privacy/privacyMode";

export const SETTINGS_STORAGE_KEY = "meeting-copilot:settings:v2" as const;
export const LEGACY_SETTINGS_STORAGE_KEY = "meeting-copilot:settings:v1" as const;

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

// Phase 3 T-3.6 — keys we hold local API keys for. MLX / fake do not need a
// remote credential, so they are absent from this map. Adding a new cloud
// provider means adding a key here AND extending `SttProviderId`.
export interface SettingsApiKeys {
  deepgram: string;
  elevenlabs: string;
}

export type ApiKeyProvider = keyof SettingsApiKeys;

export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = Object.freeze([
  "deepgram",
  "elevenlabs",
]);

export function isApiKeyProvider(value: unknown): value is ApiKeyProvider {
  return value === "deepgram" || value === "elevenlabs";
}

export interface SettingsValues {
  haikuConfidenceCutoff: number;
  haikuEnabled: boolean;
  silenceThresholdMs: number;
  costGuardThresholdUsdPerHour: number;
  costGuardPaused: boolean;
  // Phase 3 T-3.6 additions
  sttProvider: SttProviderId;
  apiKeys: SettingsApiKeys;
  // Phase 3 T-3.8 addition — ARCH §11 privacy mode. Default `"local-first"`
  // (audio never leaves the machine) per the plan note "opt-in cloud explicit".
  privacyMode: PrivacyMode;
  // Phase 3 T-3.9 addition — opt-in local telemetry log (provider switches,
  // errors, latencies). Default `false` per AC: the user must explicitly
  // turn this on. The append loop reads this flag on EVERY event so toggling
  // takes effect on the next provider event with no restart.
  telemetryEnabled: boolean;
  // Phase-W T-W.7 addition — gate flag for the BlackHole Setup Wizard. Default
  // `false` so a fresh install (or a v1/v2-without-this-key payload) sees the
  // wizard on first launch. The wizard sets it to `true` when the user
  // completes the Done step. App.tsx reads this to decide whether to render
  // `<SetupWizard />` or the meeting UI.
  setupCompleted: boolean;
}

export interface SettingsState extends SettingsValues {
  setHaikuConfidenceCutoff: (n: number) => void;
  setHaikuEnabled: (b: boolean) => void;
  setSilenceThresholdMs: (n: number) => void;
  setCostGuardThresholdUsdPerHour: (n: number) => void;
  setCostGuardPaused: (b: boolean) => void;
  // Phase 3 T-3.6 additions
  setSttProvider: (provider: SttProviderId) => void;
  setApiKey: (provider: ApiKeyProvider, key: string) => void;
  // Phase 3 T-3.8 addition — auto-reverts `sttProvider` to the LCM allowed
  // provider (`"mlx"`) when the requested mode disallows the current pick.
  setPrivacyMode: (mode: PrivacyMode) => void;
  // Phase 3 T-3.9 addition — opt-in telemetry toggle.
  setTelemetryEnabled: (b: boolean) => void;
  // Phase-W T-W.7 — wizard sign-off; flips the gate flag App.tsx reads.
  setSetupCompleted: (b: boolean) => void;
  reset: () => void;
}

export interface CreateSettingsStoreOptions {
  storage?: StorageLike | null;
  storageKey?: string;
  legacyStorageKey?: string;
}

export const SETTINGS_DEFAULTS: SettingsValues = {
  haikuConfidenceCutoff: HAIKU_ADMIT_THRESHOLD,
  haikuEnabled: true,
  silenceThresholdMs: DEFAULT_SILENCE_MS,
  costGuardThresholdUsdPerHour: DEFAULT_THRESHOLD_USD_PER_HOUR,
  costGuardPaused: false,
  sttProvider: "mlx",
  apiKeys: { deepgram: "", elevenlabs: "" },
  privacyMode: DEFAULT_PRIVACY_MODE,
  telemetryEnabled: false,
  setupCompleted: false,
};

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function coerceApiKeys(raw: unknown): SettingsApiKeys {
  const fallback: SettingsApiKeys = { ...SETTINGS_DEFAULTS.apiKeys };
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    deepgram: typeof r.deepgram === "string" ? r.deepgram : fallback.deepgram,
    elevenlabs:
      typeof r.elevenlabs === "string" ? r.elevenlabs : fallback.elevenlabs,
  };
}

function coerceLoaded(raw: unknown): SettingsValues {
  if (!raw || typeof raw !== "object") return cloneDefaults();
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
    sttProvider: isSttProviderId(r.sttProvider)
      ? r.sttProvider
      : SETTINGS_DEFAULTS.sttProvider,
    apiKeys: coerceApiKeys(r.apiKeys),
    privacyMode: isPrivacyMode(r.privacyMode)
      ? r.privacyMode
      : SETTINGS_DEFAULTS.privacyMode,
    telemetryEnabled:
      typeof r.telemetryEnabled === "boolean"
        ? r.telemetryEnabled
        : SETTINGS_DEFAULTS.telemetryEnabled,
    setupCompleted:
      typeof r.setupCompleted === "boolean"
        ? r.setupCompleted
        : SETTINGS_DEFAULTS.setupCompleted,
  };
}

function cloneDefaults(): SettingsValues {
  return {
    ...SETTINGS_DEFAULTS,
    apiKeys: { ...SETTINGS_DEFAULTS.apiKeys },
  };
}

function readJsonItem(
  storage: StorageLike | null | undefined,
  key: string,
): unknown | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadFromStorage(
  storage: StorageLike | null | undefined,
  key: string,
  legacyKey: string,
): SettingsValues {
  if (!storage) return cloneDefaults();

  const v2 = readJsonItem(storage, key);
  if (v2 != null) {
    return coerceLoaded(v2);
  }

  // No v2 payload — try the v1 key. Lift via the same coercion (v2 keys
  // missing from a v1 payload zero-fill to defaults). Persist back as v2 so
  // future reads skip the legacy lookup. Leave v1 in place — non-destructive,
  // a downgrade rollback can recover.
  const v1 = readJsonItem(storage, legacyKey);
  if (v1 != null) {
    const lifted = coerceLoaded(v1);
    persistToStorage(storage, key, lifted);
    return lifted;
  }

  return cloneDefaults();
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
    sttProvider: s.sttProvider,
    apiKeys: { ...s.apiKeys },
    privacyMode: s.privacyMode,
    telemetryEnabled: s.telemetryEnabled,
    setupCompleted: s.setupCompleted,
  };
}

export function createSettingsStore(
  opts?: CreateSettingsStoreOptions,
): UseBoundStore<StoreApi<SettingsState>> {
  const storage = opts?.storage ?? null;
  const key = opts?.storageKey ?? SETTINGS_STORAGE_KEY;
  const legacyKey = opts?.legacyStorageKey ?? LEGACY_SETTINGS_STORAGE_KEY;
  const initial = loadFromStorage(storage, key, legacyKey);

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
    setSttProvider: (provider: SttProviderId) => {
      if (!isSttProviderId(provider)) return;
      set({ sttProvider: provider });
      persistToStorage(storage, key, pickValues(get()));
    },
    setApiKey: (provider: ApiKeyProvider, value: string) => {
      if (!isApiKeyProvider(provider)) return;
      if (typeof value !== "string") return;
      const current = get().apiKeys;
      const nextKeys: SettingsApiKeys = { ...current, [provider]: value };
      set({ apiKeys: nextKeys });
      persistToStorage(storage, key, pickValues(get()));
    },
    setPrivacyMode: (mode: PrivacyMode) => {
      if (!isPrivacyMode(mode)) return;
      const current = get().sttProvider;
      // Auto-revert: if the current STT provider is not allowed under the new
      // mode, snap it back to the LCM provider in the same set() call so the
      // UI re-render sees a consistent (mode, provider) pair.
      if (!isSttProviderAllowed(mode, current)) {
        set({ privacyMode: mode, sttProvider: fallbackSttProviderFor(mode) });
      } else {
        set({ privacyMode: mode });
      }
      persistToStorage(storage, key, pickValues(get()));
    },
    setTelemetryEnabled: (b: boolean) => {
      set({ telemetryEnabled: !!b });
      persistToStorage(storage, key, pickValues(get()));
    },
    setSetupCompleted: (b: boolean) => {
      set({ setupCompleted: !!b });
      persistToStorage(storage, key, pickValues(get()));
    },
    reset: () => {
      set(cloneDefaults());
      persistToStorage(storage, key, cloneDefaults());
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
