// Phase 3 T-3.8 — Privacy mode constraint matrix unit tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.8-privacy-mode.md):
//   PM-S1       — `PRIVACY_MODES` literal-set parity
//   PM-S2       — `DEFAULT_PRIVACY_MODE` is `"local-first"`
//   PM-S3..S11  — 9-cell STT constraint matrix (3 modes × 3 cloud-or-local STT providers)
//   PM-S12      — `fake` provider always allowed
//   PM-S13..S15 — TTS allowed per mode
//   PM-S16..S18 — `availableSttProviders` returns the right sets per mode
//   PM-S19      — Every blocked cell has a non-empty tooltip naming provider + suggested mode
//   PM-S20      — Defensive: unknown provider id rejected; unknown mode rejected
//   PM-S21      — `availableSttProviders` keeps stable order (regression on UI reorder)
//   PM-S22      — `tooltipFor` returns null for allowed cells (no spurious tooltip)
//   PM-S23      — Parity: Cloud mode allows every `STT_PROVIDER_IDS` entry

import { describe, expect, it } from "vitest";

import { STT_PROVIDER_IDS } from "../llm/sttPricing";

import {
  DEFAULT_PRIVACY_MODE,
  PRIVACY_MODES,
  availableSttProviders,
  fallbackSttProviderFor,
  isPrivacyMode,
  isSttProviderAllowed,
  isTtsAllowed,
  labelForPrivacyMode,
  tooltipFor,
} from "./privacyMode";

describe("PM-S1: PRIVACY_MODES literal set", () => {
  it("contains exactly local-first, cloud, mixed (in stable order)", () => {
    expect([...PRIVACY_MODES]).toEqual(["local-first", "cloud", "mixed"]);
  });

  it("isPrivacyMode accepts each literal and rejects others", () => {
    for (const mode of PRIVACY_MODES) {
      expect(isPrivacyMode(mode)).toBe(true);
    }
    expect(isPrivacyMode("LOCAL-FIRST")).toBe(false);
    expect(isPrivacyMode("offline")).toBe(false);
    expect(isPrivacyMode(null)).toBe(false);
    expect(isPrivacyMode(undefined)).toBe(false);
  });
});

describe("PM-S2: default privacy mode", () => {
  it("DEFAULT_PRIVACY_MODE is 'local-first' (privacy by default per ARCH §11)", () => {
    expect(DEFAULT_PRIVACY_MODE).toBe("local-first");
  });
});

// ── PM-S3..S11: 3×3 constraint matrix (mode × cloud-or-local STT provider) ──

describe("PM-S3: local-first × mlx → ALLOWED", () => {
  it("returns true", () => {
    expect(isSttProviderAllowed("local-first", "mlx")).toBe(true);
  });
});

describe("PM-S4: local-first × deepgram → BLOCKED", () => {
  it("returns false", () => {
    expect(isSttProviderAllowed("local-first", "deepgram")).toBe(false);
  });
});

describe("PM-S5: local-first × elevenlabs → BLOCKED", () => {
  it("returns false", () => {
    expect(isSttProviderAllowed("local-first", "elevenlabs")).toBe(false);
  });
});

describe("PM-S6: cloud × mlx → ALLOWED", () => {
  it("returns true (MLX is always allowed — the LCM provider)", () => {
    expect(isSttProviderAllowed("cloud", "mlx")).toBe(true);
  });
});

describe("PM-S7: cloud × deepgram → ALLOWED", () => {
  it("returns true", () => {
    expect(isSttProviderAllowed("cloud", "deepgram")).toBe(true);
  });
});

describe("PM-S8: cloud × elevenlabs → ALLOWED", () => {
  it("returns true", () => {
    expect(isSttProviderAllowed("cloud", "elevenlabs")).toBe(true);
  });
});

describe("PM-S9: mixed × mlx → ALLOWED", () => {
  it("returns true (Mixed keeps STT local)", () => {
    expect(isSttProviderAllowed("mixed", "mlx")).toBe(true);
  });
});

describe("PM-S10: mixed × deepgram → BLOCKED", () => {
  it("returns false (per ARCH §11 line 403 — Mixed STT is local only)", () => {
    expect(isSttProviderAllowed("mixed", "deepgram")).toBe(false);
  });
});

describe("PM-S11: mixed × elevenlabs → BLOCKED", () => {
  it("returns false (cloud STT blocked under Mixed)", () => {
    expect(isSttProviderAllowed("mixed", "elevenlabs")).toBe(false);
  });
});

describe("PM-S12: fake provider always allowed", () => {
  it("the deterministic test stub is allowed under every mode", () => {
    expect(isSttProviderAllowed("local-first", "fake")).toBe(true);
    expect(isSttProviderAllowed("cloud", "fake")).toBe(true);
    expect(isSttProviderAllowed("mixed", "fake")).toBe(true);
  });
});

// ── PM-S13..S15: TTS allowed per mode ───────────────────────────────────────

