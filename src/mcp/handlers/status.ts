// Phase 4 T-4.2 — Placeholder for `bridge_meeting_status`.
// T-4.5 fills in the Unix-socket RPC client.

import { StatusInputSchema, notImplementedResult, type ToolResult } from "../tools";

export interface StatusHandlerDeps {
  // T-4.5 will inject: socketPathResolver, connect, telemetry.
}

export async function handleStatus(
  args: unknown,
  _deps: StatusHandlerDeps = {},
): Promise<ToolResult> {
  StatusInputSchema.parse(args);
  return notImplementedResult("T-4.5");
}
