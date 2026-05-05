// Phase 2 T-2.1 — Stage 1 heuristic detector tests.
//
// AC (per docs/IMPLEMENTATION-PLAN.md row T-2.1):
//   precision ≥ 0.70  AND  recall ≥ 0.80  on the 50-sample fixture.

import { describe, expect, it } from "vitest";

import fixtureJson from "../../shared/fixtures/question-detector-50.json";
import { detectCandidate } from "./heuristic";

interface Sample {
  id: string;
  text: string;
  expected: boolean;
  lang: string;
  tag: string;
}

const fixture = fixtureJson as { samples: Sample[] };

describe("T-2.1 heuristic detector — fixture shape", () => {
  it("contains exactly 50 samples (25 question, 25 non-question)", () => {
    expect(fixture.samples).toHaveLength(50);
    const positives = fixture.samples.filter((s) => s.expected).length;
    const negatives = fixture.samples.filter((s) => !s.expected).length;
    expect(positives).toBe(25);
    expect(negatives).toBe(25);
  });

  it("has unique sample IDs", () => {
    const ids = fixture.samples.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("T-2.1 heuristic detector — diagnostic per-sample sweep", () => {
  // Diagnostic only — failures here surface which sample misclassifies, but the
  // *gate* is the aggregate precision/recall test below. Some misclassifications
  // are expected (precision floor 0.70 → up to ~10 FPs allowed across the 25
  // non-question samples by design).
  it.each(fixture.samples)("$id ($tag)", (sample) => {
    const result = detectCandidate(sample.text);
    // Diagnostic shape — record the verdict so test output shows mismatches.
    expect(typeof result.isCandidate).toBe("boolean");
    expect(Array.isArray(result.signals)).toBe(true);
  });
});

describe("T-2.1 heuristic detector — AC gate (precision ≥ 0.70, recall ≥ 0.80)", () => {
  it("meets the precision and recall thresholds on the 50-sample fixture", () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const misses: string[] = [];

    for (const s of fixture.samples) {
      const predicted = detectCandidate(s.text).isCandidate;
      if (s.expected && predicted) tp++;
      else if (s.expected && !predicted) {
        fn++;
        misses.push(`MISS  ${s.id}: "${s.text}"`);
      } else if (!s.expected && predicted) {
        fp++;
        misses.push(`FP    ${s.id}: "${s.text}"`);
      } else tn++;
    }

    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);

    // Surface the metrics on failure for quick triage.
    const summary = `tp=${tp} fp=${fp} fn=${fn} tn=${tn}  precision=${precision.toFixed(3)}  recall=${recall.toFixed(3)}\n${misses.join("\n")}`;

    expect(precision, summary).toBeGreaterThanOrEqual(0.7);
    expect(recall, summary).toBeGreaterThanOrEqual(0.8);
  });
});

describe("T-2.1 heuristic detector — signal correctness", () => {
  it("English wh-aux question surfaces wh-en signal", () => {
    const r = detectCandidate("What is the deadline?");
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("wh-en");
    expect(r.signals).toContain("qmark");
  });

  it("English modal-fronted question surfaces modal-en signal", () => {
    const r = detectCandidate("Can you walk me through this?");
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("modal-en");
    expect(r.signals).toContain("qmark");
  });

  it("Vietnamese qmark + wh-vi", () => {
    const r = detectCandidate("Bạn nghĩ sao?");
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("qmark");
    expect(r.signals).toContain("wh-vi");
  });

  it("Diacritic-stripped Vietnamese still triggers wh-vi", () => {
    const r = detectCandidate("Tai sao build CI bi fail?");
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("wh-vi");
  });

  it("Long question (>50 chars with another signal) adds long-stmt", () => {
    const text = "What is the recommended approach for handling rate limits in production?";
    expect(text.length).toBeGreaterThan(50);
    const r = detectCandidate(text);
    expect(r.signals).toContain("long-stmt");
  });

  it("Declarative-leader suppresses bare wh-en (no aux follows wh-word)", () => {
    const r = detectCandidate("I know what the deadline is.");
    expect(r.isCandidate).toBe(false);
  });
});

describe("T-2.1 heuristic detector — purity + edges", () => {
  it("is deterministic for the same input", () => {
    const a = detectCandidate("What is the deadline?");
    const b = detectCandidate("What is the deadline?");
    expect(a).toEqual(b);
  });

  it("returns no candidate for empty / whitespace input", () => {
    for (const t of ["", "   ", "\n\t"]) {
      const r = detectCandidate(t);
      expect(r.isCandidate).toBe(false);
      expect(r.signals).toEqual([]);
    }
  });

  it("ignores trailing whitespace before qmark detection", () => {
    const r = detectCandidate("Did you review the PR?   ");
    expect(r.signals).toContain("qmark");
  });
});
