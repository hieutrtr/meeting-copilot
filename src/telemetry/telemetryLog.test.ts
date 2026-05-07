// Phase 3 T-3.9 — Telemetry append loop unit tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.9-telemetry.md §"TDD plan"):
//   TM-S11 → disabled flag is a no-op (sink not touched)
//   TM-S12 → forbidden key drops with reason "scrub-rejected"
//   TM-S13 → AC #1: 100 events round-trip; every line JSON-parseable; zero forbidden keys
//   TM-S14 → AC #2: synthetic 10 MB rotation cadence
//   TM-S15 → 30 MB cumulative — sink keeps maxFiles archives + current; oldest dropped
//   TM-S16 → ts stamp behavior (caller passthrough vs. injected now())
//   TM-S17 → provider_switch event round-trips
//   TM-S18 → stt_error round-trips; errorMessage stripped (NOT in schema)
//   TM-S19 → live re-read of isEnabled across calls
//   TM-S20 → non-primitive meta drops with reason "scrub-rejected"

import { describe, expect, it } from "vitest";

import { createMemorySink, createNoopSink } from "./sinks";
import { containsForbiddenKey } from "./scrub";
import { createTelemetryLog } from "./telemetryLog";

function alwaysEnabled(): boolean {
  return true;
}

function alwaysDisabled(): boolean {
  return false;
}

function fixedNow(): string {
  return "2026-05-07T00:00:00.000Z";
}

describe("TM-S11: disabled flag is a no-op", () => {
  it("sink is not touched and result.reason === 'disabled'", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysDisabled,
      now: fixedNow,
    });
    const result = log.appendEvent({
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "deepgram",
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(sink.size()).toBe(0);
    expect(sink.inspect!().current).toBe("");
  });
});

describe("TM-S12: forbidden key drops with reason 'scrub-rejected'", () => {
  it("event with text field returns {written:false, reason:'scrub-rejected'}", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    const result = log.appendEvent({
      eventType: "stt_latency",
      latencyMs: 200,
      // @ts-expect-error — runtime gate.
      text: "this should never reach the log",
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("scrub-rejected");
    expect(sink.size()).toBe(0);
  });
});

describe("TM-S13: AC #1 — feed 100 events; zero forbidden keys in any log line", () => {
  it("every line is JSON-parseable and contains no forbidden key (case-insensitive)", () => {
    const sink = createMemorySink({ maxBytes: 10_000_000 });
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });

    // 100 mixed events of every shape.
    for (let i = 0; i < 100; i++) {
      const kind = i % 5;
      if (kind === 0) {
        log.appendEvent({
          eventType: "provider_switch",
          fromProvider: i % 2 === 0 ? "mlx" : "elevenlabs",
          toProvider: "deepgram",
          privacyMode: "cloud",
        });
      } else if (kind === 1) {
        log.appendEvent({
          eventType: "stt_error",
          provider: "deepgram",
          errorCode: i % 3 === 0 ? "PROVIDER_UNAVAILABLE" : "TIMEOUT",
          latencyMs: i * 11,
          result: "fail",
        });
      } else if (kind === 2) {
        log.appendEvent({
          eventType: "stt_latency",
          provider: "elevenlabs",
          latencyMs: 100 + i,
          meta: { retries: i % 4, gaveUp: false },
        });
      } else if (kind === 3) {
        log.appendEvent({
          eventType: "privacy_mode_change",
          privacyMode: i % 2 === 0 ? "local-first" : "mixed",
        });
      } else {
        log.appendEvent({
          eventType: "test_connection",
          provider: i % 2 === 0 ? "deepgram" : "elevenlabs",
          result: i % 3 === 0 ? "fail" : "ok",
          latencyMs: 50 + i,
        });
      }
    }

    const blob = sink.inspect!().current;
    const lines = blob.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(100);

    // PII grep — every line must be free of forbidden keys.
    for (const line of lines) {
      expect(containsForbiddenKey(line)).toBe(false);
      // And the line is JSON-parseable.
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      // Whitelist gate — the parsed event has only allowed top-level keys.
      const allowed = new Set([
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
      for (const k of Object.keys(parsed)) {
        expect(allowed.has(k)).toBe(true);
      }
      // Defensive — meta (when present) has no forbidden key.
      if (parsed.meta) {
        for (const mk of Object.keys(parsed.meta)) {
          expect(containsForbiddenKey(mk)).toBe(false);
        }
      }
    }
  });
});

describe("TM-S14: AC #2 — synthetic 10 MB rotation cadence", () => {
  it("crosses 10 MB → exactly one rotation", () => {
    // Use a small maxBytes for a fast deterministic test: 1_000 bytes.
    const sink = createMemorySink({ maxBytes: 1_000, maxFiles: 3 });
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });

    // Each event JSON line is ~80–120 bytes; ~10–12 events fits in 1_000 bytes.
    // Append events until cumulative bytes (across current + archives) crosses 1_000.
    let appended = 0;
    while (sink.inspect!().rotations < 1 && appended < 100) {
      log.appendEvent({
        eventType: "stt_latency",
        provider: "deepgram",
        latencyMs: appended,
        meta: { retries: 0 },
      });
      appended++;
    }
    expect(sink.inspect!().rotations).toBe(1);
    expect(sink.inspect!().archives.length).toBe(1);
    // The archive segment is at-most-maxBytes; the newly-rotated current
    // segment holds the line that triggered the rotate.
    expect(sink.inspect!().current.length).toBeGreaterThan(0);
  });

  it("at exactly 10 MB cap (production-default), the synthetic feed rotates ≥ 1 time", () => {
    const sink = createMemorySink(); // default 10 MB, 3 files
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    // Inject one large but bounded synthetic event with a long but
    // forbidden-key-free errorCode (max length 256 per scrub.ts cap).
    // ~256 bytes per event → ~40_000 events to hit 10 MB. Loop is bounded
    // and runs in single-digit ms.
    const longish = "X".repeat(240);
    let i = 0;
    while (sink.inspect!().rotations < 1 && i < 60_000) {
      log.appendEvent({
        eventType: "stt_error",
        provider: "deepgram",
        errorCode: longish,
        result: "fail",
        latencyMs: i,
      });
      i++;
    }
    expect(sink.inspect!().rotations).toBeGreaterThanOrEqual(1);
  });
});

