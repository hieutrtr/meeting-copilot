// Phase 4 T-4.10 — Fixture-backed handler harness for the E2E test.
//
// Activated **only** when `MEETING_COPILOT_E2E_FIXTURE_PATH` is set on the
// MCP server's process env. Production callers never set the env var — the
// harness is dead code on the shipping path. See
// `docs/tasks/phase-4/T-4.10-mcp-dispatch-e2e.md` §3 for rationale.
//
// The harness builds a partial handler table that swaps each handler's DI
// seam (already exposed by T-4.3..T-4.7) with fixture-derived stubs. Crucially
// the **production handler code runs unchanged** — only the deps differ. This
// means privacy-mode gating, path-traversal guards, Zod parsing, and error-
// envelope shaping are all exercised end-to-end from the real subprocess; the
// fixture only intercepts the side-effecting boundaries (spawn, socket dial,
// snapshot load, fs export root).
//
// Fixture file shape (JSON, all paths absolute, no env interpolation):
//
//   {
//     "tmpdir":           "/tmp/.../t410-A",
//     "exportRoot":       "/tmp/.../exports",
//     "appBundlePath":    "/tmp/.../no-such-bundle.app",         // optional
//     "spawnLogPath":     "/tmp/.../spawn.log",                   // optional
//     "handshake":        { meetingId, pid, rpcSocket, uiUrl },   // optional
//     "statusReply":      { meetings: [...] },                    // optional
//     "stopReply":        { durationSec, questionCount, ... },    // optional
//     "snapshot":         ExporterMeetingSnapshot                  // optional
//   }
//
// All optional fields default to a typed-error path: e.g. `start` without a
// `handshake` returns the same `DeeplinkNotRegistered` envelope the production
// default poll surfaces.

import { appendFileSync, readFileSync } from "node:fs";

import type { ExporterMeetingSnapshot } from "./exporters/types";
import { handleExport } from "./handlers/export";
import { handleInstall } from "./handlers/install";
import { handleStart, type SpawnedChildLike } from "./handlers/start";
import { handleStatus } from "./handlers/status";
import { handleStop } from "./handlers/stop";
import type { Handler } from "./server";
import { TOOL_NAMES, type ToolName } from "./tools";

export interface E2EFixtureHandshake {
  meetingId: string;
  pid: number;
  rpcSocket: string;
  uiUrl: string;
}

export interface E2EFixtureStatusMeeting {
  id: string;
  pid: number;
  startedAt: number;
  sttProvider: string;
  transcriptChunks: number;
  questionCount: number;
  answerCount: number;
  uptimeSec: number;
}

export interface E2EFixtureStatusReply {
  meetings: E2EFixtureStatusMeeting[];
}

export interface E2EFixtureStopReply {
  durationSec: number;
  questionCount: number;
  exportedPath?: string;
}

export interface E2EFixture {
  /** Per-scenario tmpdir. Used as the resolved-home for socket / discovery
   *  resolvers so we never touch the real `$HOME`. */
  tmpdir: string;
  /** Absolute path under which `bridge_meeting_export` writes its output. */
  exportRoot: string;
  /** Absolute path of an .app bundle. Pointed at a non-existent dir for the
   *  install-check missing-app scenario; pointed at a real bundle (test
   *  Info.plist fixture) for an "installed" scenario (not yet exercised by
   *  T-4.10's test cases — the install handler's own unit tests cover that). */
  appBundlePath?: string;
  /** Absolute path of a file the start handler appends one JSON line to per
   *  spawn invocation. Existence + content is what the E2E test asserts to
   *  prove the deeplink builder ran end-to-end. */
  spawnLogPath?: string;
  handshake?: E2EFixtureHandshake;
  statusReply?: E2EFixtureStatusReply;
  stopReply?: E2EFixtureStopReply;
  snapshot?: ExporterMeetingSnapshot;
}

/** Thrown when the fixture file is malformed. The MCP server bin catches and
 *  exits non-zero — operators (i.e. the test harness writer) need a loud,
 *  actionable failure rather than a silent fallback to defaults. */
export class E2EFixtureInvalid extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "E2EFixtureInvalid";
    this.cause = cause;
  }
}

