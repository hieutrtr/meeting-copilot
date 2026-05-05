// Phase 2 T-2.4 — Dedup window (hash-based, sliding 60 s by default).
//
// Pipeline position (per ARCH §5.1 + INDEX dep graph):
//   Stage 2 Haiku verdict (T-2.3) → THIS module → bounded queue (T-2.5).
//
// v0.2 ships hash-only dedup. ARCH §5.2 mentions embedding cosine > 0.85 as
// the v1 ideal; that requires `nomic-embed-text` and is deferred to Phase
// 2.x backlog. Hash-only catches identical and near-identical (case /
// punctuation / leading-filler-variant) repetitions; true paraphrases like
// "what's the deadline" vs "when is the deadline" both admit — documented
// limitation. T-2.5's single-flight + 1-concurrent-answer cap means
// double-fires queue serially, not in parallel — UX degradation, not
// correctness.
//
// Pure (no module-level mutable state): each `createDedupWindow()` returns
// an independent closure so two meetings can run side-by-side without
// cross-pollution.

export interface DedupAdmitResult {
  admitted: boolean;
  hash: string;
  reason?: "duplicate";
  matchedAt?: number;
  matchedHash?: string;
}

export interface DedupWindowOptions {
  // Sliding-window duration. Plan T-2.4 says 60s; ARCH §5.2 says 30s.
  // We follow the plan and document the discrepancy in the task spec.
  windowMs?: number;
  // Injected clock — defaults to Date.now. Used only when callers omit `ts`
  // on `admit()`; tests pass an explicit `ts` so the clock is not consulted.
  now?: () => number;
}

export interface DedupWindow {
  admit(text: string, ts?: number): DedupAdmitResult;
  size(): number;
  reset(): void;
}

export const DEFAULT_DEDUP_WINDOW_MS = 60_000 as const;

// Closed enum of common spoken hedges. Stripped only at the leading edge so
// we don't accidentally remove meaningful occurrences mid-sentence.
// Multi-word hedges go first so the regex prefers the longest match.
//
// Conservative bias: only entries with no real semantic content at sentence
// start. Vietnamese question words like `làm sao` ("how"), `thế nào` ("how"),
// `tại sao` ("why") are NOT fillers; same for English `so` (often a discourse
// marker but also "so much for X" / "so big" — risk of over-merging).
const FILLER_PREFIXES = [
  "you know",
  "i mean",
  "actually",
  "basically",
  "well",
  "like",
  "um",
  "uhm",
  "uh",
  "er",
  "ah",
  "hmm",
  "hm",
  "à",
  "ờ",
  "ừ",
];

const FILLER_RE = new RegExp(
  `^(?:${FILLER_PREFIXES.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[,\\s]+`,
  "i",
);

// Strip punctuation but keep letters (incl. VI diacritics + CJK), digits, and
// inter-word whitespace. We use a character-class blacklist so we don't have
// to enumerate every Unicode letter range.
const PUNCT_RE = /[?!.,;:…—–\-"'“”‘’«»()\[\]{}<>「」『』《》、。！？]/g;

const WHITESPACE_RE = /\s+/g;

export function normalizeQuestion(text: string): string {
  if (typeof text !== "string") return "";
  // 1. NFKC: fullwidth → ASCII (？ → ?), precomposed VI glyphs canonical.
  let out = text.normalize("NFKC");
  // 2. Lowercase (locale-aware for VI / TR).
  out = out.toLocaleLowerCase();
  // 3. Trim outer whitespace before filler check (regex anchors on string start).
  out = out.trim();
  // 4. Strip leading filler words. Loop so "um, uh, what..." → "what".
  let prev: string;
  do {
    prev = out;
    out = out.replace(FILLER_RE, "");
  } while (out !== prev);
  // 5. Strip punctuation (apostrophe inside contractions removed too —
  //    "what's" → "whats", which is intentional: it lets "What's the
  //    deadline?" and "what is the deadline" *not* collide, but it does
  //    let "What's the deadline." and "What's the deadline?" collide).
  out = out.replace(PUNCT_RE, "");
  // 6. Collapse whitespace.
  out = out.replace(WHITESPACE_RE, " ").trim();
  return out;
}

// 64-bit FNV-1a over the canonical UTF-16 code units. Deterministic, no
// `crypto` dependency (keeps the module Tauri / Rust-port-friendly and avoids
// the async `crypto.subtle` surface). Returned as 16 lowercase hex chars.
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET_64;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME_64) & MASK_64;
  }
  return h;
}

export function hashQuestion(text: string): string {
  const canonical = normalizeQuestion(text);
  const h = fnv1a64(canonical);
  return h.toString(16).padStart(16, "0");
}

export function createDedupWindow(opts?: DedupWindowOptions): DedupWindow {
  const windowMs = opts?.windowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const clock = opts?.now ?? Date.now;
  // Map insertion order is irrelevant; we walk the entire map on every
  // admit to prune. For realistic meeting cadence (≤ 10 candidates / min)
  // this is O(< 60) per call — well under any latency budget.
  const entries = new Map<string, { recordedAt: number }>();

  function prune(now: number): void {
    const cutoff = now - windowMs;
    for (const [hash, entry] of entries) {
      // Strict `<`: an entry recorded exactly `windowMs` ago is still in-window.
      // First admit at t=0 with windowMs=60_000 → entry expires at t=60_001.
      if (entry.recordedAt < cutoff) {
        entries.delete(hash);
      }
    }
  }

  function admit(text: string, ts?: number): DedupAdmitResult {
    const now = ts ?? clock();
    const hash = hashQuestion(text);
    prune(now);
    const existing = entries.get(hash);
    if (existing) {
      // Sliding window does NOT refresh on duplicate hits. The entry expires
      // based on the original admit time so a stutterer can't keep the entry
      // alive forever. Once expired, a fresh admit goes through.
      return {
        admitted: false,
        hash,
        reason: "duplicate",
        matchedAt: existing.recordedAt,
        matchedHash: hash,
      };
    }
    entries.set(hash, { recordedAt: now });
    return { admitted: true, hash };
  }

  function size(): number {
    // Prune against the latest known timestamp before reporting size so callers
    // get a consistent view. We use the clock here since we have no `ts`.
    prune(clock());
    return entries.size;
  }

  function reset(): void {
    entries.clear();
  }

  return { admit, size, reset };
}
