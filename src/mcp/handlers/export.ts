// Phase 4 T-4.2 — Placeholder for `bridge_meeting_export`.
// T-4.7 fills in the markdown/json/vtt/srt renderers + path-traversal guard.

import { ExportInputSchema, notImplementedResult, type ToolResult } from "../tools";

export interface ExportHandlerDeps {
  // T-4.7 will inject: persistClient, exporters[format], outputDir, telemetry.
}

export async function handleExport(
  args: unknown,
  _deps: ExportHandlerDeps = {},
): Promise<ToolResult> {
  ExportInputSchema.parse(args);
  return notImplementedResult("T-4.7");
}
