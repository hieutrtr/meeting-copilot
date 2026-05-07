// Phase 4 T-4.2 — Placeholder for `bridge_meeting_start`.
// T-4.4 fills in the privacy gate + URLSearchParams deeplink build + spawn.

import { StartInputSchema, notImplementedResult, type ToolResult } from "../tools";

export interface StartHandlerDeps {
  // T-4.4 will inject: privacyGate, urlBuilder, spawn, rpcPoller, telemetry.
}

export async function handleStart(
  args: unknown,
  _deps: StartHandlerDeps = {},
): Promise<ToolResult> {
  StartInputSchema.parse(args);
  return notImplementedResult("T-4.4");
}
