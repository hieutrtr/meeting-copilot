// Phase 3 T-3.9 — Telemetry PII scrubber unit tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.9-telemetry.md §"TDD plan"):
//   TM-S1 → top-level `text` field drops the event
//   TM-S2 → forbidden field nested under `meta` drops the event
//   TM-S3 → clean provider_switch event round-trips on the safe fields
//   TM-S4 → containsForbiddenKey grep is case-insensitive substring match
//   TM-S5 → FORBIDDEN_KEYS is the documented list (regression gate)

import { describe, expect, it } from "vitest";

import {
  containsForbiddenKey,
  FORBIDDEN_KEYS,
  scrubEvent,
} from "./scrub";

describe("TM-S1: top-level forbidden key drops the event", () => {
  it("an event with `text` returns null", () => {
    const out = scrubEvent({
      eventType: "stt_latency",
      provider: "deepgram",
      latencyMs: 300,
      // Intentionally bypassing the type via the unknown surface to exercise the runtime gate.
      text: "the user said something private",
    });
    expect(out).toBeNull();
  });

  it("transcript / pcm / audio top-level fields all drop the event", () => {
    for (const k of ["transcript", "pcm", "audio", "apiKey"]) {
      const out = scrubEvent({
        eventType: "provider_switch",
        fromProvider: "mlx",
        toProvider: "deepgram",
        [k]: "secret-value",
      } as unknown);
      expect(out).toBeNull();
    }
  });
});

describe("TM-S2: forbidden field nested under `meta` drops the event", () => {
  it("`meta.transcript` drops the whole event", () => {
    const out = scrubEvent({
      eventType: "stt_latency",
      provider: "elevenlabs",
      latencyMs: 250,
      meta: {
        // Runtime gate covers the type-bypass path (scrubEvent takes unknown).
        transcript: "private content",
      },
    });
    expect(out).toBeNull();
  });

  it("`meta.api_key` (snake_case variant) drops the event", () => {
    const out = scrubEvent({
      eventType: "test_connection",
      provider: "deepgram",
      result: "ok",
      meta: {
        api_key: "sk-leak",
      },
    });
    expect(out).toBeNull();
  });

  it("non-primitive value in meta drops the event", () => {
    const out = scrubEvent({
      eventType: "stt_latency",
      meta: {
        nested: { foo: "bar" },
      },
    });
    expect(out).toBeNull();
  });
});

describe("TM-S3: clean event round-trips on the safe fields", () => {
  it("provider_switch with from/to + ts is preserved verbatim", () => {
    const out = scrubEvent({
      ts: "2026-05-07T12:00:00.000Z",
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "deepgram",
      privacyMode: "cloud",
    });
    expect(out).toEqual({
      ts: "2026-05-07T12:00:00.000Z",
      eventType: "provider_switch",
      fromProvider: "mlx",
      toProvider: "deepgram",
      privacyMode: "cloud",
    });
  });

  it("stt_error with errorCode + latencyMs preserved", () => {
    const out = scrubEvent({
      eventType: "stt_error",
      provider: "deepgram",
      errorCode: "PROVIDER_UNAVAILABLE",
      latencyMs: 0,
      result: "fail",
    });
    expect(out).toEqual({
      eventType: "stt_error",
      provider: "deepgram",
      errorCode: "PROVIDER_UNAVAILABLE",
      latencyMs: 0,
      result: "fail",
    });
  });

  it("safe meta primitives (string/number/boolean/null) preserved", () => {
    const out = scrubEvent({
      eventType: "stt_latency",
      provider: "elevenlabs",
      latencyMs: 412,
      meta: {
        retries: 0,
        backoffMs: 200,
        gaveUp: false,
        peerName: null,
        modelId: "scribe-v1",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.meta).toEqual({
      retries: 0,
      backoffMs: 200,
      gaveUp: false,
      peerName: null,
      modelId: "scribe-v1",
    });
  });

  it("rejects unknown top-level keys (allow-list, not deny-list)", () => {
    const out = scrubEvent({
      eventType: "provider_switch",
      unknownField: "anything",
    });
    expect(out).toBeNull();
  });

  it("rejects unknown eventType values", () => {
    const out = scrubEvent({
      eventType: "totally_made_up",
    });
    expect(out).toBeNull();
  });

  it("rejects non-finite latencyMs", () => {
    expect(
      scrubEvent({ eventType: "stt_latency", latencyMs: NaN }),
    ).toBeNull();
    expect(
      scrubEvent({ eventType: "stt_latency", latencyMs: Infinity }),
    ).toBeNull();
  });

  it("rejects errorCode that is too long or contains a forbidden key", () => {
    const huge = "x".repeat(300);
    expect(
      scrubEvent({ eventType: "stt_error", errorCode: huge }),
    ).toBeNull();
    expect(
      scrubEvent({ eventType: "stt_error", errorCode: "transcript_leaked" }),
    ).toBeNull();
  });

  it("rejects bogus provider id (non-whitelisted)", () => {
    expect(
      scrubEvent({
        eventType: "provider_switch",
        provider: "openai",
      }),
    ).toBeNull();
  });
});

describe("TM-S4: containsForbiddenKey grep", () => {
  it("matches all forbidden keys, case-insensitive substring", () => {
    expect(containsForbiddenKey("...transcript...")).toBe(true);
    expect(containsForbiddenKey('"TEXT": "something"')).toBe(true);
    expect(containsForbiddenKey("PCM_FRAME=...")).toBe(true);
    expect(containsForbiddenKey("apikey=abc")).toBe(true);
    expect(containsForbiddenKey('"ApIkEy":"foo"')).toBe(true);
  });

  it("does not match non-forbidden tokens", () => {
    expect(containsForbiddenKey('"latencyMs":120')).toBe(false);
    expect(containsForbiddenKey('"errorCode":"X"')).toBe(false);
    expect(containsForbiddenKey('"provider":"deepgram"')).toBe(false);
  });

  it("safe on empty / non-string input", () => {
    expect(containsForbiddenKey("")).toBe(false);
    // Runtime guard covers null — cast to satisfy the typed signature.
    expect(containsForbiddenKey(null as unknown as string)).toBe(false);
  });
});

describe("TM-S5: FORBIDDEN_KEYS pinned list (regression gate)", () => {
  it("includes every documented privacy-sensitive key", () => {
    // If this assertion fails because someone shrunk the list, the privacy
    // gate has been weakened — stop the line and re-justify.
    for (const required of [
      "text",
      "transcript",
      "pcm",
      "audio",
      "apiKey",
      "secret",
      "key",
    ]) {
      expect(FORBIDDEN_KEYS).toContain(required);
    }
  });

  it("FORBIDDEN_KEYS is frozen", () => {
    expect(Object.isFrozen(FORBIDDEN_KEYS)).toBe(true);
  });
});
