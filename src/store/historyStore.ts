// Phase 1 T-1.13 — past-meetings store slice.
//
// Single consumer (`<PastMeetings />`). Hydrated by `useMeetingPersist` on
// mount via `loadMeetings()`. Clicking-into-a-past-meeting to re-hydrate the
// transcript + answer is Phase 1.x; this slice ships the count + the list.

import { create } from "zustand";

import type { MeetingSession } from "../../shared/types";

export interface HistoryState {
  pastMeetings: MeetingSession[];
  setPastMeetings: (rows: MeetingSession[]) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  pastMeetings: [],
  setPastMeetings: (rows) => set({ pastMeetings: rows }),
  clear: () => set({ pastMeetings: [] }),
}));
