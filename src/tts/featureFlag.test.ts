// Phase 3 T-3.7 — TTS feature flag tests.
//
// AC traceability (T-3.7-tts-interface.md):
//   TF-S1 → AC-1 (default off when env var absent)
//   TF-S2 → AC-1 (truthy: "true" / "1" / "on")
//   TF-S3 → AC-1 (falsy literals: "" / "0" / "false" / "off" / "no")
//   TF-S4 → AC-1 (case-insensitive)
//   TF-S5 → AC-1 (unknown string is treated as truthy — opt-in by setting to
//                  any custom token)
//   TF-S6 → AC-1 (non-string values are treated as off)

import { describe, it, expect } from "vitest";

import { readTtsFlag, TTS_FEATURE_FLAG_ENV_VAR } from "./featureFlag";

describe("TTS feature flag — readTtsFlag (T-3.7)", () => {
  it("TF-S1: default off when env var absent", () => {
    expect(readTtsFlag({})).toBe(false);
    expect(readTtsFlag(null)).toBe(false);
    expect(readTtsFlag(undefined)).toBe(false);
  });

  it("TF-S2: truthy for canonical opt-in tokens", () => {
    for (const v of ["true", "1", "on", "yes"]) {
      expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: v })).toBe(true);
    }
  });

  it("TF-S3: falsy for the documented falsy literals", () => {
    for (const v of ["", "0", "false", "off", "no"]) {
      expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: v })).toBe(false);
    }
  });

  it("TF-S4: case-insensitive on falsy literals", () => {
    for (const v of ["FALSE", "False", "OFF", "No"]) {
      expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: v })).toBe(false);
    }
  });

  it("TF-S5: unknown string is treated as truthy (opt-in by any token)", () => {
    // Any non-falsy custom value flips the flag — this is the "opt-in" path
    // for users who set their own token. Documented in featureFlag.ts.
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: "yolo" })).toBe(true);
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: "enabled" })).toBe(true);
  });

  it("TF-S6: non-string values are treated as off", () => {
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: 1 })).toBe(false);
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: true })).toBe(false);
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: null })).toBe(false);
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: undefined })).toBe(false);
    expect(readTtsFlag({ [TTS_FEATURE_FLAG_ENV_VAR]: {} })).toBe(false);
  });

  it("TF-S7: env-var name constant is stable (drift gate for App.tsx wiring)", () => {
    expect(TTS_FEATURE_FLAG_ENV_VAR).toBe("VITE_ENABLE_TTS");
  });
});
