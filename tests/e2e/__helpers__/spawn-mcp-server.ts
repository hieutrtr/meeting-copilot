// Phase 4 T-4.10 — E2E test helper.
//
// Spawns the production `meeting-copilot-mcp` binary as a child process and
// connects an MCP `Client` to it via the upstream `StdioClientTransport`. The
// fixture file path is passed through `MEETING_COPILOT_E2E_FIXTURE_PATH`,
// which the spawned bin uses to swap in fixture-backed handler deps. See
// `docs/tasks/phase-4/T-4.10-mcp-dispatch-e2e.md` for the full design.
//
// Each scenario in the e2e test creates a fresh tmpdir, writes a fixture JSON
// inside it, calls `spawnMcpServer({...})` to get a connected client, runs
// its assertions, and finally calls the returned `close()` to tear down both
// the child and the tmpdir.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import type { E2EFixture } from "../../../src/mcp/e2eHarness";

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));

/** Resolve an absolute path to the bin we want to spawn. We never rely on the
 *  child's cwd — using the absolute path keeps the spawn deterministic
 *  regardless of where vitest is invoked from. */
function resolveBinPath(): string {
  // From `tests/e2e/__helpers__/spawn-mcp-server.ts`, the bin lives at
  // `../../../src/mcp/bin.ts`. We do this relative to the test file's URL so
  // the path is correct under `bun run test`, `vitest`, or any other runner.
  return pathResolve(HELPER_DIR, "..", "..", "..", "src", "mcp", "bin.ts");
}

/** Choose a runtime to launch the bin. Vitest under bun is the default; if
 *  someone runs vitest under node we fall back to `bun` on PATH. The bin file
 *  has `#!/usr/bin/env bun` but we explicitly invoke bun to avoid relying on
 *  the shebang under macOS. */
function resolveRunner(): { command: string; runArgs: string[] } {
  // `process.execPath` under bun is the bun binary itself. Under node it's
  // node, which can't execute the .ts directly — but the typical T-4.10 run
  // is `bun test` so this is the happy path.
  const exec = process.execPath;
  if (/(^|\/)bun(\.exe)?$/.test(exec)) {
    return { command: exec, runArgs: ["run"] };
  }
  // Fallback: rely on `bun` being on PATH.
  return { command: "bun", runArgs: ["run"] };
}

export interface SpawnE2EOpts {
  fixture: E2EFixture;
  /** Optional client identity for the upstream `Client` constructor. */
  clientName?: string;
  clientVersion?: string;
}

export interface SpawnedE2E {
  client: Client;
  /** Absolute path to the per-scenario tmpdir owned by this spawn. Tests can
   *  read fixture-side artefacts (e.g. spawn.log) from here. */
  workDir: string;
  /** Tear down: close client + transport (which kills the child) + rm tmpdir. */
  close: () => Promise<void>;
}

/** Mint a per-scenario tmpdir, write the fixture JSON into it, spawn the bin,
 *  connect the client, and return both. The caller MUST call `close()` in a
 *  `finally` block. */
export async function spawnMcpServer(opts: SpawnE2EOpts): Promise<SpawnedE2E> {
  const workDir = mkdtempSync(`${tmpdir()}${sep}t410-e2e-`);
  // Mutate the fixture's tmpdir-derived paths to point inside this workDir.
  // Callers either pass an already-resolved fixture (built around a specific
  // workDir from the test) or rely on the helper to fill in `tmpdir` +
  // `exportRoot` if absent. We respect what the caller passed and only fill
  // gaps.
  const fixture: E2EFixture = {
    ...opts.fixture,
    tmpdir: opts.fixture.tmpdir || workDir,
    exportRoot:
      opts.fixture.exportRoot || pathResolve(workDir, "exports"),
  };
  const fixturePath = pathResolve(workDir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");

  const binPath = resolveBinPath();
  if (!existsSync(binPath)) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(`E2E bin not found at ${binPath}`);
  }

  const { command, runArgs } = resolveRunner();
  // Build the env. We deliberately do NOT spread process.env directly —
  // `MEETING_COPILOT_E2E_FIXTURE_PATH` is the only fixture knob and we want
  // the child to look at exactly the values we set here. SDK helper provides
  // a curated baseline (PATH, HOME, etc.) suitable for spawning processes.
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    MEETING_COPILOT_E2E_FIXTURE_PATH: fixturePath,
    // Belt-and-brace: pin discovery's home env to the workDir so even if the
    // E2E branch in bin.ts somehow fell through to discovery, the writes would
    // land inside the tmpdir (cleaned up by close()).
    CLAUDE_BRIDGE_HOME: workDir,
    MCP_BRIDGE_HOME: workDir,
  };

  const transport = new StdioClientTransport({
    command,
    args: [...runArgs, binPath],
    env,
    stderr: "pipe",
  });

  const client = new Client(
    {
      name: opts.clientName ?? "t410-e2e-client",
      version: opts.clientVersion ?? "0.0.0",
    },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    client,
    workDir,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best effort — child may already have exited
      }
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Read + JSON-parse the spawn log inside `workDir` if it exists; return [] if
 *  the file is absent (means no spawn was invoked — used by the privacy/context
 *  error scenarios). */
export function readSpawnLog(workDir: string): Array<{
  cmd: string;
  args: string[];
  ts: number;
}> {
  const path = pathResolve(workDir, "spawn.log");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { cmd: string; args: string[]; ts: number },
    );
}

/** Decode an MCP `tools/call` result's content[0].text as JSON; throws if
 *  the result was an error envelope. */
export function decodeToolResult<T>(result: unknown): T {
  const r = result as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r.isError) {
    throw new Error(
      `expected non-error tool result; got: ${
        r.content?.[0]?.text ?? "<no content>"
      }`,
    );
  }
  const text = r.content?.[0]?.text ?? "";
  return JSON.parse(text) as T;
}

/** Read the seed-meeting fixture from `tests/e2e/__fixtures__/`. */
export function loadSeedMeeting(): unknown {
  const path = pathResolve(
    HELPER_DIR,
    "..",
    "__fixtures__",
    "seed-meeting.json",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}
