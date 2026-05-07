// Phase 4 T-4.5 — `bridge_meeting_status` handler.
//
// Read-only probe: dials the helper-daemon's Unix-domain RPC socket, sends a
// single line of JSON `{"method":"status"[,"meetingId":"…"]}`, parses the
// single line response back through `StatusOutputSchema`, and returns the
// validated envelope to the MCP caller. Filters by `meetingId` client-side
// (the daemon already filters too — but we re-check defensively so a wider
// daemon response can never leak meetings past a narrowed filter).
//
// Failure paths (typed envelopes, no panic):
//   - `BridgeConfigInvalid` — `MCP_BRIDGE_HOME` env value rejected by the
//     resolver (traversal / non-absolute).
//   - `MeetingNotFound`   — `meetingId` filter returns 0 rows.
//   - thrown out          — schema-drift between daemon and MCP envelope, or
//                           any socket I/O failure (connect, timeout, EPIPE).
//                           `server.ts`'s try/catch maps these to a generic
//                           `NotImplemented`-bucket isError envelope per the
//                           T-4.2 dispatch design. We do NOT swallow these
//                           with our own typed envelope because the operator
//                           wants the original error message verbatim for
//                           diagnosis.

import {
  SocketPathRejected,
  dialSocket,
  resolveSocketPath,
  type DialSocketOpts,
  type ResolveSocketPathOpts,
} from "../socket";
import {
  StatusInputSchema,
  StatusOutputSchema,
  errorResult,
  type StatusOutput,
  type ToolResult,
} from "../tools";

export interface StatusHandlerDeps {
  /** Override `os.homedir()` / `process.env` for the path resolver. Tests use
   *  this to keep the resolver from touching real env vars. */
  resolveSocketPathOpts?: ResolveSocketPathOpts;
  /** Override the dial helper. Tests pass a stub that returns a fixture
   *  reply without binding any actual socket. */
  dialSocket?: typeof dialSocket;
  /** Pass-through to `dialSocket` for timeout overrides. */
  dialOpts?: Omit<DialSocketOpts, "createConnection">;
}

export async function handleStatus(
  args: unknown,
  deps: StatusHandlerDeps = {},
): Promise<ToolResult> {
  const input = StatusInputSchema.parse(args);

  let socketPath: string;
  try {
    socketPath = resolveSocketPath(deps.resolveSocketPathOpts);
  } catch (err) {
    if (err instanceof SocketPathRejected) {
      return errorResult("BridgeConfigInvalid", err.message);
    }
    throw err;
  }

  const dial = deps.dialSocket ?? dialSocket;
  const reply = await dial(
    socketPath,
    input.meetingId
      ? { method: "status", meetingId: input.meetingId }
      : { method: "status" },
    deps.dialOpts ?? {},
  );

  // Re-parse the daemon's response through the MCP envelope. Any drift fails
  // here loudly; we'd rather return a typed isError than an off-shape success.
  const parsed = StatusOutputSchema.parse(reply);

  // Defense-in-depth filter: if the caller provided a meetingId, the daemon
  // *should* already have filtered, but a daemon bug or version skew could
  // return a wider list. Filter again client-side and surface MeetingNotFound
  // if nothing matches.
  let meetings = parsed.meetings;
  if (input.meetingId) {
    meetings = meetings.filter((m) => m.id === input.meetingId);
    if (meetings.length === 0) {
      return errorResult(
        "MeetingNotFound",
        `no running meeting with id "${input.meetingId}"`,
      );
    }
  }

  const payload: StatusOutput = { meetings };
  // Defense-in-depth: re-validate the post-filter payload.
  const validated = StatusOutputSchema.parse(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated,
  };
}
