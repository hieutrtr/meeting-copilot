// Phase 3 T-3.9 — Telemetry sink unit tests.
//
// AC traceability (see docs/tasks/phase-3/T-3.9-telemetry.md §"TDD plan"):
//   TM-S6 → memory sink reports size 0 initially
//   TM-S7 → after append, size matches UTF-8 bytes + newline
//   TM-S8 → next append crossing maxBytes triggers rotate
//   TM-S9 → archive ring respects maxFiles (oldest dropped)
//   TM-S10 → noop sink is a no-op

import { describe, expect, it } from "vitest";

import {
  createMemorySink,
  createNoopSink,
  DEFAULT_TELEMETRY_MAX_BYTES,
  DEFAULT_TELEMETRY_MAX_FILES,
} from "./sinks";

describe("TM-S6: createMemorySink() initial state", () => {
  it("size starts at 0; archives empty; rotations 0", () => {
    const sink = createMemorySink();
    expect(sink.size()).toBe(0);
    const i = sink.inspect!();
    expect(i.current).toBe("");
    expect(i.archives).toEqual([]);
    expect(i.rotations).toBe(0);
  });
});

describe("TM-S7: append updates size = utf8 bytes + 1 newline", () => {
  it("ascii line — 5 bytes + newline", () => {
    const sink = createMemorySink();
    sink.append("hello");
    expect(sink.size()).toBe(6); // 5 + "\n"
    expect(sink.inspect!().current).toBe("hello\n");
  });

  it("non-ascii line — UTF-8 byte count, not JS code-unit count", () => {
    const sink = createMemorySink();
    // "日本語" is 9 UTF-8 bytes. JS .length would say 3.
    sink.append("日本語");
    expect(sink.size()).toBe(10); // 9 + "\n"
  });

  it("multiple appends accumulate", () => {
    const sink = createMemorySink();
    sink.append("a");
    sink.append("bb");
    sink.append("ccc");
    expect(sink.size()).toBe(2 + 3 + 4); // each + newline
  });
});

describe("TM-S8: rotate when next append crosses maxBytes", () => {
  it("synthetic: maxBytes=20, three 8-byte lines → rotates after the second append", () => {
    const sink = createMemorySink({ maxBytes: 20 });
    // each "ABCDEFG" = 7 chars + "\n" = 8 bytes.
    sink.append("ABCDEFG");
    expect(sink.size()).toBe(8);
    sink.append("HIJKLMN");
    expect(sink.size()).toBe(16);
    // Next append would cross 20 → pre-rotate: archive head holds first two lines.
    sink.append("OPQRSTU");
    expect(sink.size()).toBe(8); // post-rotate, only the last line in current
    const i = sink.inspect!();
    expect(i.rotations).toBe(1);
    expect(i.archives.length).toBe(1);
    expect(i.archives[0]).toBe("ABCDEFG\nHIJKLMN\n");
    expect(i.current).toBe("OPQRSTU\n");
  });

  it("the pre-rotate happens BEFORE the new line is written (atomic)", () => {
    const sink = createMemorySink({ maxBytes: 10 });
    sink.append("12345");
    sink.append("67890"); // would push to 12 bytes — triggers rotate
    const i = sink.inspect!();
    expect(i.rotations).toBe(1);
    expect(i.archives[0]).toBe("12345\n");
    expect(i.current).toBe("67890\n");
  });
});

describe("TM-S9: archive ring respects maxFiles (oldest dropped)", () => {
  it("maxFiles=2: after 4 forced rotations, only the latest 2 archives kept", () => {
    const sink = createMemorySink({ maxBytes: 10, maxFiles: 2 });
    sink.append("seg-1"); // 6 bytes
    sink.append("seg-2"); // → 12 bytes, rotates first
    sink.append("seg-3"); // → 12 bytes, rotates again
    sink.append("seg-4"); // → 12 bytes, rotates again
    sink.append("seg-5"); // last, in current
    const i = sink.inspect!();
    // After 4 rotations + 5 appends, the archive ring of size 2 holds the
    // two most recent rotated segments.
    expect(i.archives.length).toBeLessThanOrEqual(2);
    expect(i.rotations).toBeGreaterThanOrEqual(4);
    // Oldest segments (seg-1, seg-2) MUST have aged out.
    for (const archive of i.archives) {
      expect(archive).not.toContain("seg-1");
      expect(archive).not.toContain("seg-2");
    }
  });

  it("forced rotate() empties current and grows archive head", () => {
    const sink = createMemorySink({ maxBytes: 1_000_000 });
    sink.append("abc");
    sink.rotate();
    const i = sink.inspect!();
    expect(i.current).toBe("");
    expect(i.archives[0]).toBe("abc\n");
    expect(i.rotations).toBe(1);
    expect(sink.size()).toBe(0);
  });
});

describe("TM-S10: createNoopSink() is a documented no-op", () => {
  it("append + rotate + size stay at zero", () => {
    const sink = createNoopSink();
    sink.append("anything");
    sink.append("more");
    sink.rotate();
    expect(sink.size()).toBe(0);
    const i = sink.inspect!();
    expect(i.current).toBe("");
    expect(i.archives).toEqual([]);
    expect(i.rotations).toBe(0);
  });
});

describe("Defaults match T-3.9 documented constants", () => {
  it("DEFAULT_TELEMETRY_MAX_BYTES is 10 MB (per AC: rotates at 10 MB)", () => {
    expect(DEFAULT_TELEMETRY_MAX_BYTES).toBe(10_000_000);
  });
  it("DEFAULT_TELEMETRY_MAX_FILES is 3 → ~30 MB ceiling", () => {
    expect(DEFAULT_TELEMETRY_MAX_FILES).toBe(3);
  });
});
