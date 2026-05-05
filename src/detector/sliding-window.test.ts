// Phase 2 T-2.2 — Sliding-window utterance assembler tests.
//
// AC (per docs/IMPLEMENTATION-PLAN.md row T-2.2 + INDEX.md):
//   ≥ 80 % boundary correctness on the 10-utterance, 1-minute synthetic fixture.
// Boundary match definition (see T-2.2 spec):
//   |startTs Δ| ≤ 100 ms, |endTs Δ| ≤ 100 ms, chunkIds equal in arrival order.

import { describe, expect, it } from "vitest";

import fixtureJson from "../../shared/fixtures/sliding-window-1min.json";
import type { TranscriptChunk, Utterance } from "../../shared/types";
import { createSlidingWindow } from "./sliding-window";

interface GroundTruthEntry {
  _id: string;
  text: string;
  startTs: number;
  endTs: number;
  chunkIds: string[];
  trigger: string;
}

const fixture = fixtureJson as {
  chunks: TranscriptChunk[];
  groundTruth: GroundTruthEntry[];
};

const TS_TOLERANCE_MS = 100;

function utteranceMatches(emitted: Utterance, gt: GroundTruthEntry): boolean {
  if (Math.abs(emitted.startTs - gt.startTs) > TS_TOLERANCE_MS) return false;
  if (Math.abs(emitted.endTs - gt.endTs) > TS_TOLERANCE_MS) return false;
  if (emitted.chunkIds.length !== gt.chunkIds.length) return false;
  for (let i = 0; i < gt.chunkIds.length; i += 1) {
    if (emitted.chunkIds[i] !== gt.chunkIds[i]) return false;
  }
  return true;
}

function chunk(
  id: string,
  text: string,
  startTs: number,
  endTs: number,
  isFinal = true,
): TranscriptChunk {
  return { id, meetingId: "m-test", text, startTs, endTs, isFinal };
}

describe("T-2.2 sliding-window — fixture shape gate", () => {
  it("has exactly 10 ground-truth utterances", () => {
    expect(fixture.groundTruth).toHaveLength(10);
  });

  it("ground-truth chunkIds partition the chunk stream (no duplicates, no orphans)", () => {
    const used: string[] = fixture.groundTruth.flatMap((u) => u.chunkIds);
    const usedSet = new Set(used);
    expect(used.length).toBe(usedSet.size); // no chunk used twice
    const allChunkIds = new Set(fixture.chunks.map((c) => c.id));
    expect(usedSet).toEqual(allChunkIds); // every chunk accounted for
  });

  it("ground-truth utterances are in monotonic time order", () => {
    for (let i = 1; i < fixture.groundTruth.length; i += 1) {
      expect(fixture.groundTruth[i].startTs).toBeGreaterThanOrEqual(
        fixture.groundTruth[i - 1].endTs,
      );
    }
  });
});

