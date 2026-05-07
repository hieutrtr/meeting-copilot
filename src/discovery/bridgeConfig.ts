// Phase 4 T-4.8 — Discovery hook: read & auto-register in claude-bridge config.
//
// On MCP server boot, this module:
//
//   1. Resolves `$CLAUDE_BRIDGE_HOME` (default `~/.claude-bridge/`).
//   2. Reads `config.json` (or treats absent file as empty config).
//   3. Validates against `BridgeConfigSchema` (Zod, scoped slice).
//   4. Appends a `meeting_copilots[]` entry whose `path` matches our binary
//      iff one is not already present.
//   5. Atomic-writes back via `<config>.tmp.<pid>` → `renameSync(<config>)`.
//
// Mirrors `claude-bridge/src/lib/dashboard-installer.ts` lines 318–338
// (`readConfigJson` + `writeConfigJsonAtomic`). Discovery has NO MCP-protocol
// surface — it is a side-effect of `bin.ts` startup. Failure must never
// crash the server; bin.ts wraps the call in try/catch.
//
// Concurrency model: claude-bridge daemon and meeting-copilot are concurrent
// writers of the same JSON file but on disjoint keys (`dashboards` vs
// `meeting_copilots`). `passthrough()` on the schema preserves keys we don't
// own; atomic rename keeps each writer's payload internally consistent. Last
// writer wins on the disjoint key — acceptable since both writers produce
// idempotent payloads for their own key.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  BridgeConfigSchema,
  MeetingCopilotEntrySchema,
  SUPPORTED_CONFIG_VERSION,
  type BridgeConfig,
  type MeetingCopilotEntry,
} from "./schema";
import { ZodError } from "zod";

// --- Errors ---------------------------------------------------------------

export class ConfigSchemaUnsupportedError extends Error {
  readonly code = "ConfigSchemaUnsupported" as const;
  constructor(actualVersion: number) {
    super(
      `claude-bridge config.json schema version ${actualVersion} is newer than ` +
        `meeting-copilot understands (max ${SUPPORTED_CONFIG_VERSION}). ` +
        `Upgrade meeting-copilot before claude-bridge daemon.`,
    );
    this.name = "ConfigSchemaUnsupportedError";
  }
}

export class BridgeConfigInvalidError extends Error {
  readonly code = "BridgeConfigInvalid" as const;
  constructor(reason: string, public readonly cause?: unknown) {
    super(`bridge config.json is invalid: ${reason}`);
    this.name = "BridgeConfigInvalidError";
  }
}

// --- Deps (DI for tests) --------------------------------------------------

export interface DiscoveryDeps {
  /** Read a UTF-8 text file. Throw on ENOENT. Defaults to `fs.readFileSync`. */
  readFile?: (path: string) => string;
  /** Existence probe. Defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean;
  /** Atomic write — writer responsible for tmp file + rename. */
  writeFileAtomic?: (path: string, contents: string) => void;
  /** mkdir -p. Defaults to `fs.mkdirSync(path, { recursive: true })`. */
  mkdirp?: (path: string) => void;
  /** Override `os.homedir()` (tests). */
  homeDir?: () => string;
  /** Override `process.env.CLAUDE_BRIDGE_HOME`. `undefined` = unset. */
  bridgeHomeEnv?: string | undefined;
  /** Clock for `installed_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override `process.pid` for tmp-file naming (tests). */
  pid?: () => number;
}

// --- Public API -----------------------------------------------------------

/** Resolve the bridge-home directory. Honors `CLAUDE_BRIDGE_HOME` if absolute
 *  and free of `..` segments; else falls back to `~/.claude-bridge`.
 *
 *  Throws `BridgeConfigInvalidError` if the env override is non-absolute or
 *  contains traversal segments — per ARCH §16, "absolute paths only". */
export function resolveBridgeHome(deps: DiscoveryDeps = {}): string {
  // Presence of the key is the override signal (not its value): tests pass
  // `bridgeHomeEnv: undefined` to mean "explicitly no env override". If the
  // key isn't on the deps object at all, fall back to `process.env`.
  const env =
    "bridgeHomeEnv" in deps ? deps.bridgeHomeEnv : process.env.CLAUDE_BRIDGE_HOME;

  if (env != null && env.length > 0) {
    if (env.startsWith("~")) {
      throw new BridgeConfigInvalidError(
        `CLAUDE_BRIDGE_HOME must be an absolute path (got tilde-prefixed "${env}"). ` +
          `Per claude-bridge ARCH §16, paths are absolute — no tilde expansion.`,
      );
    }
    if (!isAbsolute(env)) {
      throw new BridgeConfigInvalidError(
        `CLAUDE_BRIDGE_HOME must be an absolute path (got "${env}").`,
      );
    }
    if (env.split(/[\\/]/).some((segment) => segment === "..")) {
      throw new BridgeConfigInvalidError(
        `CLAUDE_BRIDGE_HOME must not contain ".." segments (got "${env}").`,
      );
    }
    return env;
  }

  const home = (deps.homeDir ?? homedir)();
  return join(home, ".claude-bridge");
}

/** Resolve the absolute path to `config.json` under the bridge home. */
export function resolveConfigPath(deps: DiscoveryDeps = {}): string {
  return join(resolveBridgeHome(deps), "config.json");
}

/** Read & validate the bridge config. Returns the parsed shape with default
 *  `version: 1` and `meeting_copilots: []` when the file is absent.
 *
 *  Throws:
 *  - `ConfigSchemaUnsupportedError` if `config.version > 1`.
 *  - `BridgeConfigInvalidError` if JSON is corrupt or schema is violated.
 */
