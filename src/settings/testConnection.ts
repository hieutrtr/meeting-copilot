// Phase 3 T-3.6 — STT provider "Test connection" seam.
//
// The Settings sheet exposes a button that round-trips a tiny request through
// the selected STT adapter. Phase 3 ships the prop-injected seam below; the
// live network handshake lives in the Rust adapter (T-3.2 Deepgram +
// T-3.4 ElevenLabs) and is wired in via Tauri command in T-3.10.
//
// Splitting along this seam keeps T-3.6's component test deterministic
// (vitest passes a stub mock) without any `fetch` polyfill or live network.

import type { SttProviderId } from "../llm/sttPricing";

export interface TestConnectionResult {
  ok: boolean;
  /** Short human-readable status (rendered into the status pill). */
  message: string;
  /** Round-trip latency the caller measured, in ms. 0 for skipped/local paths. */
  latencyMs: number;
}

export type TestConnectionFn = (
  provider: SttProviderId,
  apiKey: string,
) => Promise<TestConnectionResult>;

// Default stub used when no override is supplied. MLX / fake are local and
// always succeed; cloud providers fail gracefully if the key is empty (the
// adapter would otherwise return SttError::Config). The Tauri-wired live impl
// lands as a follow-up in T-3.10 (sandbox-blocked here per Phase 1+2 carry-
// forward note on missing cargo / live-network in the loop runner).
export const defaultTestSttConnection: TestConnectionFn = async (
  provider,
  apiKey,
) => {
  if (provider === "mlx" || provider === "fake") {
    return {
      ok: true,
      message:
        provider === "mlx"
          ? "MLX local — no key required"
          : "Fake provider — deterministic stub",
      latencyMs: 0,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      message: `${labelFor(provider)}: API key missing — set it above or export ${envVarFor(provider)}`,
      latencyMs: 0,
    };
  }
  // No live wiring yet — return a placeholder "not wired" failure so the
  // user knows the click registered but the live path is not connected. The
  // RTL test passes a deterministic mock and never hits this branch.
  return {
    ok: false,
    message: `${labelFor(provider)}: live test connection not wired in this build`,
    latencyMs: 0,
  };
};

export function labelFor(provider: SttProviderId): string {
  switch (provider) {
    case "mlx":
      return "MLX";
    case "fake":
      return "Fake";
    case "deepgram":
      return "Deepgram";
    case "elevenlabs":
      return "ElevenLabs";
  }
}

export function envVarFor(provider: SttProviderId): string {
  switch (provider) {
    case "deepgram":
      return "DEEPGRAM_API_KEY";
    case "elevenlabs":
      return "ELEVENLABS_API_KEY";
    default:
      return "";
  }
}

export function requiresApiKey(provider: SttProviderId): boolean {
  return provider === "deepgram" || provider === "elevenlabs";
}
