// Phase 4 T-4.2 — MCP tool surface (5 tools).
//
// Source of truth for: tool names, Zod input/output schemas, JSON-Schema
// derivation for `tools/list`, and the closed error-code set returned by
// every handler. Per T-4.1 §4 the surface is frozen here; T-4.3..T-4.7 fill
// each handler in without renegotiating the contract.
//
// Companion design: `docs/tasks/phase-4/T-4.1-integration-design.md`.
// Reference impl: `claude-bridge` daemon `src/mcp/tools.ts` (TOOL_NAMES +
// TOOL_DEFINITIONS shape — same idea, JSON-Schema authored from Zod here).

// Note on the import shape: vitest 4's ESM resolver currently fails to
// surface the `z` named export from `zod@3.25` (returns undefined inside the
// transformed test module) — `import { z } from "zod"` works under bun run
// and tsc but not under vitest. The namespace import below works in all
// three: bun, tsc, vitest 4. Keep this shape until vitest fixes the bug.
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// --- Tool Names Registry ---------------------------------------------------

export const TOOL_NAMES = [
  "bridge_meeting_install",
  "bridge_meeting_start",
  "bridge_meeting_status",
  "bridge_meeting_stop",
  "bridge_meeting_export",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

// --- Closed Error Code Set -------------------------------------------------
//
// Per T-4.1 §4 the error envelope text is `<ErrorCode>: <message>`. Adding a
// new code requires updating this list AND the relevant handler test. Frozen
// to make accidental drift visible.

export const ERROR_CODES = Object.freeze([
  "NotImplemented",
  "PrivacyModeViolation",
  "DeeplinkNotRegistered",
  "ContextNotFound",
  "MeetingNotFound",
  "InvalidMeetingId",
  "ConfigSchemaUnsupported",
  "BridgeConfigInvalid",
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

// Standard MCP envelope (matches `@modelcontextprotocol/sdk` `CallToolResult`
// shape — `content[]` of typed parts plus optional `isError`).
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // Pass-through for handlers that want to return structured data alongside
  // the human-readable text. T-4.3..T-4.7 populate this with the typed
  // output objects.
  structuredContent?: Record<string, unknown>;
}

export function errorResult(code: ErrorCode, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

export function notImplementedResult(taskRef: string): ToolResult {
  return errorResult(
    "NotImplemented",
    `placeholder — ${taskRef} fills this in. Skeleton was laid down by T-4.2.`,
  );
}

// --- STT / TTS / Privacy enums (mirrors `src/llm/sttPricing` + `src/privacy/privacyMode`)
//
// We re-state the enum literals here so the Zod schema is self-contained and
// `zodToJsonSchema` produces a complete `tools/list` payload without any
// runtime cross-import on the privacy module. The downstream handlers
// (T-4.4) cross-check against `isSttProviderAllowed` from the privacy module
// — that is the authoritative gate. If the lists drift we want a parity test
// to fail loudly, so `tools.test.ts` enforces equality with the privacy
// module's enums.

export const STT_PROVIDER_ENUM = ["mlx", "fake", "deepgram", "elevenlabs"] as const;
export const TTS_PROVIDER_ENUM = ["off", "elevenlabs"] as const;
export const PRIVACY_MODE_ENUM = ["local-first", "cloud", "mixed"] as const;
export const MODEL_ENUM = ["claude-sonnet-4-6", "claude-haiku-4-5"] as const;
export const EXPORT_FORMAT_ENUM = ["markdown", "json", "vtt", "srt"] as const;

// --- Zod Input/Output Schemas ---------------------------------------------

// 1. bridge_meeting_install
export const InstallInputSchema = z
  .object({
    source: z.enum(["github", "local"]).optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
    version: z.string().optional(),
  })
  .strict();

export const InstallOutputSchema = z
  .object({
    installed: z.boolean(),
    version: z.string().optional(),
    expectedVersion: z.string(),
    downloadUrl: z.string().url().optional(),
    message: z.string(),
  })
  .strict();

// 2. bridge_meeting_start
//
// Note: `contextPaths` strings are re-validated for path traversal in the
// T-4.4 handler; the Zod schema enforces non-empty + max-length only here so
// that the JSON Schema published in `tools/list` stays portable.
export const StartInputSchema = z
  .object({
    contextPaths: z.array(z.string().min(1).max(4096)).max(64).default([]),
    sttProvider: z.enum(STT_PROVIDER_ENUM),
    ttsProvider: z.enum(TTS_PROVIDER_ENUM).optional(),
    model: z.enum(MODEL_ENUM),
    privacyMode: z.enum(PRIVACY_MODE_ENUM),
    meetingTitle: z.string().min(1).max(200).optional(),
  })
  .strict();

export const StartOutputSchema = z
  .object({
    meetingId: z.string().min(1),
    pid: z.number().int().nonnegative(),
    rpcSocket: z.string().min(1),
    uiUrl: z.string().url(),
  })
  .strict();

// 3. bridge_meeting_status
export const StatusInputSchema = z
  .object({
    meetingId: z.string().min(1).optional(),
  })
  .strict();

export const StatusOutputSchema = z
  .object({
    meetings: z.array(
      z
        .object({
          id: z.string(),
          pid: z.number().int().nonnegative(),
          startedAt: z.number(),
          sttProvider: z.enum(STT_PROVIDER_ENUM),
          transcriptChunks: z.number().int().nonnegative(),
          questionCount: z.number().int().nonnegative(),
          answerCount: z.number().int().nonnegative(),
          uptimeSec: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

// 4. bridge_meeting_stop
export const StopInputSchema = z
  .object({
    meetingId: z.string().min(1),
  })
  .strict();

export const StopOutputSchema = z
  .object({
    exportedPath: z.string().optional(),
    durationSec: z.number().nonnegative(),
    questionCount: z.number().int().nonnegative(),
  })
  .strict();

// 5. bridge_meeting_export
export const ExportInputSchema = z
  .object({
    meetingId: z.string().min(1),
    format: z.enum(EXPORT_FORMAT_ENUM),
  })
  .strict();

export const ExportOutputSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

// --- Tool Definitions (for `tools/list`) ----------------------------------

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: ReturnType<typeof zodToJsonSchema>;
}

function jsonSchemaFor(schema: z.ZodTypeAny): ReturnType<typeof zodToJsonSchema> {
  return zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" });
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "bridge_meeting_install",
    description:
      "Check whether Meeting Copilot.app is installed and report the version. Idempotent; never mutates the filesystem (Phase 4 — install-from-URL deferred).",
    inputSchema: jsonSchemaFor(InstallInputSchema),
  },
  {
    name: "bridge_meeting_start",
    description:
      "Spawn Meeting Copilot.app via the meeting-copilot:// deeplink. Validates privacy mode against the requested STT provider before any process spawn; rejects with PrivacyModeViolation if disallowed.",
    inputSchema: jsonSchemaFor(StartInputSchema),
  },
  {
    name: "bridge_meeting_status",
    description:
      "List currently-running meetings or query a single meeting by id. Reads from the helper-daemon RPC socket; never spawns or mutates state.",
    inputSchema: jsonSchemaFor(StatusInputSchema),
  },
  {
    name: "bridge_meeting_stop",
    description:
      "Stop a running meeting, flush its STT buffer, and persist final state. Idempotent: stopping an already-stopped meeting returns the recorded values.",
    inputSchema: jsonSchemaFor(StopInputSchema),
  },
  {
    name: "bridge_meeting_export",
    description:
      "Export a meeting's transcript + Q/A in markdown, json, vtt, or srt. Writes to ~/.claude-bridge/meeting-copilot/exports/<meetingId>.<ext>; rejects path-traversal in meetingId.",
    inputSchema: jsonSchemaFor(ExportInputSchema),
  },
]);

// --- Inferred TS types (re-exported via `shared/types.ts`) ----------------

export type InstallInput = z.infer<typeof InstallInputSchema>;
export type InstallOutput = z.infer<typeof InstallOutputSchema>;
export type StartInput = z.infer<typeof StartInputSchema>;
export type StartOutput = z.infer<typeof StartOutputSchema>;
export type StatusInput = z.infer<typeof StatusInputSchema>;
export type StatusOutput = z.infer<typeof StatusOutputSchema>;
export type StopInput = z.infer<typeof StopInputSchema>;
export type StopOutput = z.infer<typeof StopOutputSchema>;
export type ExportInput = z.infer<typeof ExportInputSchema>;
export type ExportOutput = z.infer<typeof ExportOutputSchema>;
