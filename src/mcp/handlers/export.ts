// Phase 4 T-4.7 — `bridge_meeting_export` handler.
//
// Read-side surface: load the meeting snapshot, render it via one of 4 pure
// exporters (markdown / json / vtt / srt), atomically write the result to
// disk, and return `{path, sizeBytes}`. Never dials the helper-daemon socket
// (T-4.5/T-4.6 own that surface); the snapshot loader is a DI seam so the
// production wiring (Phase 4.x: `bun:sqlite` direct read or Tauri-context
// `persistClient.ts` invoke) can land without touching this file.
//
// Path-traversal guard runs at handler layer (NOT pushed into Zod) so the
// error envelope carries a meaningful `InvalidMeetingId` code rather than a
// generic ZodError. 6 vectors guarded: `..`, `/`, `\`, NUL byte, leading
// slash, empty (Zod min(1) covers this but we re-assert defence-in-depth).
//
// Atomic write = `writeFile(tmp); rename(tmp, final)` — same shape as
// `claude-bridge/src/lib/dashboard-installer.ts`. The tmp filename includes
// pid + a random suffix to avoid races between two MCP-server processes.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { renderJson } from "../exporters/json";
import { renderMarkdown } from "../exporters/markdown";
import { renderSrt } from "../exporters/srt";
import type {
  ExporterFormat,
  ExporterMeetingSnapshot,
  RenderedExport,
} from "../exporters/types";
import { renderVtt } from "../exporters/vtt";
import {
  ExportInputSchema,
  ExportOutputSchema,
  errorResult,
  type ExportOutput,
  type ToolResult,
} from "../tools";

/** Subdirectory under the resolved bridge-home for export files. Mirrors the
 *  socket convention `<bridge-home>/meeting-copilot.sock` → here as
 *  `<bridge-home>/meeting-copilot/exports/<id>.<ext>`. */
export const EXPORT_HOME_SUBDIR = ["meeting-copilot", "exports"] as const;
export const BRIDGE_HOME_DIRNAME = ".claude-bridge" as const;

export type SnapshotLoader = (
  meetingId: string,
) => Promise<ExporterMeetingSnapshot | null>;

export interface ExportHandlerDeps {
  /** Load the meeting snapshot for `meetingId`. Return `null` for missing. */
  loadSnapshot?: SnapshotLoader;
  /** Override the export root directory. Tests inject a tmpdir; production
   *  resolves via `MCP_BRIDGE_HOME` env override or `~/.claude-bridge`. */
  exportRoot?: string;
  /** Override `os.homedir()` — tests inject a fixed string. */
  homedir?: () => string;
  /** Override `process.env` lookup — tests inject a synthetic env object. */
  env?: Record<string, string | undefined>;
  /** Override fs writes — tests can spy or fail-inject. */
  fs?: {
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
    rename: typeof rename;
    stat: typeof stat;
    unlink: typeof unlink;
  };
}

const RENDERERS: Record<ExporterFormat, (s: ExporterMeetingSnapshot) => RenderedExport> = {
  markdown: renderMarkdown,
  json: renderJson,
  vtt: renderVtt,
  srt: renderSrt,
};

/** Reject ids that could escape the export root or break filesystem
 *  invariants. Returns the rejection reason or `null` if the id is safe. */
export function checkMeetingId(meetingId: string): string | null {
  if (meetingId.length === 0) return "empty meetingId";
  if (meetingId.includes("..")) return "meetingId contains '..'";
  if (meetingId.includes("/")) return "meetingId contains '/'";
  if (meetingId.includes("\\")) return "meetingId contains '\\\\'";
  if (meetingId.includes("\0")) return "meetingId contains NUL byte";
  if (meetingId.startsWith(".")) return "meetingId begins with '.'";
  return null;
}

/** Resolve the export-root absolute path. Mirrors `resolveSocketPath` from
 *  `socket.ts` but with a different subdir layout. Pure — no fs I/O. */
