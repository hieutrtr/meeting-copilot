// Phase 4 T-4.10 — Unit coverage of the E2E fixture harness.
//
// The subprocess-driven E2E test (`tests/e2e/mcp-dispatch.e2e.test.ts`)
// asserts the JSON-RPC contract; this file asserts the fixture seam itself —
// fixture parsing, missing-field rejection, and per-handler routing through
// the production handler functions. Both layers stay independently regression-
// guardable: a fixture-loader bug shows up here, a JSON-RPC bug shows up in
// the E2E test.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  E2EFixtureInvalid,
  buildE2EHandlers,
  loadE2EFixture,
  type E2EFixture,
} from "./e2eHarness";
import { TOOL_NAMES, type ToolResult } from "./tools";
import type { ExporterMeetingSnapshot } from "./exporters/types";

const STARTED_AT = 1_700_000_000_000;

function makeSnapshot(): ExporterMeetingSnapshot {
  return {
    meeting: {
      id: "m_e2e",
      title: "E2E sync",
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 60_000,
      sttProvider: "mlx",
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
      status: "ended",
    },
    chunks: [
      {
        id: "c1",
        meetingId: "m_e2e",
        text: "the seeded transcript text",
        startTs: STARTED_AT + 1_000,
        endTs: STARTED_AT + 2_000,
        isFinal: true,
      },
    ],
    questions: [
      {
        id: "q1",
        meetingId: "m_e2e",
        text: "what is the seed question?",
        detectedTs: STARTED_AT + 1_500,
        method: "rule-based",
      },
    ],
    answer: {
      id: "a1",
      questionId: "q1",
      text: "this is the seed answer text",
      generatedAt: STARTED_AT + 1_800,
      model: "claude-sonnet-4-6",
      tokensIn: 1_000,
      tokensOut: 200,
      cachedRatio: 0.5,
    },
  };
}

function makeFixture(over: Partial<E2EFixture> = {}): E2EFixture {
  return {
    tmpdir: "/tmp/__t410_unit__",
    exportRoot: "/tmp/__t410_unit__/exports",
    ...over,
  };
}

function writeFixtureFile(workDir: string, fixture: E2EFixture): string {
  const path = pathResolve(workDir, "fixture.json");
  writeFileSync(path, JSON.stringify(fixture), "utf8");
  return path;
}

function decodeStructured<T>(result: ToolResult): T {
  if (result.isError) {
    throw new Error(
      `expected non-error result; got: ${result.content[0]?.text ?? "<no content>"}`,
    );
  }
  return result.structuredContent as T;
}

describe("e2eHarness — loadE2EFixture", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(`${tmpdir()}${sep}t410-unit-`);
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("parses a minimal valid fixture (tmpdir + exportRoot only)", () => {
    const fx = makeFixture();
    const path = writeFixtureFile(workDir, fx);
    const loaded = loadE2EFixture(path);
    expect(loaded.tmpdir).toBe(fx.tmpdir);
    expect(loaded.exportRoot).toBe(fx.exportRoot);
    expect(loaded.handshake).toBeUndefined();
    expect(loaded.statusReply).toBeUndefined();
  });

  it("preserves optional fields on round-trip", () => {
    const fx = makeFixture({
      appBundlePath: "/x/y.app",
      spawnLogPath: "/x/spawn.log",
      handshake: {
        meetingId: "m_e2e",
        pid: 1,
        rpcSocket: "/x/r.sock",
        uiUrl: "http://127.0.0.1:7411/embed/transcript/m_e2e?token=t",
      },
    });
    const path = writeFixtureFile(workDir, fx);
    const loaded = loadE2EFixture(path);
    expect(loaded.appBundlePath).toBe("/x/y.app");
    expect(loaded.spawnLogPath).toBe("/x/spawn.log");
    expect(loaded.handshake?.meetingId).toBe("m_e2e");
  });

  it("throws E2EFixtureInvalid on a missing file", () => {
    expect(() => loadE2EFixture(`${workDir}/nope.json`)).toThrow(
      E2EFixtureInvalid,
    );
  });

  it("throws E2EFixtureInvalid on non-JSON content", () => {
    const path = pathResolve(workDir, "bad.json");
    writeFileSync(path, "this is not json", "utf8");
    expect(() => loadE2EFixture(path)).toThrow(E2EFixtureInvalid);
  });

  it("throws E2EFixtureInvalid on a JSON array", () => {
    const path = pathResolve(workDir, "arr.json");
    writeFileSync(path, "[1,2,3]", "utf8");
    expect(() => loadE2EFixture(path)).toThrow(E2EFixtureInvalid);
  });

  it("throws E2EFixtureInvalid on missing tmpdir", () => {
    const path = pathResolve(workDir, "no-tmpdir.json");
    writeFileSync(path, JSON.stringify({ exportRoot: "/x" }), "utf8");
    expect(() => loadE2EFixture(path)).toThrow(/'tmpdir'/);
  });

  it("throws E2EFixtureInvalid on missing exportRoot", () => {
    const path = pathResolve(workDir, "no-export.json");
    writeFileSync(path, JSON.stringify({ tmpdir: "/x" }), "utf8");
    expect(() => loadE2EFixture(path)).toThrow(/'exportRoot'/);
  });
});

