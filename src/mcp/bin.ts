#!/usr/bin/env bun
// Phase 4 T-4.2 — CLI entrypoint for the meeting-copilot MCP server.
//
// Usage:
//   bun run src/mcp/bin.ts            # boot the stdio server
//   bun run src/mcp/bin.ts --version  # print the package version and exit
//
// Per `package.json#bin`, this file is also the registered binary
// `meeting-copilot-mcp`. claude-bridge's `meeting_copilots[].mcp_bin` field
// (T-4.8) points at this same script.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_SERVER_VERSION, startStdioServer } from "./server";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/mcp → up two = repo root.
  const pkgPath = resolve(here, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${readPackageVersion()} (mcp ${MCP_SERVER_VERSION})\n`);
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "meeting-copilot-mcp — MCP server for Meeting Copilot",
        "",
        "Usage:",
        "  meeting-copilot-mcp            Boot the stdio server (default).",
        "  meeting-copilot-mcp --version  Print version and exit.",
        "  meeting-copilot-mcp --help     Show this help.",
        "",
      ].join("\n"),
    );
    return;
  }

  await startStdioServer();
}

void main().catch((err) => {
  process.stderr.write(`meeting-copilot-mcp failed to start: ${err}\n`);
  process.exit(1);
});
