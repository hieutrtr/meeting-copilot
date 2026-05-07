# Meeting Copilot

> Trạng thái: Planning · Owner: Hieu · Last updated: 2026-05-05
> Tài liệu: [PRD](docs/PRD.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [IMPLEMENTATION-PLAN](docs/IMPLEMENTATION-PLAN.md)

## Vision

AI hiện đại sinh ra quá nhiều content — long PRDs, code reviews, design docs, RFC dài 20 trang. Khi vào meeting hoặc design discussion, ngay cả tác giả cũng không nhớ hết chi tiết của những gì AI đã viết hộ. Meeting Copilot là một **desktop assistant chạy realtime trong meeting**: nó nghe audio (mic + system audio), hiển thị live transcript trên UI, tự detect câu hỏi trong cuộc nói chuyện, và sinh ra answer dựa vào *context user load trước* (PRDs, ARCHITECTURE docs, code diff, link tài liệu).

Use case điển hình: trước cuộc design review, user load `PRD.md`, `ARCHITECTURE.md`, và 3 PR diff vào Meeting Copilot. Khi đồng nghiệp hỏi *"Why did you pick tRPC over REST?"*, copilot bắt câu hỏi trong < 1 giây, retrieve §3 của ARCHITECTURE, và stream answer ra panel bên cạnh transcript trong < 5 giây. User chỉ cần đọc và trả lời — không phải lục lại doc giữa meeting.

Meeting Copilot tích hợp với **claude-bridge** qua MCP tool: bot Telegram có thể `bridge_meeting_start({ contextPaths, sttProvider })` để bật copilot từ xa, query trạng thái meeting hiện tại, hoặc export transcript. Copilot share cùng `~/.claude-bridge/config.json` discovery protocol như dashboard, được register như một agent đặc biệt.

## Quickstart

> ⚠️ Repo đang ở giai đoạn planning. Quickstart bên dưới là *placeholder* mô tả UX dự kiến cho Phase 1 MVP.

```bash
# Yêu cầu: macOS Apple Silicon, Bun ≥ 1.1, Rust toolchain (cho Tauri)

# 1. Cài đặt
git clone https://github.com/<org>/meeting-copilot
cd meeting-copilot
bun install
cargo install tauri-cli   # nếu chưa có

# 2. Cài audio loopback driver (cho system audio capture)
brew install blackhole-2ch
# Hoặc dùng Loopback.app (paid, friendlier UI)

# 3. Tải MLX Whisper model (~600MB, large-v3-turbo q4)
bun run download-model

# 4. Chạy dev
bun run tauri dev

# 5. Trong app:
#    - Click "New Meeting" → chọn audio source (System + Mic)
#    - "Add Context" → chọn PRDs / code files / paste URLs
#    - "Start Recording" → meeting bắt đầu, transcript live
#    - Câu hỏi auto-detect hiện ở panel phải, kèm answer
```

Cài đặt qua claude-bridge (Phase 4):

```bash
# Trong bot Telegram
"Cài meeting copilot version mới nhất"
# → bridge_meeting_install({ version: "latest" }) chạy ngầm
# → Đăng ký agent name: meeting-copilot
# → Sau đó: bridge_meeting_start({ contextPaths: [...], sttProvider: "mlx" })
```

> 📚 Chi tiết về MCP surface (5 tool, error envelope, deeplink, embed iframe, discovery): xem [§MCP Integration with claude-bridge](#mcp-integration-with-claude-bridge) bên dưới + [`docs/mcp-tools.md`](docs/mcp-tools.md).

## Supported Platforms

| Platform | STT Local (MLX) | STT Cloud | Status |
|---|---|---|---|
| **macOS Apple Silicon (M1+)** | ✅ priority | ✅ Deepgram, ElevenLabs | Phase 1 target |
| macOS Intel | ⚠️ slow (CPU only) | ✅ | Best effort |
| Linux x86_64 | ❌ MLX không support | ✅ | Phase 3+ |
| Windows | ❌ | ✅ | Phase 3+ (cần WASAPI loopback) |

UI built với Tauri (Rust + system WebView). Audio capture macOS dùng Core Audio + BlackHole/Loopback cho system audio, AVFoundation cho mic. Xem [ARCHITECTURE §2](docs/ARCHITECTURE.md) chi tiết.

## MCP Integration with claude-bridge

Meeting Copilot publishes itself in `~/.claude-bridge/config.json` as a registered "meeting-copilot" agent. Once registered, **claude-bridge** can dispatch the 5 `bridge_meeting_*` MCP tools from any client — Telegram bot, dashboard tab, Claude Code CLI — and the dispatched call drives the same surface a human user would see.

The 5-tool surface is frozen at v1.0:

| Tool | Purpose |
|---|---|
| `bridge_meeting_install` | Check whether `Meeting Copilot.app` is installed and report version. Idempotent; never mutates the filesystem. |
| `bridge_meeting_start` | Spawn the app via `meeting-copilot://` deeplink with chosen STT provider, model, privacy mode, and context paths. |
| `bridge_meeting_status` | List currently-running meetings or query a single meeting by id. |
| `bridge_meeting_stop` | Stop a running meeting, flush its STT buffer, and persist final state. Idempotent. |
| `bridge_meeting_export` | Export a meeting in `markdown`, `json`, `vtt`, or `srt`. Writes under `~/.claude-bridge/meeting-copilot/exports/`. |

See [`docs/mcp-tools.md`](docs/mcp-tools.md) for the full reference (Zod schemas, error envelopes, example invocations) and [ARCHITECTURE §9.5–§9.7 + §16](docs/ARCHITECTURE.md) for the runtime contract.

### Install + register

```bash
# 1. Install Meeting Copilot.app to /Applications (DMG flow — release notarization
#    instructions land alongside the v1.0 release; see docs/release/ once published).

# 2. Ensure ~/.claude-bridge exists (claude-bridge daemon creates it on first run).

# 3. Boot the MCP server once to self-register:
bun run mcp-server &
# The bin reads ~/.claude-bridge/config.json, appends a meeting_copilots[] entry
# (idempotent — re-running skips the file write if no field changed), then sits
# on stdio waiting for JSON-RPC.

# 4. Verify the registration landed:
cat ~/.claude-bridge/config.json | jq '.meeting_copilots'
# Expect: an array containing { version, path, default: true, installed_at, ... }
```

### Example `~/.claude-bridge/config.json`

```jsonc
{
  "version": 1,
  "daemon": {
    "version": "1.0.4",
    "db_path": "~/.claude-bridge/bridge.db",
    "socket": "~/.claude-bridge/daemon.sock",
    "mcp_endpoint": "stdio",
    "compat_range": ">=0.7.0 <2.0.0"
  },
  "dashboards": [],
  "meeting_copilots": [
    {
      "version": "1.0.0",
      "path": "/Applications/Meeting Copilot.app",
      "default": true,
      "installed_at": "2026-05-07T12:34:56Z",
      "installed_from": "github.com/anthropic/meeting-copilot@v1.0.0",
      "mcp_bin": "/Applications/Meeting Copilot.app/Contents/Resources/meeting-copilot-mcp"
    }
  ]
}
```

The schema slice this snippet validates against lives in [`src/discovery/schema.ts`](src/discovery/schema.ts) (`BridgeConfigSchema`). All other top-level keys are preserved on round-trip via Zod `.passthrough()` — meeting-copilot only writes `meeting_copilots[]` + the top-level `version` field, never the daemon's keys.

### Telegram dispatch examples

**"Cài meeting copilot"** → claude-bridge sends:

```jsonc
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "bridge_meeting_install", "arguments": {} } }
```

**"Bắt đầu meeting với context PRD.md, dùng MLX local"** → claude-bridge sends:

```jsonc
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
```

**"Export meeting m_01 sang markdown"** → claude-bridge sends:

```jsonc
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "bridge_meeting_export",
    "arguments": { "meetingId": "m_01", "format": "markdown" }
  } }
```

These three flows are the ones exercised end-to-end by `tests/e2e/mcp-dispatch.e2e.test.ts` (T-4.10 harness) — the test spawns the real `meeting-copilot-mcp` binary and drives it via the upstream `@modelcontextprotocol/sdk` `Client + StdioClientTransport` to assert the round-trip works.

### Privacy + safety guarantees

- **Privacy mode enforced at the MCP layer.** `bridge_meeting_start` rejects `(privacyMode, sttProvider)` mismatches **before** any process spawn — e.g. `(local-first, deepgram)` returns a `PrivacyModeViolation` typed envelope. The constraint cannot be bypassed by skipping the in-app picker. Source of truth: [`src/privacy/privacyMode.ts`](src/privacy/privacyMode.ts) (mirror in `crates/stt-mlx/src/providers/privacy.rs`). See ARCH §9.6.
- **Embed iframe origin allow-list = `http://127.0.0.1:7878` only** (claude-bridge dashboard default port). Hardcoded; no wildcard ever. Auth is a single-use UUID token scoped to one `meetingId` with a 5-minute TTL. Headers `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Frame-Options: SAMEORIGIN` are set on every response. See ARCH §9.7.
- **No transcript bytes ever leave the MCP layer.** Tool responses are structured envelopes only (meetingId, durations, counts, file paths). Telemetry is opt-in and scrubbed against a fixed `FORBIDDEN_KEYS` list — `text`, `transcript`, `pcm`, `audio`, `apiKey`, `key`, `secret`, `token`, `password` (Phase 3 T-3.9 carry-forward).

## Documentation

- **[docs/PRD.md](docs/PRD.md)** — Vision, persona, user stories, success metrics, privacy posture, wireframes.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — System design: audio pipeline, pluggable STT/TTS providers, question detection, context loader với prompt caching, UI framework pick (Tauri vs Electron), MCP integration với claude-bridge, data model, privacy modes, latency + cost budget.
- **[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)** — 5 phase từ spike → MCP integration, atomic task ≤ 1 day, acceptance criteria, risk register, cost estimate.

## License

TBD (likely BSL 1.1 → MIT after 2 years, theo pattern của claude-bridge-dashboard).
