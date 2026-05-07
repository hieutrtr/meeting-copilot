// Phase 4 T-4.2 — Placeholder for `bridge_meeting_install`.
// T-4.3 fills in the Info.plist parse + version check + downloadUrl logic.

import { InstallInputSchema, notImplementedResult, type ToolResult } from "../tools";

export interface InstallHandlerDeps {
  // T-4.3 will add: readInfoPlist, packageVersion, githubReleaseUrl, etc.
  // Empty in T-4.2 — present so tests + future tasks share the seam shape.
}

export async function handleInstall(
  args: unknown,
  _deps: InstallHandlerDeps = {},
): Promise<ToolResult> {
  // We still parse the input so unknown-key / type errors surface as Zod
  // failures even at the placeholder stage — keeps the tool contract honest
  // before T-4.3 lands.
  InstallInputSchema.parse(args);
  return notImplementedResult("T-4.3");
}
