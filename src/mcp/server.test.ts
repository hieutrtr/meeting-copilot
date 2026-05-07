// Phase 4 T-4.2 — MCP server integration test (mock stdio via InMemoryTransport).
//
// AC-1..AC-3, AC-8, AC-9 from `docs/tasks/phase-4/T-4.2-mcp-skeleton.md` —
// boots both Client and Server inline, exercises tools/list + tools/call.
//
// Why InMemoryTransport over a real subprocess: the MCP SDK ships a linked
// pair specifically for this purpose, the test stays fast (<100ms total),
// and no flakey OS-level pipe buffering shows up. Real-subprocess E2E is
// covered in T-4.10.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  buildServer,
  startServerOnTransport,
} from "./server";
import { TOOL_NAMES } from "./tools";

interface CallToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function bootClientServer(): Promise<{
  client: Client;
  closeAll: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = await startServerOnTransport(serverTransport);

  const client = new Client(
    { name: "meeting-copilot-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    closeAll: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP server skeleton (T-4.2)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const booted = await bootClientServer();
    client = booted.client;
    cleanup = booted.closeAll;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("server identity is the documented name + version", () => {
    expect(MCP_SERVER_NAME).toBe("meeting-copilot");
    expect(MCP_SERVER_VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });

  it("tools/list returns the 5 documented tools in registry order", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
  });

  it("each tool has a non-empty description and a JSON-Schema input", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeTypeOf("string");
      expect((tool.description ?? "").length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeTypeOf("object");
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  // T-4.3 lit `bridge_meeting_install`; T-4.4 lit `bridge_meeting_start`;
  // T-4.5 lit `bridge_meeting_status`; T-4.6 lit `bridge_meeting_stop`;
  // T-4.7 lit `bridge_meeting_export` — the placeholder list is now empty.
  // Positive integration tests sit below; they use the in-memory client +
  // a buildServer handler override so the tests never touch a real socket
  // or filesystem outside an isolated tmpdir.

  it("bridge_meeting_start (T-4.4) end-to-end via injected handler — happy path", async () => {
    // Use an isolated buildServer with a handler override that injects test
    // deps (mock spawn + synthetic handshake). Avoids shelling out to
    // `open(1)` on the host machine.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleStart, syntheticHandshake } = await import("./handlers/start");
    let spawnCallCount = 0;
    const server = buildServer({
      handlers: {
        bridge_meeting_start: (args) =>
          handleStart(args, {
            spawn: (cmd, sArgs, _opts) => {
              spawnCallCount += 1;
              expect(cmd).toBe("open");
              expect((sArgs as readonly string[])[0]).toMatch(
                /^meeting-copilot:\/\/start\?/,
              );
              return { unref: () => undefined };
            },
            pollHandshake: async () => syntheticHandshake({ meetingId: "m-int" }),
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t44-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_start",
        arguments: {
          contextPaths: ["/tmp/PRD.md"],
          sttProvider: "mlx",
          model: "claude-sonnet-4-6",
          privacyMode: "local-first",
        },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(spawnCallCount).toBe(1);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"meetingId": "m-int"');
    } finally {
      await isolatedClient.close();
      await server.close();
    }
  });

  it("bridge_meeting_start (T-4.4) rejects PrivacyModeViolation BEFORE spawn", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleStart, syntheticHandshake } = await import("./handlers/start");
    let spawnCallCount = 0;
    const server = buildServer({
      handlers: {
        bridge_meeting_start: (args) =>
          handleStart(args, {
            spawn: () => {
              spawnCallCount += 1;
              return { unref: () => undefined };
            },
            pollHandshake: async () => syntheticHandshake(),
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t44-privacy-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_start",
        arguments: {
          contextPaths: [],
          sttProvider: "deepgram", // cloud STT under local-first → must reject
          model: "claude-sonnet-4-6",
          privacyMode: "local-first",
        },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^PrivacyModeViolation:/);
      expect(spawnCallCount).toBe(0);
    } finally {
      await isolatedClient.close();
      await server.close();
    }
  });

  it("bridge_meeting_status (T-4.5) end-to-end via injected handler — happy path", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleStatus } = await import("./handlers/status");
    const fixtureReply = {
      meetings: [
        {
          id: "m_int",
          pid: 9999,
          startedAt: 1_700_000_000_000,
          sttProvider: "mlx",
          transcriptChunks: 3,
          questionCount: 0,
          answerCount: 0,
          uptimeSec: 7,
        },
      ],
    };
    let dialCallCount = 0;
    const server = buildServer({
      handlers: {
        bridge_meeting_status: (args) =>
          handleStatus(args, {
            resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/h" },
            dialSocket: async () => {
              dialCallCount += 1;
              return fixtureReply;
            },
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t45-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_status",
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(dialCallCount).toBe(1);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"m_int"');
      expect(text).toContain('"sttProvider": "mlx"');
    } finally {
      await isolatedClient.close();
      await server.close();
    }
  });

  it("bridge_meeting_install (T-4.3) probes a missing path and returns installed:false", async () => {
    // Pass an explicit non-existent path so the test never reads the real
    // `/Applications/Meeting Copilot.app` on a developer machine.
    const result = (await client.callTool({
      name: "bridge_meeting_install",
      arguments: {
        path: "/var/empty/__t43_integration_meeting_copilot__.app",
      },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"installed": false');
    expect(text).toMatch(/github\.com|releases/);
  });

  it("rejects unknown tool names with a JSON-RPC error", async () => {
    await expect(
      client.callTool({ name: "bridge_dashboard_install", arguments: {} }),
    ).rejects.toThrow(/Unknown tool: bridge_dashboard_install/);
  });

  it("Zod parse failure (bad arg type) surfaces as isError envelope, not a panic", async () => {
    const result = (await client.callTool({
      name: "bridge_meeting_export",
      arguments: { meetingId: 42, format: "markdown" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    // Server stays alive for the next call. The default export handler uses
    // a stub loader that returns null (production wiring is Phase 4.x), so
    // a valid-shape arg still surfaces an isError envelope (MeetingNotFound)
    // — proving the dispatcher recovers from a thrown Zod error in the
    // previous call and continues to dispatch subsequent requests.
    const second = (await client.callTool({
      name: "bridge_meeting_export",
      arguments: { meetingId: "m_42", format: "markdown" },
    })) as CallToolResult;
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toMatch(/^MeetingNotFound:/);
  });

  it("bridge_meeting_stop (T-4.6) end-to-end via injected handler — happy path", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleStop } = await import("./handlers/stop");
    const fixtureReply = {
      durationSec: 18,
      questionCount: 1,
    };
    let dialCallCount = 0;
    const server = buildServer({
      handlers: {
        bridge_meeting_stop: (args) =>
          handleStop(args, {
            resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/h" },
            dialSocket: async (_path, request) => {
              dialCallCount += 1;
              expect(request).toMatchObject({ method: "stop", meetingId: "m_int" });
              return fixtureReply;
            },
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t46-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_stop",
        arguments: { meetingId: "m_int" },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(dialCallCount).toBe(1);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"durationSec": 18');
      expect(text).toContain('"questionCount": 1');
    } finally {
      await isolatedClient.close();
      await server.close();
    }
  });

  it("bridge_meeting_export (T-4.7) end-to-end via injected handler — happy path", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { sep, resolve: pathResolve } = await import("node:path");
    const tmp = mkdtempSync(`${tmpdir()}${sep}t47-server-`);
    const STARTED_AT = 1_700_000_000_000;
    const fixtureSnapshot = {
      meeting: {
        id: "m_int",
        title: "Server-integration sync",
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
          meetingId: "m_int",
          text: "first utterance",
          startTs: STARTED_AT + 1_000,
          endTs: STARTED_AT + 2_000,
          isFinal: true,
        },
      ],
      questions: [],
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleExport } = await import("./handlers/export");
    let loadCallCount = 0;
    const server = buildServer({
      handlers: {
        bridge_meeting_export: (args) =>
          handleExport(args, {
            exportRoot: tmp,
            loadSnapshot: async (id) => {
              loadCallCount += 1;
              return id === fixtureSnapshot.meeting.id ? fixtureSnapshot : null;
            },
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t47-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_export",
        arguments: { meetingId: "m_int", format: "markdown" },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(loadCallCount).toBe(1);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain('"path"');
      expect(text).toContain('"sizeBytes"');
      // The path landed under the injected exportRoot.
      const expectedPath = pathResolve(tmp, "m_int.md");
      expect(text).toContain(expectedPath);
      // The on-disk content is the markdown body produced by the renderer.
      const onDisk = readFileSync(expectedPath, "utf8");
      expect(onDisk).toContain("# Server-integration sync");
    } finally {
      await isolatedClient.close();
      await server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bridge_meeting_stop (T-4.6) maps DaemonMeetingNotFound to MeetingNotFound", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { handleStop } = await import("./handlers/stop");
    const server = buildServer({
      handlers: {
        bridge_meeting_stop: (args) =>
          handleStop(args, {
            resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/h" },
            dialSocket: async () => ({
              error: {
                code: "DaemonMeetingNotFound",
                message: 'no active meeting with id "m_ghost"',
              },
            }),
          }),
      },
    });
    await server.connect(serverTransport);
    const isolatedClient = new Client(
      { name: "t46-not-found-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await isolatedClient.connect(clientTransport);
    try {
      const result = (await isolatedClient.callTool({
        name: "bridge_meeting_stop",
        arguments: { meetingId: "m_ghost" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
    } finally {
      await isolatedClient.close();
      await server.close();
    }
  });
});

describe("buildServer factory", () => {
  it("accepts an injected handler override (used by future tests)", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    let observedArgs: unknown = null;
    const server = buildServer({
      handlers: {
        bridge_meeting_install: async (args) => {
          observedArgs = args;
          return {
            content: [{ type: "text", text: "ok" }],
          };
        },
      },
    });
    await server.connect(serverTransport);

    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = (await client.callTool({
      name: "bridge_meeting_install",
      arguments: { source: "github" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("ok");
    expect(observedArgs).toEqual({ source: "github" });

    await client.close();
    await server.close();
  });
});
