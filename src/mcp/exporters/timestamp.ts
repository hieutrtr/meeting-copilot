// Phase 4 T-4.7 — Shared HH:MM:SS.mmm / HH:MM:SS,mmm timestamp formatter.
//
// VTT (WebVTT spec) requires `.` as the millisecond separator; SRT (SubRip
// spec) requires `,`. Both use a 2-digit hour, minute, second, zero-padded
// to width 2, and a 3-digit millisecond, zero-padded to width 3.
//
// Rules:
//   - Negative durations clamp to 0 (with a console.warn in the formatter
//     itself once per call). Negative input means a chunk's start_ts arrived
//     before the meeting's startedAt, which is a callsite bug; we do not let
//     it produce a malformed timestamp like `-01:00:00.000`.
//   - Hours > 99 wrap via modulo with a console.warn; meetings > 100h are out
//     of scope. The tests exercise the wrap to guarantee no `100:`-style
//     three-digit hour leaks into a downstream parser.

export type TimestampSeparator = "." | ",";

export function formatTimestamp(
  ms: number,
  separator: TimestampSeparator = ".",
): string {
  let normalised = Math.floor(ms);
  if (!Number.isFinite(ms) || Number.isNaN(ms) || ms < 0) {
    // Soft-clamp; callsites have stronger contracts upstream but we do not
    // produce a malformed timestamp under any input.
    console.warn(
      `formatTimestamp: clamping negative/NaN input ${ms} to 0`,
    );
    normalised = 0;
  }

  const totalMs = normalised;
  const totalSeconds = Math.floor(totalMs / 1000);
  const millis = totalMs - totalSeconds * 1000;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds - hours * 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;

  let renderedHours = hours;
  if (hours > 99) {
    console.warn(
      `formatTimestamp: hours=${hours} exceeds 99h cap; wrapping with modulo`,
    );
    renderedHours = hours % 100;
  }

  const hh = String(renderedHours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss}${separator}${mmm}`;
}
