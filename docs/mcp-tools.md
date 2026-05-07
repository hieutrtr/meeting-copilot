# MCP Tools Reference

> Phase 4 sign-off snapshot. The **canonical reference** for the surface is `src/mcp/tools.ts` (Zod schemas + closed `ERROR_CODES` set + `TOOL_DEFINITIONS` array). This doc reflects the surface at v1.0.0; future drift surfaces as a snapshot mismatch in `src/mcp/tools.test.ts`.

## What this doc is

A 1-page reference for the 5 `bridge_meeting_*` MCP tools shipped by `meeting-copilot-mcp` (`src/mcp/bin.ts`). It documents the JSON-RPC contract a client (claude-bridge daemon, Telegram bot, Claude Code CLI) sees when it sends a `tools/call` request — name, input schema, output schema, error envelope, example invocation.

## What this doc is not

A tutorial. For the operator-facing entry point (install + register + Telegram dispatch examples), see `README.md` §"MCP Integration with claude-bridge". For the architectural rationale (why stdio, why these 5 tools, deeplink + embed design), see `docs/ARCHITECTURE.md` §9 (canonical) + §9.5/§9.6/§9.7 (Phase 4 implementation addendum) + §16 (discovery).

---

## 1. Tool surface

| Tool name | Handler file | Phase 4 task | Description (verbatim from `TOOL_DEFINITIONS`) |
|---|---|---|---|
| `bridge_meeting_install` | `src/mcp/handlers/install.ts` | T-4.3 | Check whether Meeting Copilot.app is installed and report the version. Idempotent; never mutates the filesystem (Phase 4 — install-from-URL deferred). |
| `bridge_meeting_start` | `src/mcp/handlers/start.ts` + `src/mcp/deeplink.ts` | T-4.4 | Spawn Meeting Copilot.app via the `meeting-copilot://` deeplink. Validates privacy mode against the requested STT provider before any process spawn; rejects with PrivacyModeViolation if disallowed. |
| `bridge_meeting_status` | `src/mcp/handlers/status.ts` + `src/mcp/socket.ts` | T-4.5 | List currently-running meetings or query a single meeting by id. Reads from the helper-daemon RPC socket; never spawns or mutates state. |
| `bridge_meeting_stop` | `src/mcp/handlers/stop.ts` (re-uses `socket.ts`) | T-4.6 | Stop a running meeting, flush its STT buffer, and persist final state. Idempotent: stopping an already-stopped meeting returns the recorded values. |
| `bridge_meeting_export` | `src/mcp/handlers/export.ts` + `src/mcp/exporters/{markdown,json,vtt,srt}.ts` | T-4.7 | Export a meeting's transcript + Q/A in markdown, json, vtt, or srt. Writes to `~/.claude-bridge/meeting-copilot/exports/<meetingId>.<ext>`; rejects path-traversal in meetingId. |

SDK pin: `@modelcontextprotocol/sdk ^1.0.0` (matches the claude-bridge daemon `package.json`). Run binary: `bun run mcp-server` (or `meeting-copilot-mcp` once the package is linked / installed).

---

## 2. Closed error code set

Every handler returns an MCP envelope in this shape on failure:

```jsonc
{
  "isError": true,
  "content": [{ "type": "text", "text": "<ErrorCode>: <message>" }]
}
```

`<ErrorCode>` is one of (frozen in `src/mcp/tools.ts` lines 42–51):

