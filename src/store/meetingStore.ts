// Phase 1 T-1.9 — meeting state-machine store.
//
// Front-end state machine: idle → active → ended → (reset) → idle. The Tauri
// helper-daemon already owns the matching `MeetingStatus` enum (see
// `crates/helper-daemon/src/bridge.rs`); the back-end pump wiring (audio →
// chunker → STT → bridge driven by Start) lands in T-1.13. T-1.9 ships only
// the front-end store + UI controls so T-1.10 (Claude Q&A) can read the
// meeting id + status.
//
// Invariants (per AC-6):
//   - `start()` while active or ended is a silent no-op (double-click safe).
//   - `stop()` while idle is a silent no-op.
//   - `reset()` always returns to the idle baseline (test affordance + lets the
//     user start a follow-up meeting after Stop).

import { create } from "zustand";

import type { MeetingStatus } from "../../shared/types";

export interface MeetingState {
  status: MeetingStatus;
  meetingId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  start: (opts?: { meetingId?: string; now?: number }) => void;
  stop: (opts?: { now?: number }) => void;
  reset: () => void;
}

const INITIAL = {
  status: "idle" as MeetingStatus,
  meetingId: null,
  startedAt: null,
  endedAt: null,
};

function generateMeetingId(): string {
  // `crypto.randomUUID()` is available under jsdom (Node 19+) and the Tauri
  // webview. Fall back to a short timestamp + random tail just in case the
  // runtime is older than expected.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `m-${c.randomUUID()}`;
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useMeetingStore = create<MeetingState>((set, get) => ({
  ...INITIAL,
  start: (opts) => {
    if (get().status !== "idle") return;
    const now = opts?.now ?? Date.now();
    const meetingId = opts?.meetingId ?? generateMeetingId();
    set({ status: "active", meetingId, startedAt: now, endedAt: null });
  },
  stop: (opts) => {
    if (get().status !== "active") return;
    const now = opts?.now ?? Date.now();
    set({ status: "ended", endedAt: now });
  },
  reset: () => set({ ...INITIAL }),
}));
