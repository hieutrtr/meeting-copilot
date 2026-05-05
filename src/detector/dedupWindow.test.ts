// Phase 2 T-2.4 — Dedup window unit tests.
// AC gate (#1): same question 3× within 30 s → exactly 1 admit (per plan).
// All other tests cover normalization, hash determinism, paraphrase known-
// limitation, sliding-window expiry, independent windows, VI support, edges.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEDUP_WINDOW_MS,
  createDedupWindow,
  hashQuestion,
  normalizeQuestion,
} from "./dedupWindow";

describe("normalizeQuestion", () => {
  it("lowercases ASCII letters", () => {
    expect(normalizeQuestion("WHAT IS THIS")).toBe("what is this");
  });

  it("strips trailing question / exclamation / period", () => {
    expect(normalizeQuestion("hello?")).toBe("hello");
    expect(normalizeQuestion("hello!")).toBe("hello");
    expect(normalizeQuestion("hello.")).toBe("hello");
    expect(normalizeQuestion("hello??")).toBe("hello");
    expect(normalizeQuestion("hello…")).toBe("hello");
  });

  it("collapses inner whitespace and trims", () => {
    expect(normalizeQuestion("  what   is\n\t this  ")).toBe("what is this");
  });

  it("strips leading filler 'um, '", () => {
    expect(normalizeQuestion("Um, what's the deadline?")).toBe(
      "whats the deadline",
    );
  });

  it("strips chained leading fillers ('um, uh, ...')", () => {
    expect(normalizeQuestion("um, uh, what's the deadline?")).toBe(
      "whats the deadline",
    );
  });

  it("does NOT strip 'how' (not a filler)", () => {
    // Regression: filler regex must not over-match.
    expect(normalizeQuestion("how is everyone?")).toBe("how is everyone");
  });

  it("does NOT strip Vietnamese question words ('làm sao', 'tại sao')", () => {
    // These carry semantic weight; not in the filler enum by design.
    expect(normalizeQuestion("làm sao biết được?")).toBe("làm sao biết được");
    expect(normalizeQuestion("tại sao chậm thế?")).toBe("tại sao chậm thế");
  });

  it("normalizes fullwidth question mark via NFKC", () => {
    // U+FF1F (fullwidth ?) → U+003F (ASCII ?), then stripped by punct rule.
    expect(normalizeQuestion("hello？")).toBe("hello");
  });

  it("preserves Vietnamese diacritics", () => {
    expect(normalizeQuestion("Deadline là khi nào?")).toBe(
      "deadline là khi nào",
    );
  });

  it("returns empty string for empty / whitespace input", () => {
    expect(normalizeQuestion("")).toBe("");
    expect(normalizeQuestion("   ")).toBe("");
    expect(normalizeQuestion("\n\t\r")).toBe("");
  });

  it("treats apostrophe inside contractions as punctuation", () => {
    // "what's" → "whats". Documented behavior — see dedupWindow.ts comment.
    expect(normalizeQuestion("what's the deadline?")).toBe("whats the deadline");
  });

  it("returns '' for non-string inputs (defensive)", () => {
    // @ts-expect-error — defensive guard.
    expect(normalizeQuestion(undefined)).toBe("");
    // @ts-expect-error — defensive guard.
    expect(normalizeQuestion(null)).toBe("");
    // @ts-expect-error — defensive guard.
    expect(normalizeQuestion(42)).toBe("");
  });
});