export function resolveExportRoot(
  opts: { env?: Record<string, string | undefined>; homedir?: () => string } = {},
): string {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? homedir;

  const override = env.MCP_BRIDGE_HOME;
  if (override !== undefined && override !== "") {
    if (!override.startsWith("/")) {
      throw new ExportRootRejected(override, "not-absolute");
    }
    if (containsTraversal(override)) {
      throw new ExportRootRejected(override, "traversal");
    }
    return pathResolve(override, ...EXPORT_HOME_SUBDIR);
  }

  return pathResolve(home(), BRIDGE_HOME_DIRNAME, ...EXPORT_HOME_SUBDIR);
}

export class ExportRootRejected extends Error {
  readonly reason: "traversal" | "not-absolute";
  constructor(input: string, reason: ExportRootRejected["reason"]) {
    super(`MCP_BRIDGE_HOME rejected (${reason}): ${input.slice(0, 60)}`);
    this.name = "ExportRootRejected";
    this.reason = reason;
  }
}

function containsTraversal(input: string): boolean {
  if (input === "..") return true;
  if (input.includes("/..")) return true;
  if (input.includes("../")) return true;
  if (input.startsWith("..")) return true;
  if (input.endsWith("..")) return true;
  return false;
}

function defaultLoader(): SnapshotLoader {
  // Production wiring is deferred to Phase 4.x — see T-4.7 §7. Returning null
  // surfaces a typed `MeetingNotFound` envelope rather than a panic.
  return async () => null;
}

const DEFAULT_FS = {
  mkdir,
  writeFile,
  rename,
  stat,
  unlink,
} satisfies NonNullable<ExportHandlerDeps["fs"]>;

export async function handleExport(
  args: unknown,
  deps: ExportHandlerDeps = {},
): Promise<ToolResult> {
  const input = ExportInputSchema.parse(args);

  // 1. Path-traversal guard on `meetingId`. Must happen BEFORE any fs touch
  //    or loader invocation — defence in depth even though the loader is
  //    expected to validate ids itself.
  const idReason = checkMeetingId(input.meetingId);
  if (idReason !== null) {
    return errorResult("InvalidMeetingId", idReason);
  }

  // 2. Resolve the export root. Env override may be malformed → typed
  //    BridgeConfigInvalid (no fs I/O on the rejection path).
  let exportRoot: string;
  try {
    exportRoot =
      deps.exportRoot ??
      resolveExportRoot({ env: deps.env, homedir: deps.homedir });
  } catch (err) {
    if (err instanceof ExportRootRejected) {
      return errorResult("BridgeConfigInvalid", err.message);
    }
    throw err;
  }

  // 3. Load the snapshot. Loader returns null → MeetingNotFound.
  const loader = deps.loadSnapshot ?? defaultLoader();
  const snapshot = await loader(input.meetingId);
  if (snapshot == null) {
    return errorResult(
      "MeetingNotFound",
      `no meeting with id "${input.meetingId}"`,
    );
  }

  // 4. Render to the requested format.
  const render = RENDERERS[input.format];
  const rendered = render(snapshot);

  // 5. Atomic write: mkdir -p, writeFile(tmp), rename(tmp, final).
  const fs = deps.fs ?? DEFAULT_FS;
  await fs.mkdir(exportRoot, { recursive: true });
  const finalPath = pathResolve(
    exportRoot,
    `${input.meetingId}.${rendered.ext}`,
  );
  const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  await fs.writeFile(tmpPath, rendered.body, "utf8");
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the orphaned tmp file before bubbling the error.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // already gone, or permissions, or rename actually succeeded — either
      // way the rename's error is the one operators care about.
    }
    throw err;
  }

  // 6. sizeBytes — re-stat the final file rather than trust the body length
  //    (UTF-8 multibyte chars make `body.length` ≠ on-disk size).
  let sizeBytes: number;
  try {
    const stats = await fs.stat(finalPath);
    sizeBytes = stats.size;
  } catch {
    // Stat failed — fall back to a Buffer.byteLength so we still return a
    // non-zero number. This branch is unreachable in practice (rename
    // succeeded above) but keeps the type contract honest.
    sizeBytes = Buffer.byteLength(rendered.body, "utf8");
  }

  const payload: ExportOutput = {
    path: finalPath,
    sizeBytes,
  };
  const validated = ExportOutputSchema.parse(payload);

  return {
    content: [{ type: "text", text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated,
  };
}

// Re-export so tests can probe without importing from "node:fs" themselves.
export { existsSync as _existsSync };