describe("e2eHarness — buildE2EHandlers shape", () => {
  it("returns a handler for every tool name in TOOL_NAMES", () => {
    const handlers = buildE2EHandlers(makeFixture());
    for (const name of TOOL_NAMES) {
      expect(handlers[name]).toBeTypeOf("function");
    }
  });

  it("the handler set has no extra keys beyond TOOL_NAMES", () => {
    const handlers = buildE2EHandlers(makeFixture());
    expect(Object.keys(handlers).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe("e2eHarness — install handler routing", () => {
  it("resolves bundle absence through fixture.appBundlePath", async () => {
    const fx = makeFixture({
      appBundlePath: "/var/empty/__t410_no_such_bundle__.app",
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_install({})) as ToolResult;
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"installed": false');
    expect(text).toContain("/var/empty/__t410_no_such_bundle__.app");
  });
});

describe("e2eHarness — start handler routing", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(`${tmpdir()}${sep}t410-start-`);
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("appends a JSON line to spawnLogPath on a valid start", async () => {
    const spawnLogPath = pathResolve(workDir, "spawn.log");
    const fx = makeFixture({
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      spawnLogPath,
      handshake: {
        meetingId: "m_e2e",
        pid: 42,
        rpcSocket: pathResolve(workDir, "rpc.sock"),
        uiUrl: "http://127.0.0.1:7411/embed/transcript/m_e2e?token=t",
      },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_start({
      contextPaths: [],
      sttProvider: "mlx",
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(spawnLogPath, "utf8");
    expect(log.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    const entry = JSON.parse(log.split("\n")[0]) as {
      cmd: string;
      args: string[];
    };
    expect(entry.cmd).toBe("open");
    expect(entry.args[0]).toMatch(/^meeting-copilot:\/\/start\?/);
  });

  it("returns the fixture handshake on the structured envelope", async () => {
    const fx = makeFixture({
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      handshake: {
        meetingId: "m_route",
        pid: 99,
        rpcSocket: pathResolve(workDir, "r.sock"),
        uiUrl: "http://127.0.0.1:7411/embed/transcript/m_route?token=t",
      },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_start({
      contextPaths: [],
      sttProvider: "mlx",
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
    })) as ToolResult;
    const out = decodeStructured<{ meetingId: string; pid: number }>(result);
    expect(out.meetingId).toBe("m_route");
    expect(out.pid).toBe(99);
  });

  it("PrivacyModeViolation gate fires even with the fixture-backed deps", async () => {
    const fx = makeFixture({
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      spawnLogPath: pathResolve(workDir, "spawn.log"),
      handshake: {
        meetingId: "m_e2e",
        pid: 1,
        rpcSocket: pathResolve(workDir, "r.sock"),
        uiUrl: "http://127.0.0.1:7411/embed/transcript/m_e2e?token=t",
      },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_start({
      contextPaths: [],
      sttProvider: "deepgram", // cloud STT under local-first → reject pre-spawn
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^PrivacyModeViolation:/);
    // Spawn log must remain absent (production gate fires before the harness
    // spawn closure is invoked).
    const { existsSync } = await import("node:fs");
    expect(existsSync(pathResolve(workDir, "spawn.log"))).toBe(false);
  });

  it("ContextNotFound gate fires for traversal in contextPaths", async () => {
    const fx = makeFixture({
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      spawnLogPath: pathResolve(workDir, "spawn.log"),
      handshake: {
        meetingId: "m_e2e",
        pid: 1,
        rpcSocket: pathResolve(workDir, "r.sock"),
        uiUrl: "http://127.0.0.1:7411/embed/transcript/m_e2e?token=t",
      },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_start({
      contextPaths: ["../etc/passwd"],
      sttProvider: "mlx",
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^ContextNotFound:/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(pathResolve(workDir, "spawn.log"))).toBe(false);
  });
});

describe("e2eHarness — status / stop routing", () => {
  it("status returns fixture.statusReply.meetings", async () => {
    const fx = makeFixture({
      statusReply: {
        meetings: [
          {
            id: "m_e2e",
            pid: 12,
            startedAt: STARTED_AT,
            sttProvider: "mlx",
            transcriptChunks: 4,
            questionCount: 1,
            answerCount: 1,
            uptimeSec: 30,
          },
        ],
      },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_status({})) as ToolResult;
    expect(result.isError).toBeFalsy();
    const out = decodeStructured<{ meetings: Array<{ id: string }> }>(result);
    expect(out.meetings.map((m) => m.id)).toEqual(["m_e2e"]);
  });

  it("status returns empty meetings array when fixture has no statusReply", async () => {
    const fx = makeFixture();
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_status({})) as ToolResult;
    expect(result.isError).toBeFalsy();
    const out = decodeStructured<{ meetings: unknown[] }>(result);
    expect(out.meetings).toHaveLength(0);
  });

  it("stop returns fixture.stopReply on the structured envelope", async () => {
    const fx = makeFixture({
      stopReply: { durationSec: 45, questionCount: 2 },
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_stop({
      meetingId: "m_e2e",
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const out = decodeStructured<{ durationSec: number; questionCount: number }>(
      result,
    );
    expect(out.durationSec).toBe(45);
    expect(out.questionCount).toBe(2);
  });

  it("stop returns MeetingNotFound when fixture has no stopReply", async () => {
    const fx = makeFixture();
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_stop({
      meetingId: "m_ghost",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
  });
});

describe("e2eHarness — export routing", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(`${tmpdir()}${sep}t410-export-`);
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("export reads from fixture.snapshot and writes to fixture.exportRoot", async () => {
    const fx: E2EFixture = {
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      snapshot: makeSnapshot(),
    };
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_export({
      meetingId: "m_e2e",
      format: "markdown",
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const out = decodeStructured<{ path: string; sizeBytes: number }>(result);
    expect(out.path).toBe(pathResolve(workDir, "exports", "m_e2e.md"));
    expect(out.sizeBytes).toBeGreaterThan(0);
    const { readFileSync } = await import("node:fs");
    const onDisk = readFileSync(out.path, "utf8");
    expect(onDisk).toContain("# E2E sync");
    expect(onDisk).toContain("the seeded transcript text");
    expect(onDisk).toContain("> Privacy mode: local-first");
  });

  it("export returns MeetingNotFound when snapshot is absent", async () => {
    const fx = makeFixture({
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
    });
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_export({
      meetingId: "m_e2e",
      format: "markdown",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
  });

  it("export returns MeetingNotFound when meetingId mismatches snapshot", async () => {
    const fx: E2EFixture = {
      tmpdir: workDir,
      exportRoot: pathResolve(workDir, "exports"),
      snapshot: makeSnapshot(),
    };
    const handlers = buildE2EHandlers(fx);
    const result = (await handlers.bridge_meeting_export({
      meetingId: "m_other",
      format: "markdown",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
  });
});
