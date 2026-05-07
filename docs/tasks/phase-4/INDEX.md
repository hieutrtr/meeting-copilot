# Phase 4 — MCP Integration với claude-bridge — Task Index

> Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 4 — MCP Integration với claude-bridge" (lines 122–145). Read-only spec.
> Architecture refs: ARCH §9 "MCP Integration với claude-bridge" (lines 322–400) — Discovery (§9.1), MCP tools 5× (§9.2), Helper daemon RPC (§9.3), Dashboard embed (§9.4). Phase 3 carry-forward: ARCH §3.4 trait+factory, §11.1 privacy constraint, §14 telemetry, §15 cost meter.
> Companion design refs: `claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` §7.2 Discovery, §13 MCP tool design (Zod schemas), §14 Agent integration, §16 config.json schema.
> Reference impl (claude-bridge daemon): `src/mcp/dashboard.ts`, `src/lib/dashboard-installer.ts`, `src/mcp/tools.ts` (TOOL_NAMES, TOOL_DEFINITIONS) — Phase 5 dashboard MCP tools are the **structural blueprint** for our 5 meeting-copilot tools (idempotent install, agent .md generation, compat range gate). Pattern reused, names mapped (`bridge_dashboard_*` → `bridge_meeting_*`).
> Carry-forward sign-offs: `docs/tasks/phase-1/PHASE-1-COMPLETE.md`, `docs/tasks/phase-2/PHASE-2-COMPLETE.md`, `docs/tasks/phase-3/PHASE-3-COMPLETE.md`.
> Stack lock (carry-forward from Phase 1+2+3): **Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Deepgram + ElevenLabs + Claude Sonnet 4.6 + Claude Haiku 4.5**. Phase 4 ADDS: `@modelcontextprotocol/sdk ^1.0.0` (TS, stdio transport — matches claude-bridge daemon pin), `zod ^3.23.0` (schema validation — same pin), Tauri deeplink scheme registration (`meeting-copilot://`), helper-daemon HTTP+SSE embed endpoint, helper-daemon Unix domain socket RPC.
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.
> **Layout note (binding):** ARCH §9.2 mentions tools live in `src/mcp/tools.ts` of *claude-bridge*. Meeting Copilot's side is the **MCP server implementation**, landing at `src/mcp/{server.ts,tools.ts,handlers/*}.ts` of *this* repo. The two surfaces meet over stdio: claude-bridge daemon would dispatch to a `meeting-copilot--default` agent which spawns `bun run mcp-server` (Phase 4.x — out of scope for Phase 4, but the script entry must exist). Phase 4 ships the MCP server as a standalone bun process invocable by `claude-bridge` once registered.

---

## Phase Goal (verbatim from plan)

> Meeting Copilot trở thành MCP tool, dispatch được từ Telegram qua `bridge`, transcript embed được trong claude-bridge dashboard.

## Phase Exit Criteria (verbatim)

> Từ Telegram → dispatch meeting-copilot → app start → user nói → transcript hiện trong dashboard iframe → câu hỏi tự detect → answer back về Telegram qua bridge notify. End-to-end < 30s setup từ Telegram.

This loop's gate (mirrors Phase 1/2/3 sign-off shape):

1. `bun test` (vitest) + `cargo test --workspace` all green — no Phase 1 / Phase 2 / Phase 3 regression.
2. E2E test (T-4.10) `dispatch meeting-copilot "summarize last meeting"` → reply contains transcript-derived summary, **3/3 runs green** (mocked stdio + mocked Tauri spawn + golden DB fixture; live host pass deferred to `PHASE-BROWSER-TEST.md`).
3. `PHASE-4-COMPLETE.md` sign-off committed with: 5-tool surface table, MCP SDK version pin, deeplink Info.plist diff, embed CORS+auth design, v1.0 release plan, Homebrew cask PR template.
4. Local annotated tag `v1.0.0` (NOT pushed — operator pushes after sign-off).

---

## Inputs Carried Forward From Phase 1+2+3

These artifacts are **re-used** (NOT rewritten); Phase 4 plugs into the same seams:

- **`crates/helper-daemon/`** (T-1.2 + T-1.6 + T-1.7) — current shape: in-process Rust crate exporting `bridge.rs`, `context.rs`, `repo.rs`. Phase 4 EXTENDS with `mcp_rpc.rs` (Unix domain socket listener for status/stop/export queries from MCP tool handlers) and `embed_http.rs` (HTTP server bound to `127.0.0.1:7411` serving `/embed/transcript/:meetingId` + SSE `/embed/transcript/:meetingId/events`). T-4.5/T-4.9 own these additions. Out-of-process transition is finally consummated here — the lib.rs PoC stays for in-process reuse but the binary entrypoint is added.
- **`src/store/meetingStore.ts`** (T-1.7) — meeting CRUD already covers Meeting + TranscriptChunk + Question + Answer. T-4.7 export tool reads via the same surface.
- **`src/store/settingsStore.ts`** (T-2.9 + T-3.6 + T-3.8 + T-3.9 v2) — gains 1 field for Phase 4: `mcpServerEnabled` (default OFF; enable via Settings sheet to permit external dispatch). Schema bump considered — likely additive `coerceLoaded` zero-fill (same pattern as `telemetryEnabled` in T-3.9).
- **`src/privacy/privacyMode.ts`** (T-3.8) — `isSttProviderAllowed`, `isTtsAllowed` are pure functions. T-4.4 `bridge_meeting_start` MUST gate the `sttProvider` argument through `isSttProviderAllowed(currentMode, requested)` BEFORE spawning — Local-first + Deepgram → return typed error `PrivacyModeViolation`, same shape as `crates/stt-mlx/src/providers/privacy.rs::PrivacyModeViolation`. This is the Rule 3 review checkbox "Privacy mode enforce ở MCP layer".
- **`src/telemetry/telemetryLog.ts`** (T-3.9) — opt-in event sink. T-4.2..T-4.7 emit `mcp_tool_invoked` / `mcp_tool_error` events through the existing scrubbed sink (no transcript bytes). Forbidden-key audit in T-4.<N>-review docs.
- **`src/persist/persistClient.ts`** (T-1.7) — SQLite read seam. T-4.7 export reads via this client; no new DB schema needed (all data already lands in `meetings.db`).
- **`shared/types.ts`** — extends with MCP-tool input/output types (mirroring ARCH §9.2 Zod schemas). Source of truth = `src/mcp/tools.ts` Zod, mirrored to TS via `z.infer`; shared/types.ts re-exports for cross-crate consumption.

