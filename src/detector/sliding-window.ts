// Phase 2 T-2.2 — Sliding-window utterance assembler.
//
// Consumes `TranscriptChunk` events (the same stream T-1.6's `useTranscriptStream`
// subscribes to) and emits whole `Utterance` records. An utterance is the unit
// the Stage-1 heuristic detector (T-2.1) and the Stage-2 Haiku filter (T-2.3)
// classify — feeding partial / interim chunks into either is wasteful and
// hurts precision.
//
// Boundary rules (see `docs/tasks/phase-2/T-2.2-sliding-window-silence-boundary.md`):
//   1. Silence gap ≥ silenceThresholdMs (default 800 ms) between the last
//      buffered chunk's endTs and the new chunk's startTs → flush, then start
//      a fresh buffer with the new chunk.
//   2. `isFinal === true` AND text ends in sentence-terminating punctuation
//      (`.`, `!`, `?`, `…`, `。`, `！`, `？`, optionally followed by a closing
//      quote/bracket) → append, flush.
//   3. `flush()` drains the buffer unconditionally (e.g. on meeting end).
//
// Sub-threshold gaps and `isFinal:false` chunks never close the utterance —
// they accumulate. This matches MLX whisper's interim-revision streaming.
//
// The struct is intentionally a plain closure (no React, no Tauri) so it stays
// unit-testable and is trivial to lift into the Rust helper daemon later if we
// want to move detection upstream.

import type { TranscriptChunk, Utterance } from "../../shared/types";

export interface SlidingWindowOptions {
  silenceThresholdMs?: number;
  endPunctuation?: RegExp;
}

export interface SlidingWindow {
  push(chunk: TranscriptChunk): Utterance[];
  flush(): Utterance[];
  pending(): Utterance | null;
  reset(): void;
}

export const DEFAULT_SILENCE_MS = 800;
// Sentence terminator (incl. CJK + ellipsis) optionally followed by a closing
// quote / bracket. Whitespace tolerated on either side of the closer.
const DEFAULT_END_PUNCTUATION = /[.!?…。！？]\s*["'’”)\]》」』]?\s*$/;

function compose(buffer: TranscriptChunk[]): Utterance | null {
  if (buffer.length === 0) return null;
  const text = buffer
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text,
    startTs: buffer[0].startTs,
    endTs: buffer[buffer.length - 1].endTs,
    chunkIds: buffer.map((c) => c.id),
  };
}

export function createSlidingWindow(
  opts: SlidingWindowOptions = {},
): SlidingWindow {
  const silenceMs = opts.silenceThresholdMs ?? DEFAULT_SILENCE_MS;
  const endPunct = opts.endPunctuation ?? DEFAULT_END_PUNCTUATION;

  let buffer: TranscriptChunk[] = [];

  return {
    push(chunk: TranscriptChunk): Utterance[] {
      const emitted: Utterance[] = [];

      // Rule 1 — silence gap between previous chunk and incoming chunk.
      // The incoming chunk starts a fresh buffer; do NOT discard it.
      if (buffer.length > 0) {
        const prev = buffer[buffer.length - 1];
        const gap = chunk.startTs - prev.endTs;
        if (gap >= silenceMs) {
          const flushed = compose(buffer);
          if (flushed) emitted.push(flushed);
          buffer = [];
        }
      }

      buffer.push(chunk);

      // Rule 2 — final-with-punctuation closes the (now updated) buffer.
      if (chunk.isFinal && endPunct.test(chunk.text.trim())) {
        const flushed = compose(buffer);
        if (flushed) emitted.push(flushed);
        buffer = [];
      }

      return emitted;
    },

    // Rule 3 — explicit drain, e.g. meeting end. Leaves the assembler ready
    // for reuse without a separate `reset()` call.
    flush(): Utterance[] {
      const flushed = compose(buffer);
      buffer = [];
      return flushed ? [flushed] : [];
    },

    pending(): Utterance | null {
      return compose(buffer);
    },

    reset(): void {
      buffer = [];
    },
  };
}
