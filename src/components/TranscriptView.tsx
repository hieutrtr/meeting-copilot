// Phase 1 T-1.7 — props-in / DOM-out transcript list with windowed rendering.
//
// The component is intentionally state-less w.r.t. the live event stream: callers
// (T-1.9 Start Meeting wiring) pass the `chunks` array from `useTranscriptStream`.
// This keeps the unit-test surface free of Tauri mocks and lets T-1.13 reuse the
// same component against a fixture-driven smoke harness.
//
// Virtualization: fixed row height + simple `scrollTop` math + over-render constant.
// We deliberately avoid `react-window` / `react-virtuoso` — both need a
// `ResizeObserver` polyfill under jsdom and add bundle weight Phase 1 doesn't
// need (T-1.7 task file §"Risk + Mitigation").

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { TranscriptChunk } from "../../shared/types";

const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_VIEWPORT_HEIGHT = 480;
const OVERSCAN = 5;

export interface TranscriptViewProps {
  chunks: TranscriptChunk[];
  rowHeight?: number;
  viewportHeight?: number;
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `[${pad(m)}:${pad(s)}]`;
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function TranscriptView({
  chunks,
  rowHeight = DEFAULT_ROW_HEIGHT,
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
}: TranscriptViewProps) {
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter((c) => c.text.toLowerCase().includes(q));
  }, [chunks, query]);

  // Auto-scroll on filtered-list-length change. Sets scrollTop on the container
  // and calls scrollIntoView on the bottom sentinel so the AC-3 test can
  // observe the scroll regardless of jsdom's no-op layout.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const target = Math.max(0, filtered.length * rowHeight - viewportHeight);
    if (container) {
      container.scrollTop = target;
    }
    setScrollTop(target);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [filtered.length, rowHeight, viewportHeight]);

  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN,
  );
  const visible = filtered.slice(startIdx, endIdx);

  return (
    <div className="transcript-view">
      <input
        type="search"
        aria-label="Search transcript"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="transcript-view__search"
      />
      <div
        ref={containerRef}
        className="transcript-view__scroll"
        style={{ height: viewportHeight, overflowY: "auto", position: "relative" }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <ul
          className="transcript-view__list"
          style={{
            height: filtered.length * rowHeight,
            position: "relative",
            margin: 0,
            padding: 0,
            listStyle: "none",
          }}
        >
          {visible.map((chunk, offset) => {
            const absoluteIdx = startIdx + offset;
            return (
              <li
                key={chunk.id}
                className="transcript-view__row"
                style={{
                  position: "absolute",
                  top: absoluteIdx * rowHeight,
                  left: 0,
                  right: 0,
                  height: rowHeight,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <span className="transcript-view__ts" aria-hidden="true">
                  {formatTimestamp(chunk.startTs)}
                </span>
                <span className="transcript-view__text">{highlight(chunk.text, query)}</span>
              </li>
            );
          })}
        </ul>
        <div ref={bottomRef} aria-hidden="true" />
      </div>
    </div>
  );
}
