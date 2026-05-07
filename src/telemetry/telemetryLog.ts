// Phase 3 T-3.9 — Telemetry append loop.
//
// Pipeline position (Phase 3):
//   Provider event stream (T-3.x wire-up) ──→ THIS module ──→ TelemetrySink (Phase 3.x file)
//                                                            └─ tests: in-memory sink
//
// Invariants:
//   1. `isEnabled()` is read on EVERY append call. Toggling the flag in the
//      Settings sheet takes effect on the next provider event with no restart.
//   2. When disabled the sink is NEVER touched — no append, no rotate, no size
//      probe. This is the user-facing opt-out promise.
//   3. The scrubber is the privacy gate — `scrubEvent` returns `null` for any
//      forbidden key or unknown field, and the append is dropped with
//      `reason: "scrub-rejected"`.
//   4. `appendEvent` NEVER throws. Telemetry must not crash the caller — a
//      malformed event drops with a result object, not an exception.
//   5. JSON.stringify is wrapped in try/catch (defends against circular refs
//      that the scrubber missed via a future schema extension).

import { scrubEvent, type TelemetryEvent } from "./scrub";
import type { TelemetrySink } from "./sinks";

export interface CreateTelemetryLogOptions {
  sink: TelemetrySink;
  /** Read on every append. Bind to `useSettingsStore.getState().telemetryEnabled`. */
  isEnabled: () => boolean;
  scrub?: typeof scrubEvent;
  /** ISO-8601 timestamp generator. Defaults to `new Date().toISOString()`. */
  now?: () => string;
}

export interface TelemetryAppendResult {
  written: boolean;
  rotated: boolean;
  reason?: "disabled" | "scrub-rejected" | "serialize-failed";
}

export interface TelemetryLog {
  appendEvent(event: TelemetryEvent): TelemetryAppendResult;
  /** Diagnostic — bytes in the sink's current segment. */
  size(): number;
}

const DISABLED_RESULT: TelemetryAppendResult = Object.freeze({
  written: false,
  rotated: false,
  reason: "disabled",
});

const SCRUB_REJECTED_RESULT: TelemetryAppendResult = Object.freeze({
  written: false,
  rotated: false,
  reason: "scrub-rejected",
});

const SERIALIZE_FAILED_RESULT: TelemetryAppendResult = Object.freeze({
  written: false,
  rotated: false,
  reason: "serialize-failed",
});

export function createTelemetryLog(opts: CreateTelemetryLogOptions): TelemetryLog {
  const sink = opts.sink;
  const isEnabled = opts.isEnabled;
  const scrub = opts.scrub ?? scrubEvent;
  const now = opts.now ?? (() => new Date().toISOString());

  function appendEvent(event: TelemetryEvent): TelemetryAppendResult {
    if (!isEnabled()) return DISABLED_RESULT;

    const safe = scrub(event);
    if (safe === null) return SCRUB_REJECTED_RESULT;

    if (safe.ts === undefined) safe.ts = now();

    let line: string;
    try {
      line = JSON.stringify(safe);
    } catch {
      return SERIALIZE_FAILED_RESULT;
    }
    if (typeof line !== "string" || line.length === 0) {
      return SERIALIZE_FAILED_RESULT;
    }

    const beforeSize = sink.size();
    sink.append(line);
    const afterSize = sink.size();
    // Sink rotated iff the post-append byte count is smaller than the pre-call
    // count + (this line's bytes). The simplest check is: post < pre.
    const rotated = afterSize < beforeSize;
    return { written: true, rotated };
  }

  function size(): number {
    return sink.size();
  }

  return { appendEvent, size };
}
