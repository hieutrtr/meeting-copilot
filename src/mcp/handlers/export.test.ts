// Phase 4 T-4.7 — handleExport unit tests.
//
// Focus: handler-level orchestration (validate → traversal-guard → load →
// render → atomic write → re-parse). Format renderers are exhaustively
// covered in `src/mcp/exporters/*.test.ts`; here we use mocked `fs` so the
// tests never touch a real filesystem outside the OS tmpdir.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as pathResolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExporterMeetingSnapshot } from "../exporters/types";
import { ExportOutputSchema } from "../tools";
import {
  EXPORT_HOME_SUBDIR,
  checkMeetingId,
  handleExport,
  resolveExportRoot,
  type ExportHandlerDeps,
} from "./export";

const STARTED_AT = 1_700_000_000_000;

function fixtureSnapshot(id = "m_42"): ExporterMeetingSnapshot {
  return {
    meeting: {
      id,
      title: "Roadmap sync",
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 600_000,
      sttProvider: "mlx",
      model: "claude-sonnet-4-6",
      privacyMode: "local-first",
      status: "ended",
    },
    chunks: [
      {
        id: "c1",
        meetingId: id,
        text: "first utterance",
        startTs: STARTED_AT + 1_000,
        endTs: STARTED_AT + 2_500,
        isFinal: true,
        speaker: "self",
      },
    ],
    questions: [
      {
        id: "q1",
        meetingId: id,
        text: "What is the projected ARR by Q4?",
        detectedTs: STARTED_AT + 4_000,
        method: "auto",
      },
    ],
    answer: {
      id: "a1",
      questionId: "q1",
      text: "$4.2M.",
      generatedAt: STARTED_AT + 4_500,
      model: "claude-sonnet-4-6",
      tokensIn: 1_000,
      tokensOut: 16,
      cachedRatio: 0.9,
    },
  };
}

describe("checkMeetingId — path traversal guard (T-4.7)", () => {
  it("accepts a normal meetingId", () => {
    expect(checkMeetingId("m_42")).toBeNull();
    expect(checkMeetingId("meeting-2026-05-07")).toBeNull();
    expect(checkMeetingId("01J123ABC")).toBeNull();
  });

  it("rejects '..' substring", () => {
    expect(checkMeetingId("..")).not.toBeNull();
    expect(checkMeetingId("../etc/passwd")).not.toBeNull();
    expect(checkMeetingId("a..b")).not.toBeNull();
  });

  it("rejects forward-slash", () => {
    expect(checkMeetingId("a/b")).not.toBeNull();
    expect(checkMeetingId("/etc/passwd")).not.toBeNull();
  });

  it("rejects backslash", () => {
    expect(checkMeetingId("a\\b")).not.toBeNull();
  });

  it("rejects NUL byte", () => {
    expect(checkMeetingId("foo\0bar")).not.toBeNull();
  });

  it("rejects empty string", () => {
    expect(checkMeetingId("")).not.toBeNull();
  });

  it("rejects ids beginning with '.'", () => {
    expect(checkMeetingId(".hidden")).not.toBeNull();
  });
});

describe("resolveExportRoot — path resolution (T-4.7)", () => {
  it("defaults to <home>/.claude-bridge/meeting-copilot/exports", () => {
    const root = resolveExportRoot({
      env: {},
      homedir: () => "/tmp/h",
    });
    expect(root).toBe(
      pathResolve("/tmp/h/.claude-bridge", ...EXPORT_HOME_SUBDIR),
    );
  });

  it("uses MCP_BRIDGE_HOME when set to an absolute path", () => {
    const root = resolveExportRoot({
      env: { MCP_BRIDGE_HOME: "/var/run/bridge" },
      homedir: () => "/never",
    });
    expect(root).toBe(
      pathResolve("/var/run/bridge", ...EXPORT_HOME_SUBDIR),
    );
  });

  it("rejects MCP_BRIDGE_HOME with '..' traversal", () => {
    expect(() =>
      resolveExportRoot({
        env: { MCP_BRIDGE_HOME: "/tmp/../etc" },
        homedir: () => "/u",
      }),
    ).toThrow(/traversal/);
  });

  it("rejects MCP_BRIDGE_HOME with non-absolute value", () => {
    expect(() =>
      resolveExportRoot({
        env: { MCP_BRIDGE_HOME: "~/bridge" },
        homedir: () => "/u",
      }),
    ).toThrow(/not-absolute/);
  });
});