describe("PM-S13: TTS blocked in local-first", () => {
  it("isTtsAllowed('local-first') === false", () => {
    expect(isTtsAllowed("local-first")).toBe(false);
  });
});

describe("PM-S14: TTS allowed in cloud", () => {
  it("isTtsAllowed('cloud') === true", () => {
    expect(isTtsAllowed("cloud")).toBe(true);
  });
});

describe("PM-S15: TTS allowed in mixed", () => {
  it("isTtsAllowed('mixed') === true (per ARCH §11 line 403)", () => {
    expect(isTtsAllowed("mixed")).toBe(true);
  });
});

// ── PM-S16..S18: availableSttProviders returns the right sets ───────────────

describe("PM-S16: availableSttProviders('local-first') = [mlx, fake]", () => {
  it("returns exactly the local subset", () => {
    expect([...availableSttProviders("local-first")]).toEqual(["mlx", "fake"]);
  });
});

describe("PM-S17: availableSttProviders('cloud') = every provider", () => {
  it("returns all four providers in stable order", () => {
    expect([...availableSttProviders("cloud")]).toEqual([
      "mlx",
      "fake",
      "deepgram",
      "elevenlabs",
    ]);
  });
});

describe("PM-S18: availableSttProviders('mixed') = [mlx, fake]", () => {
  it("returns the local subset (same as local-first per ARCH §11)", () => {
    expect([...availableSttProviders("mixed")]).toEqual(["mlx", "fake"]);
  });
});

// ── PM-S19: tooltips for blocked cells ──────────────────────────────────────

describe("PM-S19: every blocked cell has a tooltip naming provider + suggested mode", () => {
  const blocked: Array<["local-first" | "cloud" | "mixed", "deepgram" | "elevenlabs"]> = [
    ["local-first", "deepgram"],
    ["local-first", "elevenlabs"],
    ["mixed", "deepgram"],
    ["mixed", "elevenlabs"],
  ];

  for (const [mode, provider] of blocked) {
    it(`tooltipFor("${mode}", "${provider}") names provider and suggests Cloud`, () => {
      const tip = tooltipFor(mode, provider);
      expect(tip).not.toBeNull();
      expect(tip).toMatch(/Switch to Cloud mode/);
      const human = provider === "deepgram" ? "Deepgram" : "ElevenLabs";
      expect(tip).toContain(human);
      expect(tip).toContain(labelForPrivacyMode(mode));
      // Privacy audit: tooltip never includes the env-var name or any key.
      expect(tip).not.toMatch(/_API_KEY/);
    });
  }
});

describe("PM-S22: allowed cells have no tooltip", () => {
  it("tooltipFor returns null when the provider is allowed in the mode", () => {
    expect(tooltipFor("local-first", "mlx")).toBeNull();
    expect(tooltipFor("cloud", "deepgram")).toBeNull();
    expect(tooltipFor("mixed", "fake")).toBeNull();
  });
});

// ── PM-S20: defensive guards ────────────────────────────────────────────────

describe("PM-S20: defensive guards reject unknowns", () => {
  it("unknown provider id → false (no throw)", () => {
    // @ts-expect-error — bogus provider id
    expect(isSttProviderAllowed("local-first", "openai")).toBe(false);
  });

  it("unknown mode → false (no throw)", () => {
    // @ts-expect-error — bogus mode
    expect(isSttProviderAllowed("offline", "mlx")).toBe(false);
  });
});

// ── PM-S21: stable order regression ─────────────────────────────────────────

describe("PM-S21: availableSttProviders keeps stable order across modes", () => {
  it("each subset preserves the canonical [mlx, fake, deepgram, elevenlabs] ordering", () => {
    const canonical = ["mlx", "fake", "deepgram", "elevenlabs"] as const;
    for (const mode of PRIVACY_MODES) {
      const got = [...availableSttProviders(mode)];
      const filtered = canonical.filter((id) => got.includes(id));
      expect(got).toEqual(filtered);
    }
  });
});

// ── PM-S23: parity gate — Cloud mode allows every STT_PROVIDER_IDS entry ────

describe("PM-S23: parity — Cloud mode is a superset of STT_PROVIDER_IDS", () => {
  it("every id in STT_PROVIDER_IDS is allowed under Cloud", () => {
    for (const id of STT_PROVIDER_IDS) {
      expect(isSttProviderAllowed("cloud", id)).toBe(true);
    }
  });
});

// ── Misc: fallback provider ─────────────────────────────────────────────────

describe("fallbackSttProviderFor always returns a mode-allowed provider", () => {
  it("returns 'mlx' for every mode (LCM choice)", () => {
    for (const mode of PRIVACY_MODES) {
      const fallback = fallbackSttProviderFor(mode);
      expect(fallback).toBe("mlx");
      expect(isSttProviderAllowed(mode, fallback)).toBe(true);
    }
  });
});
