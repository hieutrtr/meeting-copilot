// Phase 4 T-4.2 — MCP server (stdio).
//
// Pattern reused from `claude-bridge/src/mcp/server.ts` (frozen v1.0.4):
//   1. `Server` constructed with name + version + capabilities.tools = {}.
//   2. `setRequestHandler(ListToolsRequestSchema, …)` returns TOOL_DEFINITIONS.
//   3. `setRequestHandler(CallToolRequestSchema, …)` dispatches by name to a
//      handler module under `src/mcp/handlers/`.
//   4. Unknown tool name → `Error(`Unknown tool: ${name}`)`.
//
// Differences:
//   - meeting-copilot has no Telegram inbound, so the "queued notification"
//     scaffolding from claude-bridge is intentionally NOT ported.
//   - Each handler is a pure async function `(args, deps) => Promise<ToolResult>`
//     so tests can swap deps and the dispatcher stays trivial.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { handleExport } from "./handlers/export";
import { handleInstall } from "./handlers/install";
import { handleStart } from "./handlers/start";
import { handleStatus } from "./handlers/status";
import { handleStop } from "./handlers/stop";
import {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  errorResult,
  isToolName,
  type ToolName,
  type ToolResult,
} from "./tools";

// Server identity. The version literal is bumped in T-4.12 alongside the
// `package.json#version` flip from 0.0.0 → 1.0.0. Read at module-load time so
// downstream tests can assert it; not parsed dynamically (would force fs I/O
// at import).
export const MCP_SERVER_NAME = "meeting-copilot" as const;
export const MCP_SERVER_VERSION = "0.4.0-skeleton" as const;

export type Handler = (args: unknown) => Promise<ToolResult>;

// Default handler table — wires the 5 placeholders. Each entry receives
// pre-parsed `args` (raw JSON value); per-handler Zod parsing happens inside
// the handler so each tool can apply its own validation rules.
export const DEFAULT_HANDLERS: Readonly<Record<ToolName, Handler>> = Object.freeze({
  bridge_meeting_install: (args) => handleInstall(args),
  bridge_meeting_start: (args) => handleStart(args),
  bridge_meeting_status: (args) => handleStatus(args),
  bridge_meeting_stop: (args) => handleStop(args),
  bridge_meeting_export: (args) => handleExport(args),
});

export interface BuildServerOpts {
  /** Override the handler table — used by tests to inject mocks. */
  handlers?: Partial<Record<ToolName, Handler>>;
  /** Override server name/version (for parity tests). */
  name?: string;
  version?: string;
}

/** Construct a fully-wired MCP server. Does NOT connect a transport — call
 * `server.connect(transport)` separately. Pure factory: no global state. */
export function buildServer(opts: BuildServerOpts = {}): Server {
  const server = new Server(
    {
      name: opts.name ?? MCP_SERVER_NAME,
      version: opts.version ?? MCP_SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
    },
  );

  const handlers: Record<ToolName, Handler> = {
    ...DEFAULT_HANDLERS,
    ...(opts.handlers ?? {}),
  } as Record<ToolName, Handler>;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS as unknown as Array<{
      name: string;
      description: string;
      inputSchema: object;
    }>,
  }));

  // The SDK's CallToolRequestSchema return type is a discriminated union that
  // includes "task" results for long-running tools. We only return the basic
  // CallToolResult shape (`content` + optional `isError`); cast through
  // `unknown` to satisfy the structural check without weakening our internal
  // ToolResult shape.
  server.setRequestHandler(
    CallToolRequestSchema,
    (async (request: { params: { name: string; arguments?: unknown } }) => {
      const { name, arguments: args } = request.params;

      if (!isToolName(name)) {
        // The MCP SDK turns thrown errors into JSON-RPC error responses.
        // Mirrors claude-bridge daemon behavior — preserves the parity test in
        // T-4.10 E2E.
        throw new Error(`Unknown tool: ${name}`);
      }

      const handler = handlers[name];
      if (!handler) {
        // Defensive — should never happen because the handler table is built
        // from TOOL_NAMES at construct time.
        return errorResult(
          "NotImplemented",
          `tool ${name} is registered but has no handler`,
        );
      }

      try {
        return await handler(args ?? {});
      } catch (err) {
        // Zod parse errors and any other handler exception surface as a
        // `isError: true` envelope — never crash the server. Real handlers may
        // map specific exceptions to typed error codes; the skeleton uses the
        // generic NotImplemented bucket.
        const message = err instanceof Error ? err.message : String(err);
        return errorResult("NotImplemented", message);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as unknown as Parameters<typeof server.setRequestHandler>[1],
  );

  return server;
}

/** Boot the server on stdio. Mirrors claude-bridge daemon's `startServer`. */
export async function startStdioServer(): Promise<{
  server: Server;
  transport: Transport;
}> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `${MCP_SERVER_NAME} MCP server v${MCP_SERVER_VERSION} started\n`,
  );
  return { server, transport };
}

/** Boot the server on an arbitrary transport — primarily for in-memory tests. */
export async function startServerOnTransport(
  transport: Transport,
  opts: BuildServerOpts = {},
): Promise<Server> {
  const server = buildServer(opts);
  await server.connect(transport);
  return server;
}

export { TOOL_DEFINITIONS, TOOL_NAMES };