describe("handleExport — happy path (T-4.7)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(`${tmpdir()}${sep}t47-export-`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function deps(loader: ExportHandlerDeps["loadSnapshot"]): ExportHandlerDeps {
    return { exportRoot: tmp, loadSnapshot: loader };
  }

  it("writes a markdown file and returns {path, sizeBytes}", async () => {
    const result = await handleExport(
      { meetingId: "m_42", format: "markdown" },
      deps(async () => fixtureSnapshot()),
    );
    expect(result.isError).toBeFalsy();
    const parsed = ExportOutputSchema.parse(result.structuredContent);
    expect(parsed.path).toBe(pathResolve(tmp, "m_42.md"));
    const onDisk = readFileSync(parsed.path, "utf8");
    expect(onDisk).toContain("# Roadmap sync");
    expect(onDisk).toContain("> Privacy mode: local-first");
    expect(parsed.sizeBytes).toBe(Buffer.byteLength(onDisk, "utf8"));
    expect(parsed.sizeBytes).toBeGreaterThan(0);
  });

  it("writes a json file that round-trips through JSON.parse", async () => {
    const result = await handleExport(
      { meetingId: "m_42", format: "json" },
      deps(async () => fixtureSnapshot()),
    );
    expect(result.isError).toBeFalsy();
    const parsed = ExportOutputSchema.parse(result.structuredContent);
    expect(parsed.path).toBe(pathResolve(tmp, "m_42.json"));
    const onDisk = readFileSync(parsed.path, "utf8");
    const obj = JSON.parse(onDisk) as ExporterMeetingSnapshot;
    expect(obj.meeting.id).toBe("m_42");
    expect(obj.questions).toHaveLength(1);
    expect(obj.answer?.id).toBe("a1");
  });

  it("writes a vtt file with a WEBVTT header and valid cues", async () => {
    const result = await handleExport(
      { meetingId: "m_42", format: "vtt" },
      deps(async () => fixtureSnapshot()),
    );
    expect(result.isError).toBeFalsy();
    const parsed = ExportOutputSchema.parse(result.structuredContent);
    expect(parsed.path).toBe(pathResolve(tmp, "m_42.vtt"));
    const onDisk = readFileSync(parsed.path, "utf8");
    expect(onDisk.split("\n")[0]).toBe("WEBVTT");
    expect(onDisk).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/m,
    );
  });

  it("writes an srt file with a 1-indexed cue and comma timestamps", async () => {
    const result = await handleExport(
      { meetingId: "m_42", format: "srt" },
      deps(async () => fixtureSnapshot()),
    );
    expect(result.isError).toBeFalsy();
    const parsed = ExportOutputSchema.parse(result.structuredContent);
    expect(parsed.path).toBe(pathResolve(tmp, "m_42.srt"));
    const onDisk = readFileSync(parsed.path, "utf8");
    expect(onDisk.startsWith("1\n")).toBe(true);
    expect(onDisk).toMatch(
      /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/m,
    );
  });

  it("creates the export root directory if missing (recursive mkdir)", async () => {
    const nested = pathResolve(tmp, "deeply", "nested", "exports");
    const result = await handleExport(
      { meetingId: "m_42", format: "markdown" },
      { exportRoot: nested, loadSnapshot: async () => fixtureSnapshot() },
    );
    expect(result.isError).toBeFalsy();
    const parsed = ExportOutputSchema.parse(result.structuredContent);
    expect(parsed.path).toBe(pathResolve(nested, "m_42.md"));
    expect(readFileSync(parsed.path, "utf8")).toContain("# Roadmap sync");
  });
});

describe("handleExport — InvalidMeetingId (T-4.7)", () => {
  it.each([
    ["..", ".."],
    ["../etc/passwd", "traversal vector"],
    ["m/../foo", "embedded traversal"],
    ["a/b", "forward slash"],
    ["a\\b", "backslash"],
    ["m\0null", "NUL byte"],
    [".hidden", "leading dot"],
  ])(
    "rejects %s (%s) without touching fs or loader",
    async (meetingId, _label) => {
      const loader = vi.fn(async () => fixtureSnapshot());
      const fsSpy = {
        mkdir: vi.fn(mkdir),
        writeFile: vi.fn(writeFile),
        rename: vi.fn(rename),
        stat: vi.fn(stat),
        unlink: vi.fn(unlink),
      } as unknown as NonNullable<ExportHandlerDeps["fs"]>;
      const result = await handleExport(
        { meetingId, format: "markdown" },
        {
          exportRoot: "/tmp/should-not-be-touched",
          loadSnapshot: loader,
          fs: fsSpy,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^InvalidMeetingId:/);
      expect(loader).not.toHaveBeenCalled();
      expect(fsSpy.mkdir).not.toHaveBeenCalled();
      expect(fsSpy.writeFile).not.toHaveBeenCalled();
      expect(fsSpy.rename).not.toHaveBeenCalled();
    },
  );
});

describe("handleExport — MeetingNotFound (T-4.7)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(`${tmpdir()}${sep}t47-mnf-`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns MeetingNotFound when loader returns null", async () => {
    const result = await handleExport(
      { meetingId: "m_ghost", format: "markdown" },
      { exportRoot: tmp, loadSnapshot: async () => null },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
    expect(result.content[0]?.text).toContain("m_ghost");
  });

  it("does not write any file when meeting is missing", async () => {
    const fsSpy = {
      mkdir: vi.fn(mkdir),
      writeFile: vi.fn(writeFile),
      rename: vi.fn(rename),
      stat: vi.fn(stat),
      unlink: vi.fn(unlink),
    } as unknown as NonNullable<ExportHandlerDeps["fs"]>;
    await handleExport(
      { meetingId: "m_ghost", format: "json" },
      {
        exportRoot: tmp,
        loadSnapshot: async () => null,
        fs: fsSpy,
      },
    );
    expect(fsSpy.writeFile).not.toHaveBeenCalled();
    expect(fsSpy.rename).not.toHaveBeenCalled();
  });
});