export function readBridgeConfig(deps: DiscoveryDeps = {}): BridgeConfig {
  const path = resolveConfigPath(deps);
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  if (!exists(path)) {
    return BridgeConfigSchema.parse({});
  }

  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    throw new BridgeConfigInvalidError(
      `read failed: ${(err as Error).message}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BridgeConfigInvalidError(
      `JSON parse failed: ${(err as Error).message}`,
      err,
    );
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeConfigInvalidError(
      `top-level must be an object (got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      })`,
    );
  }

  // Pre-flight version gate — Zod's `.min(1)` would fold v=0 and v=2 into one
  // BridgeConfigInvalid; we want a distinct ConfigSchemaUnsupported error for
  // forward-incompat v>1, and BridgeConfigInvalid for the "v=0 / not a number"
  // floor.
  const versionField = (parsed as Record<string, unknown>)["version"];
  if (typeof versionField === "number" && versionField > SUPPORTED_CONFIG_VERSION) {
    throw new ConfigSchemaUnsupportedError(versionField);
  }

  try {
    return BridgeConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BridgeConfigInvalidError(zodIssueDescription(err), err);
    }
    throw new BridgeConfigInvalidError(`schema validation failed`, err);
  }
}

// --- Register --------------------------------------------------------------

export interface RegisterOpts {
  /** Semver of the meeting-copilot binary registering itself. */
  version: string;
  /** Absolute path to the MCP bin (bin.ts shim or compiled). Tilde and
   *  relative paths are rejected — caller must pre-resolve. */
  binPath: string;
  /** Absolute path to the macOS `.app` bundle, when known. Tilde rejected. */
  appPath?: string;
  /** Provenance hint for `installed_from`. */
  installedFrom?: string;
}

export interface RegisterResult {
  configPath: string;
  alreadyRegistered: boolean;
  entry: MeetingCopilotEntry;
  warnings: string[];
}

/** Register meeting-copilot in `meeting_copilots[]`. Idempotent: if an entry
 *  with the same `path` already exists, returns `{alreadyRegistered: true}`
 *  WITHOUT writing the file. */
export function registerMeetingCopilot(
  opts: RegisterOpts,
  deps: DiscoveryDeps = {},
): RegisterResult {
  if (!opts.version || opts.version.trim().length === 0) {
    throw new BridgeConfigInvalidError("registerMeetingCopilot: version required");
  }
  // The persisted `path` is the .app bundle (when known) so the daemon can
  // reuse the same shape it does for `dashboards[].path`. Fallback to the
  // bin path so first-boot discovery still functions in dev.
  const rawPath = opts.appPath && opts.appPath.length > 0 ? opts.appPath : opts.binPath;
  const entryPath = rejectNonAbsolute(rawPath, "appPath/binPath");
  const binPath = rejectNonAbsolute(opts.binPath, "binPath");

  const config = readBridgeConfig(deps);

  const existing = (config.meeting_copilots ?? []).find((e) => e.path === entryPath);
  if (existing) {
    return {
      configPath: resolveConfigPath(deps),
      alreadyRegistered: true,
      entry: existing,
      warnings: [],
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const entry: MeetingCopilotEntry = MeetingCopilotEntrySchema.parse({
    version: opts.version,
    path: entryPath,
    default: false,
    installed_at: now.toISOString(),
    ...(opts.installedFrom ? { installed_from: opts.installedFrom } : {}),
    mcp_bin: binPath,
  });

  const next: BridgeConfig = {
    ...config,
    version: config.version ?? 1,
    meeting_copilots: [...(config.meeting_copilots ?? []), entry],
  };

  const configPath = resolveConfigPath(deps);
  const mkdirp =
    deps.mkdirp ?? ((p: string) => mkdirSync(p, { recursive: true }));
  mkdirp(dirname(configPath));

  const write =
    deps.writeFileAtomic ?? defaultWriteFileAtomic((deps.pid ?? (() => process.pid))());

  write(configPath, JSON.stringify(next, null, 2) + "\n");

  return {
    configPath,
    alreadyRegistered: false,
    entry,
    warnings: [],
  };
}

// --- Internals ------------------------------------------------------------

function rejectNonAbsolute(p: string | undefined, name: string): string {
  if (!p || p.length === 0) {
    throw new BridgeConfigInvalidError(`${name} required`);
  }
  if (p.startsWith("~")) {
    throw new BridgeConfigInvalidError(
      `${name} must be absolute (no tilde expansion); got "${p}"`,
    );
  }
  if (!isAbsolute(p)) {
    throw new BridgeConfigInvalidError(`${name} must be absolute; got "${p}"`);
  }
  // Use `path.resolve` to collapse benign segments like "/foo/./bar" but
  // reject any `..` traversal in the original since both daemons trust the
  // persisted value verbatim.
  if (p.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new BridgeConfigInvalidError(`${name} must not contain ".." (got "${p}")`);
  }
  return resolve(p);
}

function defaultWriteFileAtomic(pid: number): (path: string, contents: string) => void {
  return (path, contents) => {
    const tmp = `${path}.tmp.${pid}`;
    writeFileSync(tmp, contents, "utf8");
    renameSync(tmp, path);
  };
}

function zodIssueDescription(err: ZodError): string {
  const first = err.issues[0];
  if (!first) return "unknown schema violation";
  const pathStr = first.path.length > 0 ? first.path.join(".") : "<root>";
  return `${pathStr}: ${first.message}`;
}
