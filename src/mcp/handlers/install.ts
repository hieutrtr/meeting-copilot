// Phase 4 T-4.3 — `bridge_meeting_install` handler.
//
// Read-only probe: locates a macOS `.app` bundle, parses the version out of
// its Info.plist, and reports the result against the MCP server's own
// `package.json#version` (the canonical "expected" version). Never mutates
// the filesystem; never spawns a subprocess. GitHub-release auto-download is
// deferred to Phase 4.x per `docs/tasks/phase-4/T-4.1-integration-design.md`
// §4 ("install row — Read-only in Phase 4").
//
// Three output states (see T-4.3 §4.3 design table):
//   1. Bundle absent           → installed: false, downloadUrl, message ("Install from …")
//   2. Bundle present + parses → installed: true, version, expectedVersion
//   3. Bundle present + plist  → installed: true, expectedVersion, downloadUrl
//      malformed                  message ("malformed Info.plist — Reinstall from …")
//
// All three validate against `InstallOutputSchema` (Zod) before returning.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseInfoPlistVersion } from "../install/infoPlist";
import {
  InstallInputSchema,
  InstallOutputSchema,
  type InstallOutput,
  type ToolResult,
} from "../tools";

// Public defaults — overridable per-call via deps for tests, and per-request
// via the `path` arg for callers who installed to a custom location.
export const DEFAULT_APP_BUNDLE_PATH = "/Applications/Meeting Copilot.app";
export const DEFAULT_DOWNLOAD_URL =
  "https://github.com/anthropic/meeting-copilot/releases/latest";

const INFO_PLIST_RELATIVE = "Contents/Info.plist";

export interface InstallHandlerDeps {
  /** Read a file as UTF-8 text. Returns `null` if the path does not exist or
   *  is not readable — the handler treats both cases as "bundle absent". */
  readFile?: (absolutePath: string) => string | null;
  /** Override the MCP server's reported `expectedVersion`. Tests set this to
   *  a fixed string; production reads `package.json#version`. */
  packageVersion?: string;
  /** Override the default `/Applications/Meeting Copilot.app` location. The
   *  request's `args.path` takes precedence over this if provided. */
  appBundlePath?: string;
  /** Override the default GitHub download URL. */
  downloadUrl?: string;
}

function defaultReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    // Permission errors, EISDIR, etc. — treat as "not readable", surface as
    // bundle-absent. We never throw out of the handler on probe failure.
    return null;
  }
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/mcp/handlers → up three = repo root.
    const pkgPath = resolve(here, "..", "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function handleInstall(
  args: unknown,
  deps: InstallHandlerDeps = {},
): Promise<ToolResult> {
  // Strict Zod parse: unknown keys / wrong types raise — server.ts catches and
  // converts to an isError envelope (no panic out of the dispatcher).
  const input = InstallInputSchema.parse(args);

  const expectedVersion = deps.packageVersion ?? readPackageVersion();
  const appBundlePath =
    input.path ?? deps.appBundlePath ?? DEFAULT_APP_BUNDLE_PATH;
  const downloadUrl = deps.downloadUrl ?? DEFAULT_DOWNLOAD_URL;
  const readFile = deps.readFile ?? defaultReadFile;

  const plistPath = resolve(appBundlePath, INFO_PLIST_RELATIVE);
  const plistContent = readFile(plistPath);

  let payload: InstallOutput;

  if (plistContent == null) {
    payload = {
      installed: false,
      expectedVersion,
      downloadUrl,
      message: `Meeting Copilot.app not found at ${appBundlePath}. Install from ${downloadUrl}`,
    };
  } else {
    const version = parseInfoPlistVersion(plistContent);
    if (version == null) {
      payload = {
        installed: true,
        expectedVersion,
        downloadUrl,
        message:
          `Meeting Copilot.app at ${appBundlePath} has a malformed Info.plist ` +
          `(no CFBundleShortVersionString). Reinstall from ${downloadUrl}`,
      };
    } else {
      const matches = version === expectedVersion;
      payload = {
        installed: true,
        version,
        expectedVersion,
        message: matches
          ? `Meeting Copilot.app v${version} is installed at ${appBundlePath} and matches expectedVersion ${expectedVersion}.`
          : `Meeting Copilot.app v${version} is installed at ${appBundlePath}; expectedVersion is ${expectedVersion}. Bundle may need an upgrade — ${downloadUrl}.`,
      };
    }
  }

  // Defense-in-depth: re-parse our own envelope through the output schema
  // before returning. Any drift between handler and schema fails the parse,
  // which T-4.2's dispatcher converts into an isError envelope rather than
  // letting a malformed payload escape on the wire.
  const validated = InstallOutputSchema.parse(payload);

  return {
    content: [{ type: "text", text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated,
  };
}