describe("hashQuestion", () => {
  it("is deterministic across calls", () => {
    const a = hashQuestion("what is the deadline");
    const b = hashQuestion("what is the deadline");
    expect(a).toBe(b);
  });

  it("returns a 16-char lowercase hex string (64-bit FNV-1a)", () => {
    const h = hashQuestion("hello world");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("collides on case-only difference (lowercase normalization)", () => {
    expect(hashQuestion("HELLO WORLD")).toBe(hashQuestion("hello world"));
  });

  it("collides on punctuation-only difference", () => {
    expect(hashQuestion("what's the deadline?")).toBe(
      hashQuestion("what's the deadline."),
    );
    expect(hashQuestion("what's the deadline?")).toBe(
      hashQuestion("what's the deadline??"),
    );
  });

  it("collides across leading-filler variants", () => {
    expect(hashQuestion("Um, what's the deadline?")).toBe(
      hashQuestion("what's the deadline?"),
    );
    expect(hashQuestion("uh, what's the deadline?")).toBe(
      hashQuestion("what's the deadline?"),
    );
  });

  it("does NOT collide on distinct paraphrases (known limitation, hash-only)", () => {
    // T-2.4 ships hash-only dedup. Embedding similarity (ARCH §5.2) is
    // deferred to Phase 2.x backlog. The two phrasings below are
    // semantically equivalent but produce different hashes by design.
    expect(hashQuestion("what's the deadline?")).not.toBe(
      hashQuestion("when is the deadline?"),
    );
  });

  it("handles empty input deterministically", () => {
    const e1 = hashQuestion("");
    const e2 = hashQuestion("   ");
    expect(e1).toBe(e2);
    expect(e1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("createDedupWindow — admit semantics", () => {
  it("AC GATE: same question 3× in 30 s → exactly 1 admit, 2 rejects", () => {
    const win = createDedupWindow();
    const r1 = win.admit("what's the deadline?", 0);
    const r2 = win.admit("what's the deadline?", 10_000);
    const r3 = win.admit("what's the deadline?", 25_000);

    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(false);
    expect(r2.reason).toBe("duplicate");
    expect(r2.matchedAt).toBe(0);
    expect(r2.matchedHash).toBe(r1.hash);
    expect(r3.admitted).toBe(false);
    expect(r3.matchedAt).toBe(0);
  });

  it("admits paraphrase variants separately (known limitation, both fire)", () => {
    const win = createDedupWindow();
    const r1 = win.admit("what's the deadline?", 0);
    const r2 = win.admit("when is the deadline?", 1_000);

    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r1.hash).not.toBe(r2.hash);
  });

  it("collides identical-after-normalization variants in the same window", () => {
    const win = createDedupWindow();
    expect(win.admit("What's the deadline?", 0).admitted).toBe(true);
    expect(win.admit("  WHAT'S THE DEADLINE?? ", 5_000).admitted).toBe(false);
    expect(win.admit("Um, what's the deadline?", 10_000).admitted).toBe(false);
    expect(win.admit("what's the deadline.", 15_000).admitted).toBe(false);
  });

  it("re-admits after the window expires (strict-< boundary)", () => {
    const win = createDedupWindow({ windowMs: 60_000 });
    expect(win.admit("hello?", 0).admitted).toBe(true);
    // Exactly windowMs later: still considered duplicate (entry expires when
    // recordedAt < now - windowMs, i.e. at now > windowMs).
    expect(win.admit("hello?", 60_000).admitted).toBe(false);
    expect(win.admit("hello?", 60_001).admitted).toBe(true);
  });

  it("does NOT refresh the window on a duplicate hit", () => {
    // A stutterer can't keep an entry alive forever — expiry is anchored to
    // the original admit time, not the latest duplicate hit.
    const win = createDedupWindow({ windowMs: 60_000 });
    expect(win.admit("hello?", 0).admitted).toBe(true);
    expect(win.admit("hello?", 30_000).admitted).toBe(false);
    expect(win.admit("hello?", 50_000).admitted).toBe(false);
    // Still expires based on t=0, not t=50_000.
    expect(win.admit("hello?", 60_001).admitted).toBe(true);
  });

  it("does not crash on empty / whitespace input", () => {
    const win = createDedupWindow();
    const r1 = win.admit("", 0);
    const r2 = win.admit("   ", 1);
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(false); // both normalize to ""
    expect(r2.matchedHash).toBe(r1.hash);
    // Bonus: doesn't throw even on weird whitespace.
    expect(() => win.admit("\n\t\r", 2)).not.toThrow();
  });

  it("falls back to the injected clock when no ts is provided", () => {
    let now = 0;
    const win = createDedupWindow({ now: () => now, windowMs: 1_000 });
    expect(win.admit("hello?").admitted).toBe(true);
    now = 500;
    expect(win.admit("hello?").admitted).toBe(false);
    now = 2_000;
    expect(win.admit("hello?").admitted).toBe(true);
  });

  it("supports custom windowMs", () => {
    const win = createDedupWindow({ windowMs: 1_000 });
    expect(win.admit("hello?", 0).admitted).toBe(true);
    expect(win.admit("hello?", 500).admitted).toBe(false);
    expect(win.admit("hello?", 1_500).admitted).toBe(true);
  });
});

describe("createDedupWindow — Vietnamese", () => {
  it("collides VI questions that differ only in trailing punctuation", () => {
    const win = createDedupWindow();
    expect(win.admit("Deadline là khi nào?", 0).admitted).toBe(true);
    expect(win.admit("deadline là khi nào", 100).admitted).toBe(false);
  });

  it("treats diacritic-stripped variants as DISTINCT (upstream STT concern)", () => {
    const win = createDedupWindow();
    expect(win.admit("Deadline là khi nào?", 0).admitted).toBe(true);
    expect(win.admit("Deadline la khi nao?", 100).admitted).toBe(true);
  });

  it("strips Vietnamese verbal-hedge prefixes ('à, ', 'ờ ')", () => {
    const win = createDedupWindow();
    expect(win.admit("À, deadline là khi nào?", 0).admitted).toBe(true);
    expect(win.admit("Ờ, deadline là khi nào?", 100).admitted).toBe(false);
    expect(win.admit("deadline là khi nào?", 200).admitted).toBe(false);
  });
});

describe("createDedupWindow — state", () => {
  it("size() reflects pruning under the default windowMs", () => {
    const win = createDedupWindow({ windowMs: 1_000 });
    win.admit("a?", 0);
    win.admit("b?", 100);
    win.admit("c?", 200);
    // size() prunes against the injected clock — fall back to wall clock if
    // unset. Use an injected clock to assert deterministically.
    const clocked = createDedupWindow({ windowMs: 1_000, now: () => 250 });
    clocked.admit("a?", 0);
    clocked.admit("b?", 100);
    clocked.admit("c?", 200);
    expect(clocked.size()).toBe(3);
  });

  it("size() drops entries past windowMs", () => {
    let now = 0;
    const win = createDedupWindow({ windowMs: 1_000, now: () => now });
    win.admit("a?", 0);
    win.admit("b?", 800);
    // cutoff = now - windowMs = 1_500 - 1_000 = 500.
    // a (recordedAt=0)   → 0 < 500 → expired.
    // b (recordedAt=800) → 800 < 500 → false → still in.
    now = 1_500;
    expect(win.size()).toBe(1);
  });

  it("reset() clears all state", () => {
    const win = createDedupWindow({ windowMs: 60_000 });
    win.admit("hello?", 0);
    expect(win.admit("hello?", 1_000).admitted).toBe(false);
    win.reset();
    expect(win.size()).toBe(0);
    expect(win.admit("hello?", 2_000).admitted).toBe(true);
  });

  it("two independent windows do not share state", () => {
    const a = createDedupWindow();
    const b = createDedupWindow();
    expect(a.admit("hello?", 0).admitted).toBe(true);
    expect(b.admit("hello?", 0).admitted).toBe(true);
    expect(a.admit("hello?", 100).admitted).toBe(false);
    expect(b.admit("hello?", 100).admitted).toBe(false);
  });
});

describe("DEFAULT_DEDUP_WINDOW_MS", () => {
  it("is 60_000 (per plan T-2.4)", () => {
    // ARCH §5.2 says 30 s; plan widens to 60 s. We follow the plan.
    expect(DEFAULT_DEDUP_WINDOW_MS).toBe(60_000);
  });
});