| Error code | Emitted by | Meaning | Sample message |
|---|---|---|---|
| `NotImplemented` | (placeholder paths only — no v1 handler emits this) | T-4.2 skeleton stub | `placeholder — T-4.<N> fills this in.` |
| `PrivacyModeViolation` | `bridge_meeting_start` | `(privacyMode, sttProvider)` pair disallowed by `isSttProviderAllowed`. Pre-spawn gate. | `local-first mode does not allow deepgram STT — use mlx or switch to cloud mode.` |
| `DeeplinkNotRegistered` | `bridge_meeting_start` | `open meeting-copilot://…` returned non-zero (first-launch race; app not registered as URL handler yet). | `meeting-copilot:// URL scheme not registered — launch Meeting Copilot.app once manually.` |
| `ContextNotFound` | `bridge_meeting_start` | A `contextPaths[]` string failed the path-traversal guard or the file did not exist. | `contextPaths[0] failed the path-traversal guard.` |
| `MeetingNotFound` | `bridge_meeting_stop`, `bridge_meeting_export` | No meeting with the supplied id in the helper-daemon socket reply / sqlite snapshot. | `no meeting with id m_404.` |
| `InvalidMeetingId` | `bridge_meeting_export` | `meetingId` argument contains `..`, `/`, `\`, NUL, or a leading `.` — blocks path-traversal in the export path. | `meetingId rejected: contains '..'.` |
| `ConfigSchemaUnsupported` | `src/discovery/bridgeConfig.ts` (boot path of `bin.ts`) | `~/.claude-bridge/config.json` has `version > 1`. | `config.version=2 unsupported — meeting-copilot understands version 1.` |
| `BridgeConfigInvalid` | `src/discovery/bridgeConfig.ts` (boot path of `bin.ts`) | Corrupt JSON, tilde-prefixed `path`, `..` in `path`, or schema mismatch. | `config.json invalid: <Zod issues>.` |

Adding a code requires updating `ERROR_CODES` in `src/mcp/tools.ts` AND the relevant handler test (review-checkbox gated per Phase 4 INDEX Rule 3).

---

## 3. Per-tool reference

### 3.1 `bridge_meeting_install`

**Handler:** `src/mcp/handlers/install.ts` (T-4.3).

**Input schema** (Zod source: `src/mcp/tools.ts` `InstallInputSchema`):

```jsonc
{
  "source":  "github" | "local",   // optional
  "ref":     string,                // optional — git ref or local marker
  "path":    string,                // optional — override bundle path
  "version": string                 // optional — request a specific version
}
// .strict() — unknown keys rejected.
```

**Output schema** (`InstallOutputSchema`):

```jsonc
{
  "installed":       boolean,           // true if Meeting Copilot.app is at the expected path
  "version":         string?,           // CFBundleShortVersionString, when installed
  "expectedVersion": string,            // package.json#version of this MCP server
  "downloadUrl":     string (URL)?,     // GitHub release URL, when not installed
  "message":         string             // human-readable summary
}
```

**Error envelopes:** none today — the install check is read-only and surfaces both states (`installed: true` and `installed: false` with `downloadUrl`) as **success** envelopes. Malformed Info.plist is treated as a "missing" state.

**Example invocation:**

```jsonc
// request
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "bridge_meeting_install", "arguments": {} } }

// success — installed
{ "jsonrpc": "2.0", "id": 1, "result": {
  "content": [{ "type": "text", "text": "installed: 1.0.0 (matches expected 1.0.0)" }],
  "structuredContent": {
    "installed": true,
    "version": "1.0.0",
    "expectedVersion": "1.0.0",
    "message": "Meeting Copilot.app v1.0.0 found at /Applications/Meeting Copilot.app."
  }
} }
```

---

### 3.2 `bridge_meeting_start`

**Handler:** `src/mcp/handlers/start.ts` (T-4.4) + pure URL builder `src/mcp/deeplink.ts`.

**Input schema** (`StartInputSchema`):

```jsonc
{
  "contextPaths":  Array<string (1..4096 chars)> (max 64),     // default []
  "sttProvider":   "mlx" | "fake" | "deepgram" | "elevenlabs",
  "ttsProvider":   "off" | "elevenlabs",                        // optional
  "model":         "claude-sonnet-4-6" | "claude-haiku-4-5",
  "privacyMode":   "local-first" | "cloud" | "mixed",
  "meetingTitle":  string (1..200 chars)?                       // optional
}
// .strict() — unknown keys rejected.
```

**Output schema** (`StartOutputSchema`):

```jsonc
{
  "meetingId": string,                  // helper-daemon-assigned id
  "pid":       integer (>= 0),          // Tauri app pid
  "rpcSocket": string,                  // path to helper-daemon Unix socket
  "uiUrl":     string (URL)             // http://127.0.0.1:7411/embed/transcript/<id>?token=...
}
```

**Error envelopes:** `PrivacyModeViolation`, `ContextNotFound`, `DeeplinkNotRegistered`.

**Pre-spawn gates (BLOCKING per INDEX R-2):**

1. **Path-traversal guard** on every `contextPaths[]` string — `..`, NUL, etc., reject with `ContextNotFound` **before** the URL build.
2. **Privacy mode gate** — `isSttProviderAllowed(privacyMode, sttProvider)` from `src/privacy/privacyMode.ts`. Disallowed pair → `PrivacyModeViolation`, spawn never invoked.

**Example invocation:**

```jsonc
// request
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "bridge_meeting_start",
    "arguments": {
      "contextPaths": ["/Users/me/projects/foo/docs/PRD.md"],
      "sttProvider": "mlx",
      "model": "claude-sonnet-4-6",
      "privacyMode": "local-first",
      "meetingTitle": "Foo design review"
    }
  } }