/** Read + validate a fixture JSON file. Synchronous because it runs once at
 *  bin.ts boot before any JSON-RPC traffic flows. */
export function loadE2EFixture(path: string): E2EFixture {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new E2EFixtureInvalid(
      `failed to read E2E fixture at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new E2EFixtureInvalid(
      `E2E fixture at ${path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new E2EFixtureInvalid(
      `E2E fixture at ${path} must be a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const tmpdir = obj.tmpdir;
  const exportRoot = obj.exportRoot;
  if (typeof tmpdir !== "string" || tmpdir.length === 0) {
    throw new E2EFixtureInvalid(
      `E2E fixture missing required string field 'tmpdir'`,
    );
  }
  if (typeof exportRoot !== "string" || exportRoot.length === 0) {
    throw new E2EFixtureInvalid(
      `E2E fixture missing required string field 'exportRoot'`,
    );
  }
  // Optional fields are passed through as-is; the handler code below is the
  // authoritative validator (Zod on the input, our own checkMeetingId on the
  // export id, etc.). Keeping the fixture-loader narrow keeps it loud only on
  // the operator's mistakes (typo'd JSON, missing tmpdir).
  return obj as unknown as E2EFixture;
}

/** Build a handler table mapping each tool name to a fixture-backed handler.
 *  The production handler functions run unchanged; only the DI deps differ. */
export function buildE2EHandlers(
  fixture: E2EFixture,
): Record<ToolName, Handler> {
  const handlers: Record<ToolName, Handler> = {
    bridge_meeting_install: (args) =>
      handleInstall(args, {
        appBundlePath: fixture.appBundlePath,
      }),

    bridge_meeting_start: (args) =>
      handleStart(args, {
        spawn: (cmd, sArgs) => {
          if (fixture.spawnLogPath) {
            const line = JSON.stringify({
              cmd,
              args: [...sArgs],
              ts: Date.now(),
            });
            appendFileSync(fixture.spawnLogPath, `${line}\n`, "utf8");
          }
          // Production-equivalent shape: returns a stub child whose `unref`
          // is a no-op. The handler doesn't await anything on it.
          const child: SpawnedChildLike = { unref: () => undefined };
          return child;
        },
        pollHandshake: async () => {
          if (!fixture.handshake) {
            throw new Error(
              "E2E fixture has no `handshake` — the start handler will surface DeeplinkNotRegistered. This is expected for tests that exercise the missing-handshake path.",
            );
          }
          return fixture.handshake;
        },
      }),

    bridge_meeting_status: (args) =>
      handleStatus(args, {
        // Pin the homedir to the fixture's tmpdir so the resolver never touches
        // real `$HOME`; pin env to `{}` so `MCP_BRIDGE_HOME` from the parent
        // shell can't redirect the resolver.
        resolveSocketPathOpts: { env: {}, homedir: () => fixture.tmpdir },
        dialSocket: async () => {
          if (!fixture.statusReply) {
            return { meetings: [] };
          }
          return fixture.statusReply;
        },
      }),

    bridge_meeting_stop: (args) =>
      handleStop(args, {
        resolveSocketPathOpts: { env: {}, homedir: () => fixture.tmpdir },
        dialSocket: async () => {
          if (!fixture.stopReply) {
            return {
              error: {
                code: "DaemonMeetingNotFound",
                message: "no fixture stopReply configured",
              },
            };
          }
          return fixture.stopReply;
        },
      }),

    bridge_meeting_export: (args) =>
      handleExport(args, {
        exportRoot: fixture.exportRoot,
        loadSnapshot: async (id) => {
          if (!fixture.snapshot) return null;
          if (fixture.snapshot.meeting.id !== id) return null;
          return fixture.snapshot;
        },
      }),
  };

  // Defence-in-depth: assert the table covers every tool. If a future tool
  // lands in TOOL_NAMES without a fixture wiring, the boot fails loudly here
  // rather than at first JSON-RPC call.
  for (const name of TOOL_NAMES) {
    if (!(name in handlers)) {
      throw new E2EFixtureInvalid(
        `E2E harness missing handler for tool '${name}' (TOOL_NAMES drift)`,
      );
    }
  }
  return handlers;
}