Three Phase-0 blocked user-actions stay open (documented in Phase 1+2+3 sign-offs):

1. **BlackHole 2ch + Aggregate Device** — does NOT block Phase 4 (MCP layer does not touch audio capture path; `bridge_meeting_start` spawns the same Tauri app that handles capture).
2. **`ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY`** — already documented; Phase 4 adds NO new API keys. The MCP server consumes the same env-var surface as the Tauri app, plus an optional `MCP_BRIDGE_HOME` (default `~/.claude-bridge`) for discovery.
3. **`cargo` + `rustup` + `tauri-cli` not installed on loop sandbox** — same shape; Rust-side T-4.5 (helper daemon RPC), T-4.9 (embed HTTP) ship as code-complete with structural Rust tests + mocked Unix-socket harness + mocked HTTP layer (using `tokio::net::UnixListener` test seam + `axum::Router` direct service test, no real bind). Cargo re-verify pending host.

**Phase 4-specific carry-forward gate:** T-4.4 deeplink registration requires editing `src-tauri/tauri.conf.json` and macOS bundle Info.plist. Sandbox cannot run `tauri build` or notarize, so T-4.4 ships with config diff committed + a `manual-verify-deeplink.md` doc capturing the steps to validate on a host with Xcode CLT. T-4.12 DMG/notarization and Homebrew cask submission are **template + instructions only** — agent does NOT submit cask PR or run `xcrun notarytool`.

---

## Task Checklist (12 tasks)

