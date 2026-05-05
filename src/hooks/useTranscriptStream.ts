// Phase 1 T-1.6 — React subscription glue for the `transcript:chunk` Tauri event.
// The plain `subscribeTranscriptStream` function is the unit-testable seam; the hook is a
// thin useState + useEffect wrapper so T-1.7's `TranscriptView` can read live chunks.
//
// Schema contract: payload shape is `TranscriptChunk` from `shared/types.ts`. The Rust
// bridge emits camelCase JSON so the round-trip is byte-identical (verified by the
// `event_bridge_serialises_to_canonical_json` Rust test + the schema-parity vitest case).

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { TranscriptChunk } from "../../shared/types";

export const TRANSCRIPT_CHUNK_EVENT = "transcript:chunk" as const;

/**
 * Subscribe to transcript chunks emitted by the Rust event bridge. Returns the unlisten
 * function so callers (or the hook below) can clean up on unmount.
 *
 * Tests drive this directly — `vi.mock("@tauri-apps/api/event")` lets us simulate any
 * sequence of events without spinning up a Tauri runtime.
 */
export async function subscribeTranscriptStream(
  handler: (chunk: TranscriptChunk) => void,
): Promise<UnlistenFn> {
  return await listen<TranscriptChunk>(TRANSCRIPT_CHUNK_EVENT, (event) => {
    handler(event.payload);
  });
}

export interface UseTranscriptStream {
  chunks: TranscriptChunk[];
  clear: () => void;
}

/**
 * Accumulate every emitted `TranscriptChunk` into React state. Phase 1 keeps the full
 * list in memory (≤ 30 chunks/min * 60 min ≈ 1800 entries — well under the limit where
 * virtualisation matters; T-1.7 adds the virtualised list).
 */
export function useTranscriptStream(): UseTranscriptStream {
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    subscribeTranscriptStream((chunk) => {
      if (cancelled) return;
      setChunks((prev) => [...prev, chunk]);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
    });

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  return {
    chunks,
    clear: () => setChunks([]),
  };
}
