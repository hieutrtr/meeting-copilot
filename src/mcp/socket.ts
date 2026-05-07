// Phase 4 T-4.5 — Helper-daemon Unix-domain socket client.
//
// Two responsibilities, both pure and side-effect free at module-load:
//   1. `resolveSocketPath` — derive an absolute socket path from the
//      `MCP_BRIDGE_HOME` env override or the user's home directory. Rejects
//      path-traversal (`..` segments) and non-absolute inputs. Tilde is **not**
//      expanded — per claude-bridge dashboard ARCH §16, env values must be
//      absolute paths.
//   2. `dialSocket` — single-shot line-delimited JSON dial: open, write one
//      line, read one line, close. Carries connect + response timeouts so the
//      MCP handler never hangs on a missing or stuck daemon.
//
// T-4.6 (`bridge_meeting_stop`) reuses both functions verbatim. T-4.9
// (subscribe / SSE) will need a long-lived dial; that lands as a separate
// helper, not via mutation of `dialSocket`.

import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

/** Default basename for the helper-daemon RPC socket file. The directory part
 *  is whichever home directory the daemon runs against — overridable via
 *  `MCP_BRIDGE_HOME`. Mirrors the daemon-side hardcoded basename in
 *  `crates/helper-daemon/src/mcp_rpc.rs`. */
export const SOCKET_FILENAME = "meeting-copilot.sock" as const;

/** Subdirectory under the resolved home for the socket file. Matches the
 *  claude-bridge daemon convention (`~/.claude-bridge/<artifact>`). */
export const SOCKET_HOME_DIRNAME = ".claude-bridge" as const;

export interface ResolveSocketPathOpts {
  /** Override `process.env` lookup — tests inject a synthetic env object. */
  env?: Record<string, string | undefined>;
  /** Override `os.homedir()` — tests inject a fixed string. */
  homedir?: () => string;
}

/** Thrown by `resolveSocketPath` when the env override is malformed; the
 *  handler maps this to a typed `BridgeConfigInvalid` envelope. The `reason`
 *  field lets the caller render a precise message without re-parsing. */
export class SocketPathRejected extends Error {
  readonly reason: "traversal" | "not-absolute" | "empty";
  readonly input: string;

  constructor(input: string, reason: SocketPathRejected["reason"]) {
    super(`MCP_BRIDGE_HOME rejected (${reason}): ${truncate(input)}`);
    this.name = "SocketPathRejected";
    this.input = input;
    this.reason = reason;
  }
}

function truncate(s: string): string {
  if (s.length <= 64) return s;
  return `${s.slice(0, 60)}…`;
}

/**
 * Compute the helper-daemon RPC socket path. Pure function — no fs I/O.
 *
 * Order of precedence:
 *   1. `MCP_BRIDGE_HOME` env value, if set. Must be an absolute path
 *      (`/`-rooted) with no `..` segments. Tilde is **not** expanded.
 *   2. `<homedir>/.claude-bridge/`.
 *
 * The socket basename `meeting-copilot.sock` is appended to the resolved
 * directory.
 */
export function resolveSocketPath(opts: ResolveSocketPathOpts = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? homedir;

  const override = env.MCP_BRIDGE_HOME;
  // Empty string is operator error but maps to "unset" semantics: many shells
  // strip empty env vars to undefined anyway, so treating "" as a soft fall-
  // through to the homedir keeps behaviour predictable across environments.
  if (override !== undefined && override !== "") {
    if (!override.startsWith("/")) {
      throw new SocketPathRejected(override, "not-absolute");
    }
    if (containsTraversal(override)) {
      throw new SocketPathRejected(override, "traversal");
    }
    return pathResolve(override, SOCKET_FILENAME);
  }

  return pathResolve(home(), SOCKET_HOME_DIRNAME, SOCKET_FILENAME);
}

