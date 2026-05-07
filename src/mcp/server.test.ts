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

  // T-4.3 lit `bridge_meeting_install` — no longer in the placeholder list.
  // Remaining 4 placeholders below; the install integration test follows the
  // describe.each block.
  describe.each([
    {
      name: "bridge_meeting_start",
      futureTask: "T-4.4",
      args: {
        contextPaths: [],
        sttProvider: "mlx",
        model: "claude-sonnet-4-6",
        privacyMode: "local-first",
      } as Record<string, unknown>,
    },
    {
      name: "bridge_meeting_status",
      futureTask: "T-4.5",
      args: {} as Record<string, unknown>,
    },
    {
      name: "bridge_meeting_stop",
      futureTask: "T-4.6",
      args: { meetingId: "m_42" } as Record<string, unknown>,
    },
    {
      name: "bridge_meeting_export",
      futureTask: "T-4.7",
      args: { meetingId: "m_42", format: "markdown" } as Record<string, unknown>,
    },
  ])("placeholder for %s", ({ name, futureTask, args }) => {
    it(`returns NotImplemented envelope tagged for ${futureTask}`, async () => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toMatch(/^NotImplemented: /);
      expect(result.content[0]?.text).toContain(futureTask);
    });
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
    // Server stays alive for the next call. Use a still-placeholder tool
    // (status, T-4.5) so this test stays a placeholder-shape probe rather
    // than depending on whichever handlers are real-implemented.
    const second = (await client.callTool({
      name: "bridge_meeting_status",
      arguments: {},
    })) as CallToolResult;
    expect(second.isError).toBe(true);
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