// success
{ "jsonrpc": "2.0", "id": 2, "result": {
  "content": [{ "type": "text", "text": "started meeting m_a1b2c3 (pid 12345)" }],
  "structuredContent": {
    "meetingId": "m_a1b2c3",
    "pid": 12345,
    "rpcSocket": "/Users/me/.claude-bridge/meeting-copilot.sock",
    "uiUrl": "http://127.0.0.1:7411/embed/transcript/m_a1b2c3?token=t-uuid-v4"
  }
} }

// failure — privacy violation
{ "jsonrpc": "2.0", "id": 2, "result": {
  "isError": true,
  "content": [{ "type": "text",
    "text": "PrivacyModeViolation: local-first mode does not allow deepgram STT — use mlx or switch to cloud mode." }]
} }
```

---

### 3.3 `bridge_meeting_status`

**Handler:** `src/mcp/handlers/status.ts` (T-4.5) + Unix-socket helper `src/mcp/socket.ts`.

**Input schema** (`StatusInputSchema`):

```jsonc
{
  "meetingId": string?    // optional — filter to one meeting; omit for all
}
// .strict()
```

**Output schema** (`StatusOutputSchema`):

```jsonc
{
  "meetings": Array<{
    "id":                string,
    "pid":               integer (>= 0),
    "startedAt":         number (epoch ms),
    "sttProvider":       "mlx" | "fake" | "deepgram" | "elevenlabs",
    "transcriptChunks":  integer (>= 0),
    "questionCount":     integer (>= 0),
    "answerCount":       integer (>= 0),
    "uptimeSec":         number (>= 0)
  }>
}
```

**Error envelopes:** none under nominal operation. Socket dial failure surfaces as a JSON-RPC transport error, not a tool envelope, per the SDK.

**Example invocation:**

```jsonc
// request — list all running meetings
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "bridge_meeting_status", "arguments": {} } }

// success
{ "jsonrpc": "2.0", "id": 3, "result": {
  "content": [{ "type": "text", "text": "1 meeting running" }],
  "structuredContent": {
    "meetings": [{
      "id": "m_a1b2c3", "pid": 12345, "startedAt": 1746615296000,
      "sttProvider": "mlx", "transcriptChunks": 47,
      "questionCount": 3, "answerCount": 3, "uptimeSec": 612.5
    }]
  }
} }
```

---

### 3.4 `bridge_meeting_stop`

**Handler:** `src/mcp/handlers/stop.ts` (T-4.6); reuses `src/mcp/socket.ts` from T-4.5.

**Input schema** (`StopInputSchema`):

```jsonc
{ "meetingId": string (>= 1 char) }
// .strict()
```

**Output schema** (`StopOutputSchema`):

```jsonc
{
  "exportedPath":  string?,             // optional — auto-export path if user opted in
  "durationSec":   number (>= 0),
  "questionCount": integer (>= 0)
}
```

**Error envelopes:** `MeetingNotFound`.

**Idempotency:** stopping an already-stopped meeting returns the recorded values without re-flushing. The cache (`crates/helper-daemon/src/mcp_rpc.rs`) ensures replay returns wire-level identical bytes.

**Example invocation:**

```jsonc
// request
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "bridge_meeting_stop", "arguments": { "meetingId": "m_a1b2c3" } } }

