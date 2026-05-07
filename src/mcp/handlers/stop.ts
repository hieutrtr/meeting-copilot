// Phase 4 T-4.6 — `bridge_meeting_stop` handler.
//
// Mutating counterpart to T-4.5's read-only status: dials the helper-daemon's
// Unix-domain RPC socket, sends `{"method":"stop","meetingId":"…"}`, parses the
// single-line response, and returns the validated envelope.
//
// Response is one of two shapes:
//   - success: `{exportedPath?, durationSec, questionCount}` — re-parsed
//     through `StopOutputSchema` and surfaced as `structuredContent`.
//   - daemon error envelope: `{"error":{"code":"…","message":"…"}}`. The only
//     code we map to a typed envelope is `DaemonMeetingNotFound` →
//     `MeetingNotFound`. Any other code is re-thrown so `server.ts`'s catch
//     surfaces the original message verbatim — same fail-loud philosophy as
//     T-4.5 (operator wants the diagnostic text, not a swallowed `NotImplemented`).
//
// Idempotency note: the **daemon** owns the idempotency contract. It caches
// the first stop's `StopRecord` and replays it on subsequent calls with the
// same meetingId. The handler is pure transport; it does not implement
// client-side caching, because two MCP-server processes targeting one daemon
// would otherwise see divergent state. Two same-args calls from the same
// process therefore each round-trip — but each round-trip returns the same
// shape, so the caller sees an idempotent envelope.

import {
  SocketPathRejected,
  dialSocket,
  resolveSocketPath,
  type DialSocketOpts,
  type ResolveSocketPathOpts,
} from "../socket";
import {
  StopInputSchema,
  StopOutputSchema,
  errorResult,
  type StopOutput,
  type ToolResult,
} from "../tools";

export interface StopHandlerDeps {
  /** Override `os.homedir()` / `process.env` for the path resolver. Tests use
   *  this to keep the resolver from touching real env vars. */
  resolveSocketPathOpts?: ResolveSocketPathOpts;
  /** Override the dial helper. Tests pass a stub that returns a fixture
   *  reply without binding any actual socket. */
  dialSocket?: typeof dialSocket;
  /** Pass-through to `dialSocket` for timeout overrides. */
  dialOpts?: Omit<DialSocketOpts, "createConnection">;
}

interface DaemonErrorEnvelope {
  error: { code: string; message: string };
}

function isDaemonErrorEnvelope(v: unknown): v is DaemonErrorEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const err = (v as Record<string, unknown>).error;
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  const message = (err as Record<string, unknown>).message;
  return typeof code === "string" && typeof message === "string";
}

export async function handleStop(
  args: unknown,
  deps: StopHandlerDeps = {},
): Promise<ToolResult> {
  const input = StopInputSchema.parse(args);

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
    { method: "stop", meetingId: input.meetingId },
    deps.dialOpts ?? {},
  );

  if (isDaemonErrorEnvelope(reply)) {
    if (reply.error.code === "DaemonMeetingNotFound") {
      return errorResult("MeetingNotFound", reply.error.message);
    }
    // Unknown error code — re-throw so server.ts catch maps to a generic
    // NotImplemented-bucket envelope with the daemon's original message.
    throw new Error(`daemon ${reply.error.code}: ${reply.error.message}`);
  }

  const parsed: StopOutput = StopOutputSchema.parse(reply);
  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
    structuredContent: parsed,
  };
}
