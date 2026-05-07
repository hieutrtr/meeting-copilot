// Phase 4 T-4.10 — Telegram → bridge → meeting-copilot E2E.
//
// Each `it` spawns the production `meeting-copilot-mcp` binary as a child
// process and drives it from a real `@modelcontextprotocol/sdk` client over
// stdio. The fixture-backed harness inside the bin (gated on
// `MEETING_COPILOT_E2E_FIXTURE_PATH`) intercepts side-effecting boundaries
// (spawn, socket dial, snapshot load) so no real Tauri app launches and no
// real Unix-domain socket is bound — but the production handler code, Zod
// parsing, privacy gate, deeplink builder, and exporter pipeline all run.
//
// 5 scenarios, in INDEX-prescribed order:
//   1. install-check (happy)
//   2. start-and-export (happy)
//   3. summarize-last-meeting (happy)
//   4. PrivacyModeViolation (error path)
//   5. ContextNotFound (error path)
//
// Determinism: each scenario spawns a fresh subprocess, uses a fresh tmpdir,
// and tears down in `finally`. Vitest runs `it`s serially under the default
// runner. The 3/3 deterministic-runs gate (Phase 4 INDEX) is verified by
// running the suite three times in a row from the host (PHASE-BROWSER-TEST
// records the result).

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ExporterMeetingSnapshot } from "../../src/mcp/exporters/types";
import type { E2EFixture } from "../../src/mcp/e2eHarness";

import {
  decodeToolResult,
  loadSeedMeeting,
  readSpawnLog,
  spawnMcpServer,
} from "./__helpers__/spawn-mcp-server";

