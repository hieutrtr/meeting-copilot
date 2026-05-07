// Phase 3 T-3.9 — Telemetry PII scrubber.
//
// Single source of truth for which fields must NEVER reach the telemetry log.
// The append loop (`createTelemetryLog`) walks every event through this
// scrubber before serialization; the test harness also greps the SERIALIZED
// JSON line for the same forbidden key list as a defense-in-depth gate.
//
// Drop-on-suspect: any forbidden key, even one piggybacked on a structured
// event by a buggy upstream caller using `as any`, drops the WHOLE event.
// Partial writes are not safe — a field rename like `transcript` →
// `transcriptText` should fail the gate, not slip through with the original
// key removed.
//
// Allow-list, not deny-list, for the event shape itself: only fields enumerated
// in `ALLOWED_KEYS` are forwarded. Unknown top-level fields cause a drop. This
// keeps the log schema stable and prevents accidental field exfiltration via a
// future upstream typo.

import { isSttProviderId, type SttProviderId } from "../llm/sttPricing";
import { isPrivacyMode, type PrivacyMode } from "../privacy/privacyMode";

export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "text",
  "transcript",
  "transcriptText",
  "transcript_text",
  "pcm",
  "pcmFrame",
  "pcm_frame",
  "audio",
  "audioBytes",
  "audio_bytes",
  "apiKey",
  "api_key",
  "secret",
  "password",
  "key",
  "token",
  "errorMessage", // free-form messages may echo transcript via stack trace
  "error_message",
]);

const FORBIDDEN_KEYS_LOWER: readonly string[] = Object.freeze(
  FORBIDDEN_KEYS.map((k) => k.toLowerCase()),
);

export const TELEMETRY_EVENT_TYPES = Object.freeze([
  "provider_switch",
  "stt_error",
  "stt_latency",
  "privacy_mode_change",
  "test_connection",
] as const);

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export function isTelemetryEventType(value: unknown): value is TelemetryEventType {
  return (
    typeof value === "string" &&
    (TELEMETRY_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export type TelemetryMetaPrimitive = string | number | boolean | null;
export type TelemetryMeta = Readonly<Record<string, TelemetryMetaPrimitive>>;

export interface TelemetryEvent {
  /** ISO-8601 string. Stamped by the appender if missing. */
  ts?: string;
  eventType: TelemetryEventType;
  provider?: SttProviderId;
  fromProvider?: SttProviderId;
  toProvider?: SttProviderId;
  privacyMode?: PrivacyMode;
  latencyMs?: number;
  errorCode?: string;
  result?: "ok" | "fail";
  meta?: TelemetryMeta;
}

const ALLOWED_KEYS: readonly string[] = Object.freeze([
  "ts",
  "eventType",
  "provider",
  "fromProvider",
  "toProvider",
  "privacyMode",
  "latencyMs",
  "errorCode",
  "result",
  "meta",
]);

/**
 * Substring grep the test harness reuses to assert no forbidden key appears
 * in a serialized log line. Case-insensitive — defends against camelCase /
 * snake_case drift.
 */
export function containsForbiddenKey(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  const lower = s.toLowerCase();
  for (const key of FORBIDDEN_KEYS_LOWER) {
    if (lower.includes(key)) return true;
  }
  return false;
}

function isForbiddenKeyName(key: string): boolean {
  return FORBIDDEN_KEYS_LOWER.includes(key.toLowerCase());
}

function isAllowedMetaPrimitive(v: unknown): v is TelemetryMetaPrimitive {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function scrubMeta(raw: unknown): TelemetryMeta | null | "drop" {
  if (raw === undefined) return null; // not present is fine
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "drop";
  }
  const out: Record<string, TelemetryMetaPrimitive> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isForbiddenKeyName(k)) return "drop";
    if (!isAllowedMetaPrimitive(v)) return "drop";
  }
  // Second pass — only after we've vetted every key/value.
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = v as TelemetryMetaPrimitive;
  }
  return Object.freeze(out);
}

/**
 * Walk a candidate telemetry event. Returns the safe event on success, or
 * `null` when any forbidden key, unknown top-level field, or out-of-shape
 * value is encountered.
 *
 * The function does NOT throw — telemetry must NEVER crash the caller.
 */
export function scrubEvent(raw: unknown): TelemetryEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // Allow-list gate: any unknown top-level key is a hard drop.
  for (const k of Object.keys(r)) {
    if (!ALLOWED_KEYS.includes(k)) return null;
    if (isForbiddenKeyName(k)) return null; // belt+suspenders (allow-list already excludes)
  }

  if (!isTelemetryEventType(r.eventType)) return null;

  const out: TelemetryEvent = { eventType: r.eventType };

  if (r.ts !== undefined) {
    if (typeof r.ts !== "string" || r.ts.length === 0) return null;
    out.ts = r.ts;
  }

  if (r.provider !== undefined) {
    if (!isSttProviderId(r.provider)) return null;
    out.provider = r.provider;
  }
  if (r.fromProvider !== undefined) {
    if (!isSttProviderId(r.fromProvider)) return null;
    out.fromProvider = r.fromProvider;
  }
  if (r.toProvider !== undefined) {
    if (!isSttProviderId(r.toProvider)) return null;
    out.toProvider = r.toProvider;
  }
  if (r.privacyMode !== undefined) {
    if (!isPrivacyMode(r.privacyMode)) return null;
    out.privacyMode = r.privacyMode;
  }
  if (r.latencyMs !== undefined) {
    if (typeof r.latencyMs !== "number" || !Number.isFinite(r.latencyMs)) {
      return null;
    }
    out.latencyMs = r.latencyMs;
  }
  if (r.errorCode !== undefined) {
    if (typeof r.errorCode !== "string") return null;
    // Sanity cap — error codes are short stable enums; a long string is a
    // smell that someone shoved a stack trace through.
    if (r.errorCode.length > 256) return null;
    if (containsForbiddenKey(r.errorCode)) return null;
    out.errorCode = r.errorCode;
  }
  if (r.result !== undefined) {
    if (r.result !== "ok" && r.result !== "fail") return null;
    out.result = r.result;
  }

  const meta = scrubMeta(r.meta);
  if (meta === "drop") return null;
  if (meta !== null) out.meta = meta;

  return out;
}