describe("handleExport — env override (T-4.7)", () => {
  it("rejects MCP_BRIDGE_HOME traversal as BridgeConfigInvalid", async () => {
    const loader = vi.fn(async () => fixtureSnapshot());
    const result = await handleExport(
      { meetingId: "m_42", format: "markdown" },
      {
        env: { MCP_BRIDGE_HOME: "/tmp/../etc" },
        homedir: () => "/u",
        loadSnapshot: loader,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^BridgeConfigInvalid:/);
    expect(result.content[0]?.text).toContain("traversal");
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects MCP_BRIDGE_HOME non-absolute as BridgeConfigInvalid", async () => {
    const loader = vi.fn(async () => fixtureSnapshot());
    const result = await handleExport(
      { meetingId: "m_42", format: "markdown" },
      {
        env: { MCP_BRIDGE_HOME: "~/bridge" },
        homedir: () => "/u",
        loadSnapshot: loader,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^BridgeConfigInvalid:/);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("handleExport — atomic write (T-4.7)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(`${tmpdir()}${sep}t47-atomic-`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rename failure unlinks the tmp file and re-throws", async () => {
    const realFs = {
      mkdir,
      writeFile,
      rename,
      stat,
      unlink,
    };
    const failingFs = {
      ...realFs,
      rename: vi.fn(async () => {
        throw new Error("EACCES rename");
      }),
      unlink: vi.fn(realFs.unlink),
    };
    await expect(
      handleExport(
        { meetingId: "m_42", format: "markdown" },
        {
          exportRoot: tmp,
          loadSnapshot: async () => fixtureSnapshot(),
          fs: failingFs,
        },
      ),
    ).rejects.toThrow(/EACCES/);
    // The final file MUST NOT exist. The unlink call took care of the tmp.
    expect(() => readFileSync(pathResolve(tmp, "m_42.md"))).toThrow();
    expect(failingFs.unlink).toHaveBeenCalledTimes(1);
  });

  it("uses a tmp filename with pid + random suffix", async () => {
    let observedTmpPath: string | null = null;
    const fsCapture = {
      mkdir,
      writeFile: vi.fn(async (p: Parameters<typeof writeFile>[0], ...rest: unknown[]) => {
        observedTmpPath = String(p);
        return await writeFile(
          p,
          ...(rest as [string, { encoding?: "utf8" }]),
        );
      }) as unknown as typeof writeFile,
      rename,
      stat,
      unlink,
    };
    await handleExport(
      { meetingId: "m_42", format: "markdown" },
      {
        exportRoot: tmp,
        loadSnapshot: async () => fixtureSnapshot(),
        fs: fsCapture,
      },
    );
    expect(observedTmpPath).not.toBeNull();
    expect(observedTmpPath).toMatch(
      new RegExp(`m_42\\.md\\.${process.pid}\\.[0-9a-f]+\\.tmp$`),
    );
  });
});

describe("handleExport — Zod strict (T-4.7)", () => {
  it("rejects missing meetingId", async () => {
    await expect(
      handleExport({ format: "markdown" }, { exportRoot: "/tmp/x" }),
    ).rejects.toThrow();
  });

  it("rejects missing format", async () => {
    await expect(
      handleExport({ meetingId: "m_1" }, { exportRoot: "/tmp/x" }),
    ).rejects.toThrow();
  });

  it("rejects unknown format value", async () => {
    await expect(
      handleExport(
        { meetingId: "m_1", format: "html" },
        { exportRoot: "/tmp/x" },
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown keys (strict)", async () => {
    await expect(
      handleExport(
        { meetingId: "m_1", format: "markdown", extra: "no" },
        { exportRoot: "/tmp/x" },
      ),
    ).rejects.toThrow();
  });
});