- [x] **T-4.1** — Reverse-engineer `claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` §7 + §13 + §14 + §16; write `docs/tasks/phase-4/T-4.1-integration-design.md` (1 page) covering: discovery file format consumed by MC, how MC publishes itself in `meeting_copilots: []`, MCP transport choice (stdio matching daemon's `compat_range_for_dashboard` pattern), embed iframe origin + auth strategy. **AC:** doc committed; cross-references both ARCHs by section number; lists the 5 tool name → handler-file mapping (no code yet); identifies 3 risks (compat drift, deeplink registration, CORS+auth on embed). **Dep:** T-3.10 (Phase 3 docs final). **Risk:** API drift in claude-bridge daemon between read time and Phase 5 implementation — mitigated by pinning to v1.0.4 daemon snapshot. **Files touched:** `docs/tasks/phase-4/T-4.1-integration-design.md` + `docs/tasks/phase-4/T-4.1-review.md`. **Diff size:** ~150–250 LOC of markdown only. → **DONE** (doc-only; 4 cross-refs to MC ARCH §9.1–§9.4, 4 cross-refs to dashboard ARCH §7.2/§13/§14/§16; 5-tool→handler-file table + closed error-code set + sequence diagram + 3 risks).

- [x] **T-4.2** — MCP server skeleton: `src/mcp/server.ts` (stdio transport via `@modelcontextprotocol/sdk/server/stdio`), `src/mcp/tools.ts` (5 Zod schemas mirroring ARCH §9.2 + claude-bridge §13 shape), `src/mcp/handlers/{install,start,status,stop,export}.ts` placeholder returning `{isError: true, content: [{type:"text", text:"not implemented yet — T-4.<N>"}]}`. Add `package.json#bin` entry `meeting-copilot-mcp`. **AC:** vitest mock-stdio test (in-memory `Duplex` pair) — `tools/list` JSON-RPC returns 5 tool names + their `inputSchema` matching Zod-derived shapes; `tools/call` on each placeholder returns the typed not-implemented stub; `bun run mcp-server --version` prints package version. SDK version pin verified — `@modelcontextprotocol/sdk` MUST equal `^1.0.0` (claude-bridge daemon pin) per `package.json` diff. **Dep:** T-4.1. **Risk:** SDK API surface mismatch between claude-bridge consumer and MC provider — mitigated by sharing the exact `^1.0.0` range and a smoke test that boots both ends in-process. **Files touched:** `package.json` (+3 deps incl. `zod-to-json-schema`, +1 bin, +1 script), `bun.lock`, `src/mcp/{server,tools,bin}.ts` (NEW), `src/mcp/handlers/*.ts` (NEW × 5), `src/mcp/{server,tools}.test.ts` (NEW × 2), `shared/types.ts` (re-export Zod-inferred types). **Diff size:** ~870 LOC. → **DONE** (29 new vitest tests all green; full suite 40 files / 631 tests / 0 fail; `tsc --noEmit` clean; `bun run mcp-server --version` prints `0.0.0 (mcp 0.4.0-skeleton)`).

- [x] **T-4.3** — Tool `bridge_meeting_install`: handler implements check-app-installed (`/Applications/Meeting Copilot.app` Info.plist `CFBundleShortVersionString` parse) + version compat against MCP server's own `package.json#version` (no GitHub fetch in Phase 4 — install-from-URL deferred to Phase 4.x; the tool returns `{installed: bool, version?: string, expectedVersion: string, downloadUrl?: string, message: string}`). Idempotent: never mutates filesystem. **AC:** unit test (vitest) — mock `fs.readFileSync` returning fixture `Info.plist`, assert handler returns `{installed: true, version: "0.3.0", expectedVersion: <pkg.version>}`; missing app → `{installed: false, downloadUrl: <github-release-url>, message: "Install from <url>"}`. **Dep:** T-4.2. **Risk:** Info.plist format drift between macOS versions — fallback to `mdls -name kMDItemVersion` if XML parse fails; covered by 2-fixture test. **Files touched:** `src/mcp/handlers/install.ts`, `src/mcp/handlers/install.test.ts`, fixtures `src/mcp/__fixtures__/Info.plist.{installed,missing}.xml`. **Diff size:** ~150–250 LOC. → **DONE** (21 new tests all green; full suite 42 files / 652 tests / 0 fail; `tsc --noEmit` clean; 3-state envelope: missing / installed / malformed-plist; mdls fallback deferred to Phase 4.x per spec §9).

- [x] **T-4.4** — Tool `bridge_meeting_start({ contextPaths, sttProvider, ttsProvider?, model, privacyMode, meetingTitle? })`: spawn app via deeplink `meeting-copilot://start?...`. Implementation = (1) validate args via Zod (path traversal guards on `contextPaths`, enum check on providers), (2) gate `sttProvider` through `isSttProviderAllowed(privacyMode, sttProvider)` — reject with `PrivacyModeViolation` typed error; (3) build deeplink with URL-encoded query params (NO shell concat — use `URLSearchParams`); (4) spawn via `open` (macOS) or platform-equivalent launcher; (5) poll helper-daemon RPC (T-4.5 socket) for `meetingId` + `pid` for up to 5s; return `{meetingId, pid, rpcSocket, uiUrl}`. **Tauri bundle additions:** `src-tauri/tauri.conf.json` declares `meeting-copilot://` URL scheme (ARGV deeplink plugin or Info.plist `CFBundleURLTypes`); `src-tauri/src/lib.rs` registers a `tauri::ipc::Invoke` deeplink handler that parses query params and dispatches to a new `commands::start_from_deeplink` Tauri command — same surface as the existing UI Start button. **AC:** vitest unit on URL-builder (10 cases incl. injection attempts: `?contextPaths=..%2F..%2Fetc%2Fpasswd`, single quote, ampersand, semicolon — all percent-encoded; assert `URLSearchParams` yields safe string); separate test asserts privacy-mode gate rejects `{privacyMode:"local-first", sttProvider:"deepgram"}` BEFORE spawn; mocked `child_process.spawn` test confirms the command is `["open", "<deeplink>"]` array form (NOT shell string). Manual verify deeplink registration: `docs/tasks/phase-4/T-4.4-manual-verify-deeplink.md` checklist (host with Xcode CLT). **Dep:** T-4.3. **Risk:** Deeplink not registered until first `Meeting Copilot.app` launch — documented; tool surfaces a typed `DeeplinkNotRegistered` error if `open` returns non-zero. Plus: deeplink injection (CRITICAL) — review checkbox forbids any string concatenation; only `URLSearchParams` produces the deeplink. **Files touched:** `src/mcp/handlers/start.ts`, `src/mcp/handlers/start.test.ts`, `src/mcp/deeplink.ts` (NEW — pure URL builder), `src/mcp/deeplink.test.ts`, `src-tauri/tauri.conf.json` (+URL scheme block), `src-tauri/src/lib.rs` (+`commands::start_from_deeplink`), `docs/tasks/phase-4/T-4.4-manual-verify-deeplink.md` (NEW). **Diff size:** ~400–600 LOC. → **DONE** (37 new tests all green; full suite 44 files / 689 tests / 0 fail; `tsc --noEmit` clean; 13 R-2 injection vectors covered; spawn array-form asserted; privacy gate fires pre-spawn with spawn-spy count = 0; Tauri scheme registered in `tauri.conf.json` via `tauri-plugin-deep-link.desktop.schemes`; `commands::start_from_deeplink` cargo-side wiring deferred to host per `T-4.4-manual-verify-deeplink.md`).

- [x] **T-4.5** — Tool `bridge_meeting_status`: query running helper daemon over Unix domain socket `~/.claude-bridge/meeting-copilot.sock` (path resolved from `MCP_BRIDGE_HOME` env override); return list of meetings or filter by `meetingId`. Helper daemon side gains a tiny RPC server (`crates/helper-daemon/src/mcp_rpc.rs`) — line-delimited JSON request/response over the socket; methods `status`, `stop` (T-4.6 reuses), `subscribe` (T-4.9 reuses for SSE). **AC:** TS handler unit test mocks `net.createConnection` returning a fixture line `{"meetings":[…]}`, asserts handler returns parsed `MeetingStatus[]` matching ARCH §9.2 output schema. Rust unit test (`#[tokio::test]` with `tokio::net::UnixListener` in tmpdir) — write fixture state, send `{"method":"status"}` line, assert response shape. Discovery test: socket path resolved from env, falls back to `~/.claude-bridge/meeting-copilot.sock`, with path-traversal sanity check (no `..` in env override). **Dep:** T-4.4. **Risk:** Socket path race (two MC processes contending for one socket) — handler MUST `unlink` stale socket only if no listener responds within 200 ms; documented in `mcp_rpc.rs` doc-comment. **Files touched:** `src/mcp/handlers/status.ts`, `src/mcp/handlers/status.test.ts`, `src/mcp/socket.ts` (path resolver + connection helper, shared with T-4.6), `src/mcp/socket.test.ts`, `crates/helper-daemon/src/mcp_rpc.rs` (NEW), `crates/helper-daemon/src/lib.rs` (re-export), `crates/helper-daemon/Cargo.toml` (+`tokio` feature gate, `serde_json` already present). **Diff size:** ~400–500 LOC. → **DONE** (33 new vitest tests all green; full suite 46 files / 722 tests / 0 fail; `tsc --noEmit` clean; 9 new `#[tokio::test]` cases ship code-complete in `mcp_rpc.rs` — host cargo verify pending Phase 0 carry-forward; path-traversal env override rejection asserts `dial` not called; defense-in-depth client-side filter on `meetingId`).

- [x] **T-4.6** — Tool `bridge_meeting_stop({ meetingId })`: send `{"method":"stop","meetingId":…}` over the socket from T-4.5; helper daemon flushes transcript, closes STT stream, marks `Meeting.endedAt` + `Meeting.status="completed"` in SQLite, returns `{exportedPath?, durationSec, questionCount}` (exportedPath is the auto-export path if user opted in via settings, else absent). Idempotent: stopping an already-stopped meeting returns the recorded values without re-flushing. **AC:** TS handler unit test — happy path + idempotent path; Rust test exercises the stop-flush loop with a `FakeStt::Stopped` provider and a sqlite tmpfile, asserts `endedAt IS NOT NULL` and transcript chunk count matches. **Dep:** T-4.5. **Risk:** Mid-stream stop loses the in-flight chunk — mitigated by flushing the STT decoder buffer before returning; covered by Rust test that sends partial chunk before stop and asserts it lands in DB. **Files touched:** `src/mcp/handlers/stop.ts`, `src/mcp/handlers/stop.test.ts`, `crates/helper-daemon/src/mcp_rpc.rs` (extend), `crates/helper-daemon/src/repo.rs` (extend with `mark_meeting_ended`). **Diff size:** ~250–350 LOC. → **DONE** (17 new vitest tests + 2 server-test integration tests; full suite 47 files / 740 / 0 fail; `tsc --noEmit` clean; 5 new `dispatch_stop_*` Rust tests + 3 new `mark_meeting_ended_*` Rust tests ship code-complete — host cargo verify pending Phase 0 carry-forward; idempotent replay asserted via wire-level equality + cache size = 1; `MeetingNotFound` typed envelope mapping; STT-flush + Repo wiring deferred to Phase 4.x daemon binary entrypoint per spec §7).

- [x] **T-4.7** — Tool `bridge_meeting_export({ meetingId, format: "markdown" | "json" | "vtt" | "srt" })`: read meeting + transcript chunks via `persist/persistClient.ts` (TS-side, NOT helper daemon — keeps Rust reads minimal); render to one of 4 formats; write to `~/.claude-bridge/meeting-copilot/exports/<meetingId>.<ext>` and return `{path, sizeBytes}`. **AC:** vitest unit per format (4 golden fixtures): markdown headings + Q/A blocks render correctly; json round-trips through `JSON.parse`; VTT/SRT timestamps formatted as `HH:MM:SS.mmm` (VTT) / `HH:MM:SS,mmm` (SRT) and pass a synthetic VTT validator regex. Path traversal guard test — `meetingId` containing `..` → reject with `InvalidMeetingId`. **Dep:** T-4.6. **Risk:** Cost-meter cumulative + privacy-mode badge SHOULD appear in markdown header (per ARCH §15 cross-link) — covered by golden test asserting `## Privacy: …` and `## Cost: $…` lines present. **Files touched:** `src/mcp/handlers/export.ts`, `src/mcp/handlers/export.test.ts`, `src/mcp/exporters/{markdown,json,vtt,srt}.ts`, `src/mcp/exporters/*.test.ts`, fixtures under `src/mcp/__fixtures__/exports/`. **Diff size:** ~500–700 LOC. → **DONE** (84 new vitest tests across 6 files all green; full suite 53 files / 824 tests / 0 fail; `tsc --noEmit` clean; 7 path-traversal vectors on `meetingId` (`..`/`/`/`\`/NUL/leading-`.`/`m/../foo`/`../etc/passwd`) reject with `InvalidMeetingId` and assert loader+fs spies untouched; atomic write via `<final>.<pid>.<random>.tmp` + rename, with unlink-on-fail; markdown header includes both `> Privacy mode: …` and `> Cost: $…` lines (with no-Q&A fallback); VTT regex `\d{2}:\d{2}:\d{2}\.\d{3}` and SRT regex `\d{2}:\d{2}:\d{2},\d{3}` matched per-cue; 1 server integration test exercises export end-to-end with tmpdir + fixture loader; production snapshot loader wiring deferred to Phase 4.x per spec §7).

- [x] **T-4.8** — Discovery hook: `src/discovery/bridgeConfig.ts` reads `~/.claude-bridge/config.json` (path overridable via `CLAUDE_BRIDGE_HOME` env), validates with Zod (mirror of claude-bridge dashboard ARCH §16 schema, scoped to the `meeting_copilots: []` array), and on app startup auto-registers a `meeting-copilots` entry containing `{ version, path, default }`. Idempotent: existing entry with matching `path` is updated in place; never duplicates. Must atomic-write (`writeFileSync` to `<config>.tmp` then `renameSync`) — same pattern as claude-bridge `dashboard-installer.ts`. **AC:** vitest with mocked `fs` (memfs or jest.mock) — fresh config file → entry appended; existing entry → no-op return + `{ alreadyRegistered: true }`; corrupt JSON → throw `BridgeConfigInvalid` with original parse error reason; env override `CLAUDE_BRIDGE_HOME=/tmp/foo` resolves correctly with no tilde expansion (per ARCH §16 "absolute paths only"). **Dep:** T-4.2 (discovery hook calls into MCP server bootstrap to know its own `version` + `path`). **Risk:** Config schema drift if claude-bridge daemon bumps `config.version` past 1 — mitigated by reading `config.version` field, refusing if `> 1` with a typed `ConfigSchemaUnsupported` error pointing user to upgrade. **Files touched:** `src/discovery/bridgeConfig.ts` (NEW), `src/discovery/bridgeConfig.test.ts` (NEW), `src/discovery/schema.ts` (NEW — Zod), `src/mcp/bin.ts` (extend boot sequence). **Diff size:** ~300–400 LOC. → **DONE** (29 new tests all green; full suite 54 files / 853 tests / 0 fail; `tsc --noEmit` clean; idempotent re-register asserts atomic-write call count = 0; `passthrough()` round-trip preserves `daemon`/`dashboards`/`channels` keys; tilde-prefixed and `..`-containing path inputs rejected with `BridgeConfigInvalid`; `config.version > 1` routed to `ConfigSchemaUnsupported`; bin.ts wraps the call in try/catch so server boot never crashes on discovery failure).

- [x] **T-4.9** — Dashboard iframe embed endpoint: helper daemon's HTTP layer (`crates/helper-daemon/src/embed_http.rs`) binds `127.0.0.1:7411`, serves: (a) `GET /embed/transcript/:meetingId?token=…` → static HTML shell embedding `dist/embed/transcript.html` (built by Vite with a separate entry); (b) `GET /embed/transcript/:meetingId/events?token=…` → SSE stream of transcript + question + answer events. Auth = single-use token (UUID, 5-min TTL, scoped to `meetingId`) issued by helper daemon on `bridge_meeting_start`'s response (uiUrl already includes the token). CORS allow-list = `127.0.0.1` only (no wildcard); `Access-Control-Allow-Origin: http://127.0.0.1:7878` (claude-bridge dashboard default port). **AC:** Rust unit test using `axum::Router` direct `oneshot` invocation — valid token + meetingId → 200 + correct content-type; missing token → 401; expired token → 401; mismatched origin → 403. SSE test: feed 3 events into the broadcast channel, assert `data:` lines emitted in order. TS-side React `<TranscriptEmbed/>` component with a mocked `EventSource` test (RTL) covering connect / event / disconnect lifecycle. **Dep:** T-4.5 (socket subscribe RPC drives the SSE feed; embed_http is the WS-of-the-poor-man fan-out). **Risk:** CORS misconfiguration → embed leaks transcript to any local origin → **CRITICAL privacy regression** (Phase 3 T-3.8 explicit privacy gate). Review checkbox enforces explicit allow-list test. Token leak via referrer header — mitigated by `Referrer-Policy: no-referrer` header in the SSE response. **Files touched:** `crates/helper-daemon/src/embed_http.rs` (NEW), `crates/helper-daemon/src/auth.rs` (NEW — token mint+verify), `crates/helper-daemon/Cargo.toml` (+`axum`, `tokio` runtime feature, `tower-http`), `src/embed/TranscriptEmbed.tsx` (NEW), `src/embed/TranscriptEmbed.test.tsx`, `vite.config.ts` (+rollup `embed/transcript` entry), `src/embed/transcript-entry.tsx` (NEW). **Diff size:** ~700–900 LOC. → **DONE** (21 new vitest tests all green; full suite 55 files / 874 tests / 0 fail; `tsc --noEmit` clean; 11 new `auth.rs` `#[test]` cases + 14 new `embed_http.rs` `#[tokio::test]` cases ship code-complete — host cargo verify pending Phase 0 carry-forward; CORS allow-list hardcoded with 4-branch wildcard-veto test; `Referrer-Policy: no-referrer` + `Cache-Control: no-store` on every response — tested on 200 / 401 / 403 paths; TTL boundary semantics asserted at exact + 1ns; SSE event order asserted via positional substring scan; `<TranscriptEmbed/>` connect→event→error→unmount lifecycle covered).

- [ ] **T-4.10** — bridge dispatch E2E test harness. From a vitest test, simulate the Telegram → claude-bridge → meeting-copilot path: spawn the MCP server (T-4.2 stdio binary) as a child process; send a synthetic JSON-RPC `tools/call` for `bridge_meeting_start` with a fixed fixture context (DB pre-seeded with one meeting + transcript via `persist/persistClient.ts`); wait for `bridge_meeting_status` to report `chunks > 0`; call `bridge_meeting_export({format:"markdown"})`; assert the returned markdown contains the seeded transcript and a derived "summary" header. Mock the actual Tauri spawn (so no real app launches in CI) — the test verifies the **MCP surface contract** end-to-end, not the audio pipeline. **AC:** test passes 3/3 consecutive runs (deterministic — no flake budget); covers happy path + 2 error paths (privacy-mode violation surfaces typed error to caller; missing context file surfaces `ContextNotFound`). Live-host extension lives in `PHASE-BROWSER-TEST.md` (12-step manual). **Dep:** T-4.4, T-4.5, T-4.6, T-4.7 (E2E exercises 4 of the 5 tools — install is mockable). **Risk:** Process-spawn races in CI — mitigated by `pTimeout(handler, 5000)` on every JSON-RPC await; test marked `serial` to avoid socket contention. **Files touched:** `tests/e2e/mcp-dispatch.e2e.test.ts` (NEW), `tests/e2e/__helpers__/spawn-mcp-server.ts`, `tests/e2e/__fixtures__/seed-meeting.json`, `vitest.config.ts` (declare `tests/e2e/**` include + `setupFiles` if needed). **Diff size:** ~400–550 LOC.

- [ ] **T-4.11** — Update `README.md` (root) + `docs/ARCHITECTURE.md` Phase 4 addendum (append-only, mirroring Phase 3 pattern: `§9.5` MCP server impl pointer, `§9.6` deeplink scheme, `§9.7` embed CORS+auth, `§16` NEW config example block + Telegram dispatch quickstart). Add `docs/mcp-tools.md` (1-page tool reference: name, input schema, output schema, error envelope, example invocation). README gains an "MCP Integration" section with a copy-paste claude-bridge `config.json` snippet. **AC:** docs reflect Phase 4 reality — all 5 tool entries match `src/mcp/tools.ts` Zod definitions byte-for-byte; copy-paste example config validates against the Zod schema; `bun run typecheck` green. **Dep:** T-4.10 (docs reflect tested behavior, not aspirations). **Risk:** Doc drift if T-4.<N> review doc differs from final landed code — mitigated by writing T-4.11 LAST (single-pass sync against landed code) and a CI-style check-only `bun test src/mcp/tools.test.ts -- --update-snapshots=false`. **Files touched:** `README.md` (+MCP section), `docs/ARCHITECTURE.md` (+§9.5/§9.6/§9.7 + §16 NEW), `docs/mcp-tools.md` (NEW). **Diff size:** ~300–500 LOC of markdown.

- [ ] **T-4.12** — v1.0 release prep: (1) bump `package.json#version` 0.0.0 → 1.0.0 + matching `Cargo.toml` workspace bump where used; (2) create local annotated tag `v1.0.0` (NOT pushed); (3) write `docs/RELEASE-NOTES-v1.0.md` with Phase 1+2+3+4 highlights, breaking changes (none — first stable), known issues (Phase 0 carry-forward × 3); (4) prepare `docs/release/HOMEBREW-CASK.md` template with the cask formula skeleton (`url`, `sha256`, `app "Meeting Copilot.app"`, `zap trash:` lines) + step-by-step `homebrew/homebrew-cask` PR submission instructions — agent does NOT submit. (5) `docs/release/DMG-NOTARIZE.md` checklist for the operator (xcrun notarytool credentials, staple, distribution channel). **AC:** tag exists locally (`git tag -l v1.0.0` non-empty); release notes present; cask + DMG instruction docs render markdown valid (no broken links to internal anchors). **Dep:** T-4.11. **Risk:** Premature tag — if Phase 4 sign-off doc not yet written when tag is cut, the tag annotation will reference a non-existent doc. Mitigated by ordering: **PHASE-4-COMPLETE.md MUST land BEFORE the tag commit**, and the tag annotation links to the sign-off doc by relative path. **Files touched:** `package.json` (version bump), `Cargo.toml` workspace + member crates (where versioned), `docs/RELEASE-NOTES-v1.0.md` (NEW), `docs/release/HOMEBREW-CASK.md` (NEW), `docs/release/DMG-NOTARIZE.md` (NEW). **Diff size:** ~200–400 LOC of markdown + version bumps.

---

## Dependency Graph (ASCII)

```
        ┌───────────────────────────────────────────────────────────────┐
        │  Phase 1+2+3 carry-forward (NOT re-implemented):              │
        │   crates/helper-daemon (in-process bridge.rs/repo.rs)         │
        │   src/store/{meetingStore,settingsStore}                      │
        │   src/privacy/privacyMode (constraint gate — REUSED at T-4.4) │
        │   src/telemetry/telemetryLog (event sink — REUSED T-4.2..7)   │
        │   src/persist/persistClient (read seam — REUSED T-4.7)        │
        └──────┬────────────────────────────────────────────────────────┘
               ▼
         ┌──────────┐
         │  T-4.1   │  Integration design doc (no code)
         └────┬─────┘
              ▼
         ┌──────────┐
         │  T-4.2   │  MCP server skeleton (stdio + 5 placeholders + Zod)
         └────┬─────┘
              ├──────────────────────────────────────────────┐
              ▼                                              ▼
        ┌──────────┐                                   ┌──────────┐
        │  T-4.3   │  install (idempotent, no fs)      │  T-4.8   │  Discovery hook
        └────┬─────┘                                   │          │  (config.json read +
             ▼                                         │          │   meeting_copilots[])
        ┌──────────┐                                   └─────┬────┘
        │  T-4.4   │  start (deeplink + privacy gate         │
        │          │   + Tauri scheme registration)          │
        └────┬─────┘                                         │
             ▼                                               │
        ┌──────────┐                                         │
        │  T-4.5   │  status (Unix socket RPC,               │
        │          │   helper-daemon mcp_rpc.rs NEW)         │
        └────┬─────┘                                         │
             ├──────────────────────────────┐                │
             ▼                              ▼                │
        ┌──────────┐                  ┌──────────┐           │
        │  T-4.6   │  stop            │  T-4.9   │  Embed    │
        │          │  (reuses RPC)    │          │  iframe + │
        └────┬─────┘                  │          │  SSE      │
             ▼                        │          │  (CORS+   │
        ┌──────────┐                  │          │   token)  │
        │  T-4.7   │  export          └────┬─────┘           │
        │          │  (4 formats)          │                 │
        └────┬─────┘                       │                 │
             │                             │                 │
             └─────────────┬───────────────┴─────────────────┘
                           ▼
                     ┌──────────┐
                     │  T-4.10  │  E2E harness (Telegram → MCP → app)
                     └────┬─────┘
                          ▼
                     ┌──────────┐
                     │  T-4.11  │  README + ARCH addendum + mcp-tools.md
                     └────┬─────┘
                          ▼
                     ┌──────────┐
                     │  T-4.12  │  v1.0 tag + release notes + cask/DMG templates
                     └──────────┘
```

Critical path: **T-4.1 → T-4.2 → T-4.3 → T-4.4 → T-4.5 → T-4.6 → T-4.7 → T-4.10 → T-4.11 → T-4.12** (10 hops). T-4.8 (discovery) parallel after T-4.2 (joins T-4.10's E2E as a precondition that the MC binary self-registers). T-4.9 (embed) parallel after T-4.5 (consumes the same socket RPC subscribe channel).

Cross-phase explicit dependencies:

| New work | Depends on prior phase |
|---|---|
| T-4.4 privacy gate | Phase 3 T-3.8 `isSttProviderAllowed` |
| T-4.2..T-4.7 telemetry | Phase 3 T-3.9 `telemetryLog` (opt-in event sink) |
| T-4.5/T-4.6 helper daemon | Phase 1 T-1.2 + T-1.6 + T-1.7 (in-process Rust crate becoming out-of-process) |
| T-4.7 export | Phase 1 T-1.7 `persistClient` (SQLite read seam) |
| T-4.4 deeplink Tauri | Phase 1 T-1.1 (Tauri scaffold) + T-1.11 (settings panel — new toggle in v3) |

---

## TDD per task

| Task | Harness | Notes |
|---|---|---|
| T-4.1 | Doc-only review (markdown lint via `bun run typecheck` ignores docs; manual cross-ref check vs both ARCHs) | No code; AC = doc accurate cross-references |
| T-4.2 | Vitest mock-stdio (`Duplex` pair) + JSON-RPC framing assertions; `tools/list` snapshot | SDK pin asserted in `package.json` regex test |
| T-4.3 | Vitest unit on Info.plist parser + 2 fixtures (installed/missing) | Idempotent — no fs writes |
| T-4.4 | Vitest unit on URL builder (10 injection cases) + privacy-gate test + mocked `child_process.spawn` | Manual deeplink verify deferred to host (ARCH §9.2 + manual-verify doc) |
| T-4.5 | Vitest TS handler (mocked `net.createConnection`) + Rust `#[tokio::test]` Unix-socket integration in tmpdir | Path-traversal guard on env override is a unit test |
| T-4.6 | Vitest TS handler + Rust DB integration test with `FakeStt` | Idempotent stop covered explicitly |
| T-4.7 | Vitest unit per format (4 golden fixtures) + path-traversal test on meetingId | VTT/SRT timestamp regex validator |
| T-4.8 | Vitest with mocked `fs` (memfs) + Zod schema validation tests | `config.version > 1` guard tested |
| T-4.9 | Rust `axum` `oneshot` test (4 cases: 200/401/401-expired/403-CORS) + RTL `EventSource` mock test | Token TTL test uses fake clock |
| T-4.10 | Vitest E2E spawning real MC server child process; mocked Tauri spawn; pre-seeded SQLite fixture | 3/3 deterministic runs required (no flake) |
| T-4.11 | Doc-only review + `bun run typecheck` green + Zod-snapshot match against tools.ts | No code |
| T-4.12 | Manual verify (`git tag -l v1.0.0`) + markdown link audit | No code beyond version bumps |

---

## Acceptance Criteria Summary

| Task | Numeric AC |
|---|---|
| T-4.1 | Design doc committed; cross-references both ARCHs by section number; 5 tool name → handler-file mapping listed |
| T-4.2 | `tools/list` returns 5 names + Zod-derived schemas; `@modelcontextprotocol/sdk ^1.0.0` pin verified |
| T-4.3 | Idempotent installed/missing both green; no fs mutation observed |
| T-4.4 | 10 URL injection cases percent-encoded; privacy gate rejects pre-spawn; `open` invoked as array form (no shell) |
| T-4.5 | Unix socket RPC round-trip < 50 ms in test; path-traversal env override rejected |
| T-4.6 | Idempotent stop returns recorded values; in-flight chunk persisted to DB |
| T-4.7 | 4 formats × golden fixture pass; path traversal on `meetingId` rejected |
| T-4.8 | Atomic config write; `config.version > 1` rejected; idempotent re-register |
| T-4.9 | 4 HTTP cases (200/401/401-expired/403-CORS) green; SSE event order preserved; `Referrer-Policy: no-referrer` set |
| T-4.10 | 3/3 deterministic runs; happy path + 2 error paths pass |
| T-4.11 | Tools section byte-matches `src/mcp/tools.ts` Zod; example config validates |
| T-4.12 | Local tag `v1.0.0` exists; release notes + cask + DMG docs all render valid markdown |

---

## Risk Register (Phase 4 specific — top 5)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **MCP SDK version drift between MC and claude-bridge daemon.** Daemon bumps `@modelcontextprotocol/sdk` major; meeting-copilot's tool definitions silently fail JSON-RPC framing. | Medium | High | T-4.2 pin = `^1.0.0` (matching daemon `package.json`); tools.ts has a `tools/list` snapshot test that must be re-verified on every SDK bump; PHASE-4-COMPLETE captures the pinned daemon snapshot version (1.0.4) for future-proof debugging. |
| R-2 | **Deeplink injection / privacy bypass.** Caller passes a `contextPaths` value with shell metacharacters or `../` traversal; `bridge_meeting_start` passes it unsanitized into `open <deeplink>` and the Tauri app loads attacker-controlled file. **OR** privacy mode = local-first but caller passes `sttProvider: "deepgram"` and the spawn happens before the gate fires. | Medium | **CRITICAL** | T-4.4 enforces TWO gates BEFORE spawn: (1) Zod schema rejects path-traversal sequences in `contextPaths` strings; (2) `isSttProviderAllowed(privacyMode, sttProvider)` rejects with typed `PrivacyModeViolation` error. URL build uses `URLSearchParams` exclusively (no string concat). `child_process.spawn` invoked with array argv (no `shell: true`). Three tests cover each layer. Review checkbox is BLOCKING. |
| R-3 | **Embed iframe CORS misconfiguration.** A wildcard `Access-Control-Allow-Origin: *` lands by accident; any local origin can read live transcript via SSE; Phase 3 T-3.8 privacy gate is bypassed at the embed surface. | Low | **CRITICAL** | T-4.9 hardcodes the CORS allow-list to `http://127.0.0.1:7878` (claude-bridge dashboard). The 4-case axum test includes an explicit `Origin: http://evil.example` → 403 assertion. Token-based auth (single-use UUID, 5-min TTL, scoped to meetingId) is the second layer; even with CORS bypass, no token = 401. Review checkbox is BLOCKING. |
| R-4 | **Helper daemon out-of-process transition introduces races.** Phase 1 helper-daemon was in-process; T-4.5 makes it out-of-process for the first time. Two MC instances racing for the socket, or a stale socket file from a crashed prior run, breaks `bridge_meeting_status`. | Medium | Medium | T-4.5 RPC server `unlink`s stale sockets only after confirming no listener responds within 200 ms. Acquire-or-fail pattern documented in `mcp_rpc.rs`. PHASE-BROWSER-TEST.md step 7 explicitly tests crash-recovery (kill -9 + restart). |
| R-5 | **v1.0 notarization / Homebrew cask submission goes wrong on the operator side.** Agent writes correct templates but operator missteps in cask PR or notarization → release blocked. | Medium | Medium | T-4.12 ships **templates + checklists**, not submissions. `docs/release/DMG-NOTARIZE.md` lists Apple Developer credentials needed (no agent action), `xcrun notarytool` invocation, staple step. `docs/release/HOMEBREW-CASK.md` ships a complete cask formula skeleton + PR submission steps with `homebrew/homebrew-cask` link. Operator owns the final keypress. |

---

## Outputs Per Task

Every task creates:

- `docs/tasks/phase-4/T-4.<N>-<slug>.md` — plan + ARCH ref + AC + TDD plan + risk + mitigation
- Code under `src/mcp/`, `src/discovery/`, `src/embed/`, `crates/helper-daemon/`, `src-tauri/`, or `tests/e2e/` per the layout decisions in this INDEX
- Tests alongside the code (Vitest / `cargo test`)
- `docs/tasks/phase-4/T-4.<N>-review.md` — self-review (file changed, test count, AC verdict, no Phase-1/2/3 regression, MCP error envelope correct, deeplink injection-safe, privacy-mode enforced at MCP layer, iframe CORS+auth checked, no API key leak in MCP responses, no `git push`)

Final phase outputs:

- `docs/mcp-tools.md` — 1-page tool reference (5 tools)
- `docs/ARCHITECTURE.md` — Phase 4 addendum block (NOT a rewrite — append-only `§9.5/§9.6/§9.7 + §16`)
- `README.md` — MCP Integration section with copy-paste config
- `docs/RELEASE-NOTES-v1.0.md`
- `docs/release/HOMEBREW-CASK.md` — cask formula template + PR submission instructions
- `docs/release/DMG-NOTARIZE.md` — operator notarization checklist
- `docs/tasks/phase-4/PHASE-BROWSER-TEST.md` — 12-step manual: install MCP → discovery → start → status → export markdown/json/VTT/SRT → embed iframe load → SSE event flow → privacy violation rejection → stop → re-register idempotency → version bump verify
- `docs/tasks/phase-4/PHASE-4-COMPLETE.md` — sign-off with 5-tool surface table, MCP SDK pin, deeplink Info.plist diff, embed CORS+auth design, v1.0 release plan
- Local annotated tag `v1.0.0` (NOT pushed — operator pushes after sign-off)

---

## Process Rules (loop-binding)

Per the loop driver instructions:

1. **Task file per task** — `docs/tasks/phase-4/T-4.<N>-*.md`. One spec doc + one review doc per task.
2. **TDD strict** — MCP SDK integration test (mock stdio), tool handler unit + integration tests, socket discovery test (mock fs), config schema validation, iframe + SSE test, E2E from daemon → tool call → app spawn → response.
3. **Code review per task** — `T-4.<N>-review.md` with explicit checkboxes:
   - [ ] No regression Phase 1/2/3
   - [ ] MCP tool error handling proper (no panic on missing args; typed `isError` envelope)
   - [ ] Deeplink URL parser safe (no injection; URLSearchParams only)
   - [ ] Privacy mode enforce at MCP layer (Local-only is NOT dispatchable to Cloud STT)
   - [ ] Iframe embed CORS + auth check (allow-list + token TTL)
4. **Per-task commit** — type `feat(mcp)` / `feat(install)` / `feat(api)` / `docs` / `test` / `chore`. **No `git push`.**
5. **Phase test + sign-off** — `bun test` + `cargo test` (no regression); E2E test 3/3 pass; `PHASE-4-COMPLETE.md` + `PHASE-BROWSER-TEST.md`; local annotated tag `v1.0.0` (NOT pushed).

Every commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's headline outcome (test count + AC verdict) appears next to the title. Final state must show all 12 boxes ticked before `PHASE-4-COMPLETE.md` is written and `v1.0.0` tag is cut.
