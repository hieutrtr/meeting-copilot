// Phase 1 T-1.6 — vitest harness for the `transcript:chunk` event subscription.
// We don't render React here (no DOM env in vitest config); instead we test the
// `subscribeTranscriptStream` plain function — the seam every UI consumer goes through.
// Schema parity test reads `shared/fixtures/transcript_chunk.sample.json`, which is the
// same literal asserted in `crates/helper-daemon/src/bridge.rs::event_bridge_serialises_to_canonical_json`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptChunk } from "../../shared/types";

type Listener<T> = (event: { payload: T; event: string; id: number }) => void;

const listeners: Array<Listener<TranscriptChunk>> = [];
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: Listener<TranscriptChunk>) => {
    if (eventName !== "transcript:chunk") {
      throw new Error(`unexpected event name: ${eventName}`);
    }
    listeners.push(handler);
    return unlisten;
  }),
}));

const { subscribeTranscriptStream, TRANSCRIPT_CHUNK_EVENT } = await import(
  "./useTranscriptStream"
);

function fireEvent(payload: TranscriptChunk) {
  for (const handler of listeners) {
    handler({ payload, event: TRANSCRIPT_CHUNK_EVENT, id: 0 });
  }
}

beforeEach(() => {
  listeners.length = 0;
  unlisten.mockClear();
});

afterEach(() => {
  listeners.length = 0;
});

describe("subscribeTranscriptStream", () => {
  it("invokes the handler with the event payload (TS-T1)", async () => {
    const received: TranscriptChunk[] = [];
    const stop = await subscribeTranscriptStream((chunk) => received.push(chunk));

    const sample: TranscriptChunk = {
      id: "m1-0",
      meetingId: "m1",
      text: "Hello world.",
      startTs: 0,
      endTs: 2000,
      isFinal: true,
      confidence: 1.0,
    };
    fireEvent(sample);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(sample);
    expect(typeof stop).toBe("function");
  });

  it("delivers a sequence of payloads in order; unlisten is callable (TS-T2)", async () => {
    const received: TranscriptChunk[] = [];
    const stop = await subscribeTranscriptStream((chunk) => received.push(chunk));

    const payloads: TranscriptChunk[] = [
      { id: "m1-0", meetingId: "m1", text: "alpha", startTs: 0, endTs: 2000, isFinal: true },
      { id: "m1-1", meetingId: "m1", text: "beta", startTs: 2000, endTs: 4000, isFinal: true },
      { id: "m1-2", meetingId: "m1", text: "gamma", startTs: 4000, endTs: 6000, isFinal: true },
    ];
    for (const p of payloads) fireEvent(p);

    expect(received.map((c) => c.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(received.map((c) => c.id)).toEqual(["m1-0", "m1-1", "m1-2"]);

    expect(() => stop()).not.toThrow();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("transcript_chunk fixture schema parity (TS-T3)", () => {
  it("the shared fixture conforms to TranscriptChunk", () => {
    const raw = readFileSync(
      resolve(__dirname, "../../shared/fixtures/transcript_chunk.sample.json"),
      "utf-8",
    );
    const parsed: TranscriptChunk = JSON.parse(raw);

    // Required keys (per shared/types.ts:TranscriptChunk).
    expect(typeof parsed.id).toBe("string");
    expect(typeof parsed.meetingId).toBe("string");
    expect(typeof parsed.text).toBe("string");
    expect(typeof parsed.startTs).toBe("number");
    expect(typeof parsed.endTs).toBe("number");
    expect(typeof parsed.isFinal).toBe("boolean");

    // Optional keys present in the canonical fixture.
    expect(typeof parsed.confidence).toBe("number");

    // Match the Rust-side serialisation literal byte-for-byte.
    expect(parsed).toEqual({
      id: "m1-0",
      meetingId: "m1",
      text: "Hello world.",
      startTs: 0,
      endTs: 2000,
      isFinal: true,
      confidence: 1.0,
    });
  });
});
