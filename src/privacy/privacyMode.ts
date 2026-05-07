// Phase 3 T-3.8 — Privacy mode constraint matrix.
//
// ARCH §11 "Privacy Modes" (lines 395–408) — three modes constrain which STT/TTS
// providers may be selected:
//
//   | Mode        | STT      | TTS               | Audio leaves machine? |
//   | Local-first | MLX only | Local / off      | NO                     |
//   | Cloud       | Any      | ElevenLabs       | YES (full audio)       |
//   | Mixed       | MLX only | ElevenLabs       | NO (text out only)     |
//
// This module is the **single source of truth** for the matrix. The Rust
// backend has a parallel matrix in `crates/stt-mlx/src/providers/privacy.rs`;
// the parity gate is `STT_PROVIDER_IDS` ≡ `ProviderKind::as_str()` (T-3.5
// ST-S9 already pins this) plus dual matrix tests on the cloud-allows-all row.
//
// Pure module: no React, no zustand, no DOM. The setting picker (T-3.8 UI)
// reads `availableSttProviders(mode)` + `tooltipFor(mode, provider)`; the
// store's `setPrivacyMode` setter reads `isSttProviderAllowed` to decide whether
// to auto-revert a now-disallowed provider back to `"mlx"`.

import { isSttProviderId, type SttProviderId } from "../llm/sttPricing";

export type PrivacyMode = "local-first" | "cloud" | "mixed";

export const PRIVACY_MODES: readonly PrivacyMode[] = Object.freeze([
  "local-first",
  "cloud",
  "mixed",
]);

export const DEFAULT_PRIVACY_MODE: PrivacyMode = "local-first";

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return value === "local-first" || value === "cloud" || value === "mixed";
}

// MLX + fake are local stubs / local model — always allowed.
// Deepgram + ElevenLabs are cloud STT — only allowed under Cloud mode.
// Mixed mode keeps STT *local* (MLX) and only opens cloud for the TTS surface
// (per ARCH §11 line 403): "Mixed: STT MLX local · TTS ElevenLabs · Audio local".
const STT_MATRIX: Record<PrivacyMode, ReadonlySet<SttProviderId>> = {
  "local-first": new Set<SttProviderId>(["mlx", "fake"]),
  "cloud": new Set<SttProviderId>(["mlx", "fake", "deepgram", "elevenlabs"]),
  "mixed": new Set<SttProviderId>(["mlx", "fake"]),
};

// Cloud TTS is allowed under Cloud + Mixed (per ARCH §11 line 403); blocked
// under Local-first.
const TTS_ALLOWED: Record<PrivacyMode, boolean> = {
  "local-first": false,
  "cloud": true,
  "mixed": true,
};

const HUMAN_MODE_LABEL: Record<PrivacyMode, string> = {
  "local-first": "Local-first",
  "cloud": "Cloud",
  "mixed": "Mixed",
};

export function labelForPrivacyMode(mode: PrivacyMode): string {
  return HUMAN_MODE_LABEL[mode];
}

export function isSttProviderAllowed(
  mode: PrivacyMode,
  provider: SttProviderId,
): boolean {
  if (!isPrivacyMode(mode)) return false;
  if (!isSttProviderId(provider)) return false;
  return STT_MATRIX[mode].has(provider);
}

export function isTtsAllowed(mode: PrivacyMode): boolean {
  return TTS_ALLOWED[mode] === true;
}

export function availableSttProviders(
  mode: PrivacyMode,
): readonly SttProviderId[] {
  // Stable order: keep `STT_PROVIDER_IDS` order from sttPricing so picker
  // reordering doesn't surprise users on a mode switch.
  const allowed = STT_MATRIX[mode];
  return Object.freeze(
    (["mlx", "fake", "deepgram", "elevenlabs"] as const).filter((id) =>
      allowed.has(id),
    ),
  );
}

/**
 * Tooltip surfaced on a disabled picker option. Returns `null` when the
 * combination is allowed (UI then renders no `title` attr). The string
 * names the provider, the current mode, and the mode the user should switch
 * to in order to unlock it — matching the pattern from ARCH §11.
 *
 * Stable wording: do NOT include the API key name or environment variable —
 * those are out of scope for the picker tooltip and could leak under a
 * screenshot.
 */
export function tooltipFor(
  mode: PrivacyMode,
  provider: SttProviderId,
): string | null {
  if (isSttProviderAllowed(mode, provider)) return null;
  const modeLabel = HUMAN_MODE_LABEL[mode];
  if (provider === "deepgram") {
    return `Deepgram is a cloud STT provider — disabled in ${modeLabel} mode. Switch to Cloud mode to enable.`;
  }
  if (provider === "elevenlabs") {
    return `ElevenLabs is a cloud STT provider — disabled in ${modeLabel} mode. Switch to Cloud mode to enable.`;
  }
  // MLX + fake are always allowed — the guard above returns early.
  return `${provider} is disabled in ${modeLabel} mode.`;
}

/**
 * Convenience: pick the lowest-common-denominator allowed STT provider for
 * a mode. Used by the store auto-revert when changing modes makes the
 * current provider disallowed. MLX is allowed in every mode, so the
 * fallback is always defined.
 */
export function fallbackSttProviderFor(_mode: PrivacyMode): SttProviderId {
  return "mlx";
}