/** True if `input` contains a `..` path segment (between separators or at the
 *  start/end). Matches the daemon-side guard. We check the raw string rather
 *  than splitting on platform separators because the env value is a POSIX
 *  path; a Windows-style backslash would already be rejected by the
 *  `not-absolute` gate. */
function containsTraversal(input: string): boolean {
  // Catch standalone `..`, `..` at boundaries, and embedded `..` segments.
  if (input === "..") return true;
  if (input.includes("/..")) return true;
  if (input.includes("../")) return true;
  if (input.startsWith("..")) return true;
  if (input.endsWith("..")) return true;
  return false;
}

// --- dialSocket -----------------------------------------------------------

/** Subset of `net.Socket` we touch — lets tests stub without the full Socket
 *  surface. */
export interface DialSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  write(data: string): unknown;
  end(): unknown;
  destroy(err?: Error): unknown;
  setEncoding(enc: "utf8"): unknown;
  setNoDelay?: (b: boolean) => unknown;
}

export type CreateConnectionFn = (path: string) => DialSocketLike;

export interface DialSocketOpts {
  /** Override the connection factory — tests inject an in-memory Duplex pair. */
  createConnection?: CreateConnectionFn;
  /** Connection deadline in ms (default 200). Once the connection is
   *  established we switch to `responseTimeoutMs`. */
  connectTimeoutMs?: number;
  /** Response deadline in ms (default 1000). Counted from `connect`. */
  responseTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 200;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1000;

function defaultCreateConnection(path: string): DialSocketLike {
  // The Node `Socket` returned by `createConnection` already implements all
  // of `DialSocketLike`'s members; we cast through `unknown` to avoid the TS
  // `Buffer | string` callback variance complaint.
  return createConnection(path) as unknown as DialSocketLike;
}

/**
 * Dial the helper-daemon socket, write one line of JSON, await one line of
 * JSON in response, return the parsed JSON object. Closes the connection
 * before returning (or on any error path).
 *
 * Wire framing is line-delimited JSON — the daemon side enforces `\n` as the
 * record terminator. We tolerate either a `\n` ending or a stream close after
 * a single complete object (rare, but cheaper than enforcing on the daemon).
 */
export async function dialSocket(
  socketPath: string,
  request: Record<string, unknown>,
  opts: DialSocketOpts = {},
): Promise<unknown> {
  const connectFn = opts.createConnection ?? defaultCreateConnection;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const responseTimeoutMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

  return new Promise((resolveP, rejectP) => {
    let settled = false;
    let buffer = "";
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;

    const sock = connectFn(socketPath);

    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      try {
        sock.end();
      } catch {
        // ignore double-end
      }
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      if (err) rejectP(err);
      else resolveP(value);
    };

    connectTimer = setTimeout(() => {
      finish(new Error(`socket connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    sock.setEncoding?.("utf8");

    sock.on("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    sock.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        const parsed = JSON.parse(line);
        finish(null, parsed);
      } catch (err) {
        finish(
          err instanceof Error
            ? err
            : new Error(`malformed JSON line from daemon: ${String(err)}`),
        );
      }
    });

    sock.on("end", () => {
      // Stream closed — if we never saw a newline, try to parse whatever
      // landed (handles a daemon that closes after a single complete object).
      if (settled) return;
      const trimmed = buffer.trim();
      if (trimmed.length === 0) {
        finish(new Error("daemon closed connection with no response"));
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        finish(null, parsed);
      } catch (err) {
        finish(
          err instanceof Error
            ? err
            : new Error(`malformed JSON from daemon: ${String(err)}`),
        );
      }
    });

    sock.on("connect", () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      responseTimer = setTimeout(() => {
        finish(
          new Error(`socket response timed out after ${responseTimeoutMs}ms`),
        );
      }, responseTimeoutMs);
      try {
        sock.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Type-only re-export of the underlying Node `Socket` for callers who need it
 *  (T-4.6 stop, T-4.9 subscribe). */
export type { Socket };