// success
{ "jsonrpc": "2.0", "id": 4, "result": {
  "content": [{ "type": "text",
    "text": "stopped m_a1b2c3 — duration 612.5s, 3 questions" }],
  "structuredContent": {
    "durationSec": 612.5,
    "questionCount": 3
  }
} }
```

---

### 3.5 `bridge_meeting_export`

**Handler:** `src/mcp/handlers/export.ts` (T-4.7) + per-format renderers `src/mcp/exporters/{markdown,json,vtt,srt}.ts`.

**Input schema** (`ExportInputSchema`):

```jsonc
{
  "meetingId": string (>= 1 char),
  "format":    "markdown" | "json" | "vtt" | "srt"
}
// .strict()
```

**Output schema** (`ExportOutputSchema`):

```jsonc
{
  "path":      string (>= 1 char),     // ~/.claude-bridge/meeting-copilot/exports/<meetingId>.<ext>
  "sizeBytes": integer (>= 0)
}
```

**Error envelopes:** `InvalidMeetingId`, `MeetingNotFound`.

**Path-traversal guard (CRITICAL):** `meetingId` is rejected pre-load if it contains `..`, `/`, `\`, NUL, a leading `.`, or the substring `m/../foo` shape. 7 vectors covered in `src/mcp/handlers/export.test.ts`.

**Atomic write:** the renderer writes to `<final>.<pid>.<random>.tmp` and renames to `<final>` on success; failure unlinks the tmp file. No partial export ever observable on disk.

**Markdown header convention:** every markdown export carries `> Privacy mode: <mode>` and `> Cost: $<amount>` lines in the header (cross-ref ARCH §15). No-Q&A meetings render a fallback `_(no questions in this meeting)_` block.

**Timestamp formats:**

- VTT: `HH:MM:SS.mmm` (regex `\d{2}:\d{2}:\d{2}\.\d{3}`).
- SRT: `HH:MM:SS,mmm` (regex `\d{2}:\d{2}:\d{2},\d{3}`).

**Example invocation:**

```jsonc
// request
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": {
    "name": "bridge_meeting_export",
    "arguments": { "meetingId": "m_a1b2c3", "format": "markdown" }
  } }

// success
{ "jsonrpc": "2.0", "id": 5, "result": {
  "content": [{ "type": "text",
    "text": "exported m_a1b2c3 to /Users/me/.claude-bridge/meeting-copilot/exports/m_a1b2c3.md (4821 bytes)" }],
  "structuredContent": {
    "path": "/Users/me/.claude-bridge/meeting-copilot/exports/m_a1b2c3.md",
    "sizeBytes": 4821
  }
} }
```

---

## 4. Discovery quick-reference

The MCP server self-registers in `~/.claude-bridge/config.json` on first boot via `src/discovery/bridgeConfig.ts`. The schema slice meeting-copilot owns lives in `src/discovery/schema.ts`. See ARCH §16 for the canonical schema description and the failure-mode table; see `README.md` §"Example `~/.claude-bridge/config.json`" for the copy-paste snippet.

Key invariants:

- **Atomic write** (`<config>.tmp` + rename) — never observe a partial config on disk.
- **Idempotent** — re-register with no field change skips the file write entirely (`alreadyRegistered: true`).
- **Concurrent writer safe** — daemon-owned keys (`daemon`, `dashboards`, `channels`, …) preserved on round-trip via Zod `.passthrough()`.
- **Env override:** `CLAUDE_BRIDGE_HOME` (absolute paths only — tilde rejected).

---

## 5. Telemetry

Every handler call optionally emits a scrubbed `mcp_tool_invoked` / `mcp_tool_error` event through `src/telemetry/telemetryLog.ts` IFF `telemetryEnabled === true` in the settings store (default OFF — Phase 3 T-3.9 carry-forward). Events are scrubbed against a fixed `FORBIDDEN_KEYS` list (`text`, `transcript`, `pcm`, `audio`, `apiKey`, `api_key`, `key`, `secret`, `token`, `password`) — the entire event drops if any forbidden key is present (no partial logging). No transcript bytes ever flow through the MCP layer or its telemetry hook. Cross-ref ARCH §14.

---

## 6. References

- **Source of truth:** [`src/mcp/tools.ts`](../src/mcp/tools.ts) — `TOOL_NAMES`, `TOOL_DEFINITIONS`, `ERROR_CODES`, the 5 Zod schemas.
- **Handler implementations:** [`src/mcp/handlers/`](../src/mcp/handlers/) (5 files).
- **Architecture:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §9 (canonical design), §9.5/§9.6/§9.7 (Phase 4 implementation addendum), §16 (discovery).
- **Per-task reviews:** [`docs/tasks/phase-4/T-4.2-review.md`](tasks/phase-4/T-4.2-review.md) … [`T-4.10-review.md`](tasks/phase-4/T-4.10-review.md).
- **Reference impl (read-only):** claude-bridge daemon `src/mcp/tools.ts` — same `TOOL_DEFINITIONS` shape applied to the dashboard tools (`bridge_dashboard_*`); meeting-copilot's 5 tools follow the same idempotent + typed-envelope conventions.
- **E2E test harness:** [`tests/e2e/mcp-dispatch.e2e.test.ts`](../tests/e2e/mcp-dispatch.e2e.test.ts) — spawns the real `meeting-copilot-mcp` binary and drives all 5 tools end-to-end via the upstream MCP SDK client.
