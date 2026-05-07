// Phase 4 T-4.4 — Deeplink builder for `meeting-copilot://start?...`.
//
// Pure URL builder. NEVER concatenates strings into the query — every value
// goes through `URLSearchParams` so percent-encoding is applied uniformly to
// shell metacharacters (`&`, `;`, `'`, `"`), unicode, and path components.
//
// This module is the security perimeter for deeplink construction. The risk
// it mitigates is R-2 ("deeplink injection") in `docs/tasks/phase-4/INDEX.md`:
// a caller passes a `contextPaths` value with shell-meaningful characters or
// a `..` traversal sequence; if we string-concat into the deeplink, the
// receiving Tauri app could load attacker-controlled paths.
//
// Two layers:
//   1. `validateContextPaths(paths)` — synchronous structural reject of
//      traversal/null-byte/empty-string before any URL build.
//   2. `URLSearchParams` — percent-encodes all values; the resulting URL is
//      always safe to pass as a single argv element to `open(1)`.
//
// `child_process.spawn` MUST be invoked with the array form (no `shell:true`)
// so that even a deeplink containing shell metacharacters cannot be
// reinterpreted as a command. The handler at `handlers/start.ts` enforces
// this; this module emits the URL only.

import type { StartInput } from "./tools";

export const DEEPLINK_SCHEME = "meeting-copilot" as const;
export const DEEPLINK_ACTION_START = "start" as const;

/** Maximum length of a single context path string. Mirrors the Zod schema's
 * upper bound (`.max(4096)`); restated here so this module is self-contained
 * and the validate function can be re-used outside the Zod parse path. */
export const MAX_CONTEXT_PATH_LEN = 4096;

/** Maximum number of context paths in a single start request. Mirrors the Zod
 * schema's `.max(64)`. */
export const MAX_CONTEXT_PATH_COUNT = 64;

// Use a fromCharCode constant rather than a literal NUL byte in the source
// file so the file stays text-clean (some tooling treats files containing a
// raw NUL as binary).
const NUL_CHAR = String.fromCharCode(0);

/** Thrown by `validateContextPaths`; the caller in `handlers/start.ts` maps
 *  this to a typed `ContextNotFound` error envelope. The `path` property
 *  preserves the offending input for the human-readable message — it is
 *  truncated by the caller for safety. */
export class ContextPathRejected extends Error {
  readonly path: string;
  readonly reason:
    | "traversal"
    | "null-byte"
    | "empty"
    | "too-long"
    | "too-many";

  constructor(path: string, reason: ContextPathRejected["reason"]) {
    super(`contextPath rejected (${reason}): ${truncateForMessage(path)}`);
    this.name = "ContextPathRejected";
    this.path = path;
    this.reason = reason;
  }
}

function truncateForMessage(s: string): string {
  if (s.length <= 64) return s;
  return `${s.slice(0, 60)}…`;
}

/**
 * Reject paths that contain `..` traversal segments, embedded NULs, or empty
 * strings. Does NOT touch the filesystem (no `fs.statSync`) — the per-path
 * filesystem existence check is the receiving Tauri app's responsibility, and
 * pre-checking here would create a TOCTOU window. We are only blocking
 * structural injection vectors.
 *
 * Tested cases include `../etc/passwd`, percent-encoded traversal
 * (`..%2Fetc%2Fpasswd` — must reject; the `..` substring still appears), null
 * byte injection, and empty string. See `deeplink.test.ts`.
 */
export function validateContextPaths(paths: readonly string[]): void {
  if (paths.length > MAX_CONTEXT_PATH_COUNT) {
    throw new ContextPathRejected(`${paths.length} paths`, "too-many");
  }
  for (const p of paths) {
    if (p.length === 0) {
      throw new ContextPathRejected(p, "empty");
    }
    if (p.length > MAX_CONTEXT_PATH_LEN) {
      throw new ContextPathRejected(p, "too-long");
    }
    if (p.includes(NUL_CHAR)) {
      throw new ContextPathRejected(p, "null-byte");
    }
    // Reject any `..` segment — split on both `/` and `\` to catch Windows-
    // style paths just in case (we're macOS-targeted but defense-in-depth).
    // Also reject percent-encoded traversal: decoding once is enough since
    // `URLSearchParams` will percent-encode the raw `%2E%2E` literally — we
    // check the decoded form so the receiving app doesn't end up with `..`
    // after one round of decode.
    let decoded = p;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      // Malformed percent-encoding — treat the original as the value to check.
      decoded = p;
    }
    const segments = decoded.split(/[/\\]/);
    if (segments.some((seg) => seg === "..")) {
      throw new ContextPathRejected(p, "traversal");
    }
  }
}

/**
 * Build the `meeting-copilot://start?...` deeplink for a validated start
 * request. The caller MUST have already run `validateContextPaths` on
 * `input.contextPaths` (the high-level `handleStart` does this); this builder
 * performs no validation beyond Zod's prior check, and produces a
 * percent-encoded URL.
 *
 * Each `contextPaths[]` entry becomes a separate `contextPath=...` query
 * parameter (NOT a comma-joined single param) so values containing commas
 * round-trip cleanly.
 */
export function buildStartDeeplink(input: StartInput): string {
  const params = new URLSearchParams();
  // Required scalars first — stable order for golden-test asserting.
  params.set("sttProvider", input.sttProvider);
  params.set("model", input.model);
  params.set("privacyMode", input.privacyMode);
  if (input.ttsProvider !== undefined) {
    params.set("ttsProvider", input.ttsProvider);
  }
  if (input.meetingTitle !== undefined) {
    params.set("meetingTitle", input.meetingTitle);
  }
  // contextPaths last so they cluster at the end of the query string. Each
  // entry is its own `contextPath=` param; URLSearchParams handles the
  // percent-encoding.
  for (const p of input.contextPaths) {
    params.append("contextPath", p);
  }
  return `${DEEPLINK_SCHEME}://${DEEPLINK_ACTION_START}?${params.toString()}`;
}