interface CallToolEnvelope {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

const SCENARIO_TIMEOUT_MS = 30_000;

describe("T-4.10 — MCP dispatch E2E (Telegram → bridge → meeting-copilot)", () => {
  it(
    "Scenario A: install-check returns installed:false for a missing app bundle",
    async () => {
      const fixture: E2EFixture = {
        // tmpdir + exportRoot get filled by the helper at spawn time.
        tmpdir: "",
        exportRoot: "",
      };
      const spawned = await spawnMcpServer({ fixture: { ...fixture } });
      try {
        // Override appBundlePath to a path inside the spawn-helper-owned
        // workDir that we know does not exist.
        // The fixture file is already on disk at this point; we cannot mutate
        // it post-spawn. Instead, the install handler accepts an explicit
        // `path` argument that takes precedence — use that to point at a
        // non-existent path under the workDir.
        const result = (await spawned.client.callTool({
          name: "bridge_meeting_install",
          arguments: {
            path: `${spawned.workDir}/__no_such_meeting_copilot_bundle__.app`,
          },
        })) as CallToolEnvelope;
        expect(result.isError).toBeFalsy();
        const out = decodeToolResult<{
          installed: boolean;
          downloadUrl?: string;
          expectedVersion: string;
        }>(result);
        expect(out.installed).toBe(false);
        expect(out.downloadUrl).toMatch(/github\.com|releases/);
        expect(out.expectedVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
        // Spawn log was never created because the bin's start handler was
        // not invoked.
        expect(existsSync(`${spawned.workDir}/spawn.log`)).toBe(false);
      } finally {
        await spawned.close();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "Scenario B: start-and-export — start logs the deeplink, export writes markdown with seeded transcript",
    async () => {
      const seed = loadSeedMeeting() as ExporterMeetingSnapshot;

      const fixture: E2EFixture = {
        // The helper fills tmpdir + exportRoot once it knows its workDir, but
        // we need the spawnLogPath / handshake / snapshot to refer to that
        // same workDir. We set tmpdir/exportRoot to empty strings here so the
        // helper auto-fills them, and we leave the dependent paths blank;
        // the helper will use defaults for the spawn log etc.
        // To wire spawnLogPath / handshake explicitly, we pre-allocate a
        // workDir-shaped fixture below using a sentinel.
        tmpdir: "",
        exportRoot: "",
      };
      // First: spawn with a placeholder fixture to discover the workDir, then
      // re-wire and re-spawn... but we can avoid the double-spawn by passing
      // a placeholder workDir that the helper detects. Simpler: hand-build a
      // workDir-aware fixture by calling our own helper extension. For
      // simplicity we use a two-spawn approach? No — easier: pass `tmpdir` /
      // `exportRoot` already set to the eventual workDir via mkdtemp here and
      // tell the helper to use that exact path.
      //
      // Approach: pre-mint the workDir ourselves and pass it in.
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir: osTmp } = await import("node:os");
      const { sep, resolve: pathResolve } = await import("node:path");
      const workDir = mkdtempSync(`${osTmp()}${sep}t410-B-`);
      try {
        const wiredFixture: E2EFixture = {
          tmpdir: workDir,
          exportRoot: pathResolve(workDir, "exports"),
          spawnLogPath: pathResolve(workDir, "spawn.log"),
          handshake: {
            meetingId: seed.meeting.id,
            pid: 12345,
            rpcSocket: pathResolve(workDir, "rpc.sock"),
            uiUrl: `http://127.0.0.1:7411/embed/transcript/${seed.meeting.id}?token=t-e2e`,
          },
          snapshot: seed,
        };
        const spawned = await spawnMcpServer({ fixture: wiredFixture });
        try {
          // 1. Start a meeting.
          const startResult = (await spawned.client.callTool({
            name: "bridge_meeting_start",
            arguments: {
              contextPaths: [],
              sttProvider: "mlx",
              model: "claude-sonnet-4-6",
              privacyMode: "local-first",
            },
          })) as CallToolEnvelope;
          expect(startResult.isError).toBeFalsy();
          const startOut = decodeToolResult<{
            meetingId: string;
            uiUrl: string;
          }>(startResult);
          expect(startOut.meetingId).toBe(seed.meeting.id);
          expect(startOut.uiUrl).toMatch(
            /^http:\/\/127\.0\.0\.1:7411\/embed\/transcript\//,
          );

          // Spawn log records exactly one `open meeting-copilot://...` entry.
          // We read from the real workDir, NOT the spawn.workDir, because
          // we wired the fixture to the workDir we minted above.
          const log = readSpawnLog(workDir);
          expect(log).toHaveLength(1);
          expect(log[0].cmd).toBe("open");
          expect(log[0].args[0]).toMatch(/^meeting-copilot:\/\/start\?/);

          // 2. Export the meeting.
          const exportResult = (await spawned.client.callTool({
            name: "bridge_meeting_export",
            arguments: {
              meetingId: seed.meeting.id,
              format: "markdown",
            },
          })) as CallToolEnvelope;
          expect(exportResult.isError).toBeFalsy();
          const exportOut = decodeToolResult<{
            path: string;
            sizeBytes: number;
          }>(exportResult);
          expect(exportOut.path).toBe(
            pathResolve(workDir, "exports", `${seed.meeting.id}.md`),
          );
          expect(exportOut.sizeBytes).toBeGreaterThan(0);

          const onDisk = readFileSync(exportOut.path, "utf8");
          expect(onDisk).toContain(`# ${seed.meeting.title}`);
          expect(onDisk).toContain(seed.chunks[0].text);
          expect(onDisk).toContain(seed.chunks[1].text);
        } finally {
          await spawned.close();
        }
      } finally {
        const { rmSync } = await import("node:fs");
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "Scenario C: summarize-last-meeting — status finds it, export markdown contains Q&A + privacy line",
    async () => {
      const seed = loadSeedMeeting() as ExporterMeetingSnapshot;
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir: osTmp } = await import("node:os");
      const { sep, resolve: pathResolve } = await import("node:path");
      const workDir = mkdtempSync(`${osTmp()}${sep}t410-C-`);
      try {
        const wiredFixture: E2EFixture = {
          tmpdir: workDir,
          exportRoot: pathResolve(workDir, "exports"),
          statusReply: {
            meetings: [
              {
                id: seed.meeting.id,
                pid: 12345,
                startedAt: seed.meeting.startedAt,
                sttProvider: seed.meeting.sttProvider ?? "mlx",
                transcriptChunks: seed.chunks.length,
                questionCount: seed.questions.length,
                answerCount: seed.answer ? 1 : 0,
                uptimeSec: 60,
              },
            ],
          },
          snapshot: seed,
        };
        const spawned = await spawnMcpServer({ fixture: wiredFixture });
        try {
          // 1. Status — operator's "summarize my last meeting" begins by
          //    asking which meeting is current.
          const statusResult = (await spawned.client.callTool({
            name: "bridge_meeting_status",
            arguments: {},
          })) as CallToolEnvelope;
          expect(statusResult.isError).toBeFalsy();
          const statusOut = decodeToolResult<{
            meetings: Array<{ id: string; transcriptChunks: number }>;
          }>(statusResult);
          expect(statusOut.meetings).toHaveLength(1);
          const lastMeetingId = statusOut.meetings[0].id;
          expect(lastMeetingId).toBe(seed.meeting.id);
          expect(statusOut.meetings[0].transcriptChunks).toBeGreaterThan(0);

          // 2. Export markdown — the "summary" shape per T-4.7's exporter
          //    contract is the rendered Q/A block + transcript + cost/privacy
          //    header.
          const exportResult = (await spawned.client.callTool({
            name: "bridge_meeting_export",
            arguments: { meetingId: lastMeetingId, format: "markdown" },
          })) as CallToolEnvelope;
          expect(exportResult.isError).toBeFalsy();
          const exportOut = decodeToolResult<{ path: string }>(exportResult);
          const md = readFileSync(exportOut.path, "utf8");
          // Privacy header line (T-4.7 §6 risk — must be in the markdown
          // header per ARCH §11 cross-link).
          expect(md).toContain("> Privacy mode: local-first");
          // Cost meter line (T-4.7 markdown header).
          expect(md).toMatch(/^> Cost: \$[0-9]/m);
          // Q&A block — the seeded question + answer from seed-meeting.json.
          expect(md).toContain("## Questions & Answers");
          expect(md).toContain(seed.questions[0].text);
          if (seed.answer) {
            expect(md).toContain(seed.answer.text);
          }
        } finally {
          await spawned.close();
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "Scenario D (error): PrivacyModeViolation surfaces typed error, spawn never fires",
    async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir: osTmp } = await import("node:os");
      const { sep, resolve: pathResolve } = await import("node:path");
      const workDir = mkdtempSync(`${osTmp()}${sep}t410-D-`);
      try {
        const wiredFixture: E2EFixture = {
          tmpdir: workDir,
          exportRoot: pathResolve(workDir, "exports"),
          spawnLogPath: pathResolve(workDir, "spawn.log"),
          // Handshake provided just to prove the gate fires BEFORE we get
          // anywhere near the handshake stage; if the gate slipped, the
          // handler would proceed to spawn + poll and either hang or write
          // to the spawn log.
          handshake: {
            meetingId: "m_ignored",
            pid: 1,
            rpcSocket: pathResolve(workDir, "rpc.sock"),
            uiUrl: "http://127.0.0.1:7411/embed/transcript/m_ignored?token=t",
          },
        };
        const spawned = await spawnMcpServer({ fixture: wiredFixture });
        try {
          const result = (await spawned.client.callTool({
            name: "bridge_meeting_start",
            arguments: {
              contextPaths: [],
              sttProvider: "deepgram", // cloud STT under local-first → reject
              model: "claude-sonnet-4-6",
              privacyMode: "local-first",
            },
          })) as CallToolEnvelope;
          expect(result.isError).toBe(true);
          expect(result.content?.[0]?.text).toMatch(/^PrivacyModeViolation:/);
          // Spawn log file must remain absent — privacy gate fires BEFORE
          // the harness spawn closure.
          expect(existsSync(pathResolve(workDir, "spawn.log"))).toBe(false);
        } finally {
          await spawned.close();
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "Scenario E (error): ContextNotFound — traversal in contextPaths surfaces typed error, spawn never fires",
    async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir: osTmp } = await import("node:os");
      const { sep, resolve: pathResolve } = await import("node:path");
      const workDir = mkdtempSync(`${osTmp()}${sep}t410-E-`);
      try {
        const wiredFixture: E2EFixture = {
          tmpdir: workDir,
          exportRoot: pathResolve(workDir, "exports"),
          spawnLogPath: pathResolve(workDir, "spawn.log"),
          handshake: {
            meetingId: "m_ignored",
            pid: 1,
            rpcSocket: pathResolve(workDir, "rpc.sock"),
            uiUrl: "http://127.0.0.1:7411/embed/transcript/m_ignored?token=t",
          },
        };
        const spawned = await spawnMcpServer({ fixture: wiredFixture });
        try {
          const result = (await spawned.client.callTool({
            name: "bridge_meeting_start",
            arguments: {
              contextPaths: ["../etc/passwd"],
              sttProvider: "mlx",
              model: "claude-sonnet-4-6",
              privacyMode: "local-first",
            },
          })) as CallToolEnvelope;
          expect(result.isError).toBe(true);
          expect(result.content?.[0]?.text).toMatch(/^ContextNotFound:/);
          expect(existsSync(pathResolve(workDir, "spawn.log"))).toBe(false);
        } finally {
          await spawned.close();
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
