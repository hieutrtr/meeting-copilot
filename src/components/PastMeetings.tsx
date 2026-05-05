// Phase 1 T-1.13 — past-meetings count + list (read-only).
//
// Reads `useHistoryStore`. The store is hydrated on mount by
// `useMeetingPersist` via `loadMeetings()`. Clicking-into a past meeting to
// re-hydrate the live transcript pane is Phase 1.x; this view shows the
// count + the titles only.

import { useHistoryStore } from "../store/historyStore";

export function PastMeetings() {
  const past = useHistoryStore((s) => s.pastMeetings);

  return (
    <section className="past-meetings" aria-label="Past meetings">
      <h2>Past meetings</h2>
      <p data-testid="past-meetings-count">{past.length} past meeting{past.length === 1 ? "" : "s"}</p>
      {past.length > 0 && (
        <ul data-testid="past-meetings-list">
          {past.map((m) => (
            <li key={m.id} data-testid="past-meeting-item">
              {m.title} <span className="past-meetings__id">({m.id})</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
