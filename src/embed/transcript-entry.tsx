// Phase 4 T-4.9 — Vite build entry for the dashboard iframe transcript
// view. Bundled to `dist/embed/transcript.js` via the rollup input added
// in `vite.config.ts`. Loaded by the static HTML shell at
// `dist/embed/transcript.html`.
//
// Reads `meetingId` from the URL pathname (`/embed/transcript/<meetingId>`)
// and `token` from the query string (`?token=<UUID>`). Both are minted by
// `bridge_meeting_start` and embedded in `uiUrl` — the iframe never has to
// produce them itself.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TranscriptEmbed } from "./TranscriptEmbed";

function readMeetingIdFromPath(pathname: string): string | null {
  // Match `/embed/transcript/<meetingId>` (no trailing slash). The static
  // HTML is served from the daemon at this same path, so `window.location`
  // already carries the segment we need.
  const match = pathname.match(/^\/embed\/transcript\/([^/?#]+)\/?$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

function readTokenFromQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get("token");
}

function bootstrap(): void {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("transcript-entry: missing #root element");
  }

  const meetingId = readMeetingIdFromPath(window.location.pathname);
  const token = readTokenFromQuery(window.location.search);

  if (!meetingId || !token) {
    root.textContent = "Missing meetingId or token in iframe URL.";
    return;
  }

  createRoot(root).render(
    <StrictMode>
      <TranscriptEmbed meetingId={meetingId} token={token} />
    </StrictMode>,
  );
}

bootstrap();

export { readMeetingIdFromPath, readTokenFromQuery };
