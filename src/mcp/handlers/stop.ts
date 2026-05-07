// Phase 4 T-4.2 — Placeholder for `bridge_meeting_stop`.
// T-4.6 fills in the RPC stop call + idempotent check.

import { StopInputSchema, notImplementedResult, type ToolResult } from "../tools";

export interface StopHandlerDeps {
  // T-4.6 will inject: rpcClient, telemetry.
}

export async function handleStop(
  args: unknown,
  _deps: StopHandlerDeps = {},
): Promise<ToolResult> {
  StopInputSchema.parse(args);
  return notImplementedResult("T-4.6");
}