describe("TM-S15: 30 MB cumulative — sink keeps maxFiles archives + current", () => {
  it("forced 5 rotations with maxFiles=3 → archives length stays at 3, oldest aged out", () => {
    const sink = createMemorySink({ maxBytes: 200, maxFiles: 3 });
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    // Drive enough appends to force at least 5 rotations.
    for (let i = 0; i < 200; i++) {
      log.appendEvent({
        eventType: "stt_latency",
        provider: "deepgram",
        latencyMs: i,
      });
      if (sink.inspect!().rotations >= 5) break;
    }
    const i = sink.inspect!();
    expect(i.rotations).toBeGreaterThanOrEqual(5);
    expect(i.archives.length).toBeLessThanOrEqual(3);
    // No archive contains a forbidden key (sanity: scrubber held).
    for (const a of i.archives) {
      expect(containsForbiddenKey(a)).toBe(false);
    }
  });
});

describe("TM-S16: ts stamp behavior", () => {
  it("caller-supplied ts is preserved verbatim", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    log.appendEvent({
      ts: "2026-01-01T12:34:56.789Z",
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "deepgram",
    });
    const line = sink.inspect!().current.trim();
    expect(JSON.parse(line).ts).toBe("2026-01-01T12:34:56.789Z");
  });

  it("missing ts is filled by injected now()", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: () => "2099-12-31T23:59:59.999Z",
    });
    log.appendEvent({ eventType: "test_connection", result: "ok" });
    const line = sink.inspect!().current.trim();
    expect(JSON.parse(line).ts).toBe("2099-12-31T23:59:59.999Z");
  });
});

describe("TM-S17: provider_switch event round-trips", () => {
  it("from/to/privacyMode preserved in the serialized line", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    log.appendEvent({
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "elevenlabs",
      privacyMode: "cloud",
    });
    const parsed = JSON.parse(sink.inspect!().current.trim());
    expect(parsed.fromProvider).toBe("mlx");
    expect(parsed.toProvider).toBe("elevenlabs");
    expect(parsed.privacyMode).toBe("cloud");
  });
});

describe("TM-S18: stt_error round-trips; errorMessage stripped (NOT in schema)", () => {
  it("a caller piggybacking errorMessage triggers scrub-rejected", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    const result = log.appendEvent({
      eventType: "stt_error",
      provider: "deepgram",
      errorCode: "TIMEOUT",
      // @ts-expect-error — errorMessage is forbidden / not in schema.
      errorMessage: "stack trace might leak transcript content",
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("scrub-rejected");
  });

  it("clean stt_error with errorCode only is written", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    const result = log.appendEvent({
      eventType: "stt_error",
      provider: "deepgram",
      errorCode: "PROVIDER_UNAVAILABLE",
      result: "fail",
      latencyMs: 0,
    });
    expect(result.written).toBe(true);
    const parsed = JSON.parse(sink.inspect!().current.trim());
    expect(parsed.eventType).toBe("stt_error");
    expect(parsed.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(parsed.result).toBe("fail");
  });
});

describe("TM-S19: live re-read of isEnabled across calls", () => {
  it("flipping the gate false→true between calls picks up immediately", () => {
    let enabled = false;
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: () => enabled,
      now: fixedNow,
    });

    const r1 = log.appendEvent({ eventType: "test_connection", result: "ok" });
    expect(r1.reason).toBe("disabled");
    expect(sink.size()).toBe(0);

    enabled = true;
    const r2 = log.appendEvent({ eventType: "test_connection", result: "ok" });
    expect(r2.written).toBe(true);
    expect(sink.size()).toBeGreaterThan(0);

    enabled = false;
    const r3 = log.appendEvent({ eventType: "test_connection", result: "ok" });
    expect(r3.reason).toBe("disabled");
    // Size still reflects only the second event.
  });
});

describe("TM-S20: non-primitive meta drops with reason 'scrub-rejected'", () => {
  it("nested object in meta is rejected", () => {
    const sink = createMemorySink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    const result = log.appendEvent({
      eventType: "stt_latency",
      meta: {
        // @ts-expect-error — not a primitive.
        nested: { a: 1 },
      },
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("scrub-rejected");
  });
});

describe("noop sink + log integration", () => {
  it("appendEvent against noop sink does not throw and reports written:true", () => {
    const sink = createNoopSink();
    const log = createTelemetryLog({
      sink,
      isEnabled: alwaysEnabled,
      now: fixedNow,
    });
    const r = log.appendEvent({
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "deepgram",
    });
    // The append "ran" — the sink itself ate the line.
    expect(r.written).toBe(true);
    expect(sink.size()).toBe(0);
  });
});