describe("T-2.2 sliding-window — unit boundary rules", () => {
  it("emits on a final chunk that ends with sentence-terminating punctuation", () => {
    const win = createSlidingWindow();
    const out = win.push(chunk("a1", "Hello world.", 0, 1000));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Hello world.");
    expect(out[0].chunkIds).toEqual(["a1"]);
    expect(win.pending()).toBeNull();
  });

  it("does NOT emit on a final chunk without sentence-terminating punctuation", () => {
    const win = createSlidingWindow();
    const out = win.push(chunk("a1", "still going", 0, 1000));
    expect(out).toHaveLength(0);
    expect(win.pending()?.text).toBe("still going");
  });

  it("does NOT emit on isFinal:false interim chunks (they accumulate)", () => {
    const win = createSlidingWindow();
    expect(win.push(chunk("a1", "Hello", 0, 500, false))).toHaveLength(0);
    expect(win.push(chunk("a2", "world", 500, 1000, false))).toHaveLength(0);
    expect(win.push(chunk("a3", "today", 1000, 1500, false))).toHaveLength(0);
    expect(win.pending()?.text).toBe("Hello world today");
    expect(win.pending()?.chunkIds).toEqual(["a1", "a2", "a3"]);
  });

  it("silence gap ≥ 800 ms triggers an emit, the new chunk seeds a fresh buffer", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "first part", 0, 1000, false));
    // gap = 1500 - 1000 = 500 ms — sub-threshold, no split
    expect(
      win.push(chunk("a2", "still first", 1500, 2000, false)),
    ).toHaveLength(0);
    // gap = 2900 - 2000 = 900 ms — over threshold, flush previous buffer
    const out = win.push(chunk("a3", "second utterance", 2900, 3500, false));
    expect(out).toHaveLength(1);
    expect(out[0].chunkIds).toEqual(["a1", "a2"]);
    expect(out[0].endTs).toBe(2000);
    expect(win.pending()?.chunkIds).toEqual(["a3"]);
  });

  it("sub-threshold gap (700 ms) does NOT split", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "first", 0, 1000, false));
    expect(
      win.push(chunk("a2", "second", 1700, 2000, false)),
    ).toHaveLength(0);
    expect(win.pending()?.chunkIds).toEqual(["a1", "a2"]);
  });

  it("threshold is configurable", () => {
    const win = createSlidingWindow({ silenceThresholdMs: 300 });
    win.push(chunk("a1", "first", 0, 1000, false));
    // gap = 400 ms ≥ 300 ms threshold → flush
    const out = win.push(chunk("a2", "second", 1400, 1600, false));
    expect(out).toHaveLength(1);
    expect(out[0].chunkIds).toEqual(["a1"]);
  });

  it("flush() drains pending into a single utterance and clears state", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "incomplete", 0, 1000, true));
    expect(win.pending()).not.toBeNull();
    const out = win.flush();
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("incomplete");
    expect(win.pending()).toBeNull();
    expect(win.flush()).toEqual([]);
  });

  it("reset() clears pending state", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "Some words", 0, 1000, false));
    expect(win.pending()).not.toBeNull();
    win.reset();
    expect(win.pending()).toBeNull();
  });

  it("CJK / Vietnamese terminators close the utterance", () => {
    const win = createSlidingWindow();
    expect(win.push(chunk("a1", "Bạn khoẻ không?", 0, 1500))).toHaveLength(1);
    expect(win.push(chunk("a2", "你好世界。", 5000, 6000))).toHaveLength(1);
    expect(win.push(chunk("a3", "好像也行！", 10_000, 11_000))).toHaveLength(1);
    expect(win.push(chunk("a4", "tail off…", 15_000, 16_000))).toHaveLength(1);
  });

  it("composes text by joining chunks and collapsing whitespace", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "  Hello   world  ", 0, 500, false));
    win.push(chunk("a2", "today is", 500, 1000, false));
    const out = win.push(chunk("a3", "fine.", 1000, 1500, true));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Hello world today is fine.");
  });

  it("can emit two utterances on a single push (silence flush + final-with-punct combine)", () => {
    const win = createSlidingWindow();
    win.push(chunk("a1", "first part", 0, 1000, false));
    // 1000 ms gap closes a1, AND a2 itself is final-with-period → emit twice.
    const out = win.push(chunk("a2", "second!", 2000, 2500, true));
    expect(out).toHaveLength(2);
    expect(out[0].chunkIds).toEqual(["a1"]);
    expect(out[1].chunkIds).toEqual(["a2"]);
    expect(win.pending()).toBeNull();
  });

  it("is deterministic — replay yields identical emits", () => {
    const win1 = createSlidingWindow();
    const win2 = createSlidingWindow();
    const inputs: TranscriptChunk[] = [
      chunk("a1", "first", 0, 500, false),
      chunk("a2", "second.", 500, 1000, true),
      chunk("a3", "third?", 2000, 2500, true),
    ];
    const out1 = inputs.flatMap((c) => win1.push(c)).concat(win1.flush());
    const out2 = inputs.flatMap((c) => win2.push(c)).concat(win2.flush());
    expect(out1).toEqual(out2);
  });

  it("empty stream → no emits, pending null", () => {
    const win = createSlidingWindow();
    expect(win.flush()).toEqual([]);
    expect(win.pending()).toBeNull();
  });
});

describe("T-2.2 sliding-window — fixture aggregate boundary correctness gate (AC)", () => {
  it("emits ≥ 80 % matching boundaries on the 10-utterance fixture", () => {
    const win = createSlidingWindow();
    const emitted: Utterance[] = [];
    for (const c of fixture.chunks) {
      emitted.push(...win.push(c));
    }
    emitted.push(...win.flush());

    // Greedy 1-to-1 pairing in order. Both lists are time-sorted by
    // construction; an off-by-one mis-segmentation is a non-match.
    const n = Math.min(emitted.length, fixture.groundTruth.length);
    let matches = 0;
    for (let i = 0; i < n; i += 1) {
      if (utteranceMatches(emitted[i], fixture.groundTruth[i])) matches += 1;
    }

    const correctness = matches / fixture.groundTruth.length;

    // Surface the metric in test output for easy review-doc capture.
    // eslint-disable-next-line no-console
    console.log(
      `[T-2.2] boundary correctness: ${matches}/${fixture.groundTruth.length} (${(correctness * 100).toFixed(1)} %)`,
    );

    expect(emitted.length).toBe(fixture.groundTruth.length);
    expect(correctness).toBeGreaterThanOrEqual(0.8);
  });

  it("text composition matches ground-truth text on every emitted utterance", () => {
    const win = createSlidingWindow();
    const emitted: Utterance[] = [];
    for (const c of fixture.chunks) emitted.push(...win.push(c));
    emitted.push(...win.flush());
    expect(emitted.map((u) => u.text)).toEqual(
      fixture.groundTruth.map((u) => u.text),
    );
  });
});
