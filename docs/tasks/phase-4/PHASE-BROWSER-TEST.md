# Phase 4 — Browser / Live-Host Manual Test

> Companion to `PHASE-4-COMPLETE.md` (the sandbox-runnable sign-off). This file is the **wall-clock host re-verify** for the Phase 4 surfaces that need a real `Meeting Copilot.app` install, a real `claude-bridge` daemon at v1.0.4, real macOS deeplink registration, real Unix-domain-socket RPC, real HTTP+SSE on `127.0.0.1:7411`, and a real Telegram → claude-bridge → meeting-copilot path.
>
> **Why a separate doc:** the loop sandbox lacks `cargo` + `tauri-cli` + Apple-Silicon hardware + a notarized `Meeting Copilot.app` bundle + a Telegram bot wired to a live `claude-bridge` instance. The vitest + cargo-mocked unit tests close the per-task AC gates (900 / 900 vitest, structural cargo, end-to-end JSON-RPC subprocess in T-4.10). The live numbers are a deferred verify per the Phase 1 / 2 / 3 sign-off pattern. Same shape as `phase-3/PHASE-BROWSER-TEST.md`.
>
> **Run cadence:** once at end-of-phase + after any Phase-4.x bug-fix that touches an MCP tool handler, the deeplink scheme, the discovery hook, the helper-daemon RPC socket, the embed HTTP server, or the SSE stream. ~35 minutes wall-clock for the full pass; the Telegram E2E (step 9) and the SSE live-update soak (step 6) dominate. Steps 1, 4, 7, 10–12 alone are ~10 minutes.
>
> Phase 4 exit criteria pinned by `INDEX.md` and `IMPLEMENTATION-PLAN.md` Phase 4:
>
> - From Telegram → dispatch meeting-copilot → app starts via deeplink → user speaks → transcript renders in dashboard iframe → question auto-detected → answer pushed back through bridge notify. End-to-end < 30 s setup time from first Telegram message.
> - All 5 MCP tools (`bridge_meeting_install`, `_start`, `_status`, `_stop`, `_export`) round-trip a JSON-RPC call from a real `claude-bridge` daemon (v1.0.4 snapshot, MCP SDK ^1.0.0 pin).
> - Discovery hook auto-registers `meeting-copilots[]` entry in `~/.claude-bridge/config.json` on MCP server boot; idempotent across restarts.
> - Privacy-mode gate (Phase 3 T-3.8 carry-forward) rejects Local-first → cloud-STT before any process spawn — at the MCP layer, not just the UI.
> - Iframe embed enforces token + origin allow-list; CORS is `127.0.0.1:7878` only; SSE pushes events in order with `Referrer-Policy: no-referrer`.

---

## Prerequisites

- All Phase 1 + 2 + 3 prereqs (BlackHole 2-channel + Aggregate Device, `ANTHROPIC_API_KEY`, optional `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` for cloud-mode steps, `cargo` + `rustup` + Tauri 2 CLI, microphone permission).
- **Notarized `Meeting Copilot.app` v1.0.0** at `/Applications/Meeting Copilot.app` (built via `bun tauri build` then notarized per `docs/release/DMG-INSTRUCTIONS.md` — pre-notarization a dev build under `src-tauri/target/release/bundle/macos/Meeting Copilot.app` is acceptable for steps 1–8; step 9 needs the installed-bundle path because claude-bridge invokes via `open <deeplink>` on the real bundle).
- **`claude-bridge` daemon v1.0.4 installed and running** (`bun install -g claude-bridge` or run from a sibling clone). Confirm with `claude-bridge --version` → `1.0.4`. The daemon must already have one Telegram channel wired (chat_id known) per `claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` §7.
- **MCP server binary buildable**: `bun install` in this repo, then `bun run mcp-server --version` should print `1.0.0 (mcp 0.4.0-skeleton)` to stderr. (The version line is on stderr — stdout is reserved for JSON-RPC framing.)
- `~/.claude-bridge/config.json` exists and is writable. **Back up before this test** — step 7 mutates it (idempotently, but operator due-diligence). `cp ~/.claude-bridge/config.json ~/.claude-bridge/config.json.bak`.
- Two terminals open side-by-side: one running `claude-bridge dev` with stdout visible (you'll watch dispatch logs), one running `tail -f ~/.claude-bridge/meeting-copilot/logs/*.log` once the helper daemon spawns it.
- A modern browser (Safari, Chrome, Firefox) for the iframe embed steps (5, 6). The claude-bridge dashboard (`http://127.0.0.1:7878`) must be reachable for the CORS allow-list to apply.
- Stopwatch on phone for the wall-clock budgets in steps 4, 6, and 9.

## Layout

Each step has:

- **Action** — what to do.
- **Expected** — what you should see (UI, log, file, JSON-RPC reply).
- **Pass criterion** — the bool gate.

Mark each step `[ ] PASS` / `[ ] FAIL` as you go. A FAIL on any step blocks the live re-verify; file a Phase-4.x ticket with the failing step + screenshot + the affected `T-4.<N>` reference.

---

## Steps

### Step 1 — `bridge_meeting_install` probe (T-4.3)

- **Action:** From a third terminal:

  ```sh
  bun run mcp-server &  # leave running in background; PID echoed
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_meeting_install","arguments":{}}}' \
    | bun run mcp-server  # one-shot stdio invocation
  ```

  (The one-shot form re-spawns a server, sends the JSON-RPC line, and prints the reply. For the persistent form, use `claude-bridge dispatch meeting-copilots install` once step 7 has registered the entry.)

- **Expected:** A single JSON-RPC reply line on stdout containing `"installed":true`, `"version":"1.0.0"` (or whatever the bundle's `CFBundleShortVersionString` is), and `"expectedVersion":"1.0.0"` matching `package.json#version`. The `content[0].text` field has a human-readable `Meeting Copilot.app installed at /Applications/Meeting Copilot.app — version 1.0.0`. No filesystem mutation: `stat -f "%m" /Applications/Meeting\ Copilot.app` mtime is unchanged before vs after (T-4.3 idempotency invariant).
- **Pass criterion:** reply has `installed: true` + matching versions; mtime unchanged; reply arrives in < 500 ms wall-clock (T-4.3 `mdls` fallback budget).

### Step 2 — Missing-app error path (T-4.3 R-2)

- **Action:** Temporarily move the bundle out of the way: `sudo mv /Applications/Meeting\ Copilot.app /tmp/meeting-copilot-stash`. Re-run the same JSON-RPC `bridge_meeting_install` probe from step 1.
- **Expected:** Reply has `"installed":false`, a `downloadUrl` field pointing to a GitHub release URL, and a `message` of the shape `Install from <url>` (T-4.3 missing path). `isError` is **NOT** set — missing-install is a successful probe with a structured negative result, not an error envelope. Move the bundle back: `sudo mv /tmp/meeting-copilot-stash /Applications/Meeting\ Copilot.app` before continuing.
- **Pass criterion:** reply `installed: false` + `downloadUrl` + `message` present; no `isError` set; bundle restored.

### Step 3 — Version-mismatch warning (T-4.3 §3 fixture)

- **Action:** With the bundle in place, edit `package.json` and bump `"version"` from `"1.0.0"` to `"1.0.1"` (this is a **temporary** local edit for the test — discard it before step 12). Restart the MCP server (`pkill -f 'mcp-server'`; `bun run mcp-server &`). Re-run `bridge_meeting_install`.
- **Expected:** Reply has `"installed":true` with `"version":"1.0.0"` (the bundle) BUT `"expectedVersion":"1.0.1"` (the bumped server). The text content includes a phrase referencing the mismatch, e.g. `"version mismatch — bundle 1.0.0 vs expected 1.0.1"`. `isError` is NOT set (mismatch is a warning, not a hard fail — semver-compatible upgrades MAY still work). Discard the edit: `git checkout package.json` before continuing. Restart MCP server.
- **Pass criterion:** mismatch surfaces in both fields AND text content; `isError` not set; package.json restored before step 4.

### Step 4 — `bridge_meeting_start` via deeplink (T-4.4)

- **Action:** Privacy mode = **Cloud** (we'll exercise the picker in step 8). Send a JSON-RPC `tools/call` for `bridge_meeting_start` with arguments:

  ```jsonc
  {
    "contextPaths": ["/tmp/test-context.md"],
    "sttProvider": "deepgram",
    "model": "claude-sonnet-4-6",
    "privacyMode": "cloud",
    "meetingTitle": "Phase 4 browser test"
  }
  ```

  (Create `/tmp/test-context.md` with one paragraph of plain text first.) Watch the second terminal — `claude-bridge` log AND helper-daemon stderr — for the `meeting-copilot://start?...` deeplink + the spawned PID.

- **Expected:** Within 5 s the JSON-RPC reply contains `meetingId` (a UUID-shaped string), `pid` (an integer PID matching `pgrep "Meeting Copilot"`), `rpcSocket` (`~/.claude-bridge/meeting-copilot.sock`), and `uiUrl` (`http://127.0.0.1:7411/embed/transcript/<meetingId>?token=<uuid>`). The `Meeting Copilot.app` window opens with the title bar reading "Phase 4 browser test" and the privacy banner showing **Cloud**. The deeplink is observable in the system console (`log stream --predicate 'process == "Meeting Copilot"' --info` shows the URL parsed by the Tauri deep-link plugin). The query string is **fully percent-encoded** — open the deeplink string in the log and confirm no raw `&`, `'`, or `..` sequences leaked through.
- **Pass criterion:** reply within 5 000 ms; PID matches a running `Meeting Copilot` process; UI opens; deeplink query string round-trips through `URLSearchParams` (no shell injection observable in the system log); window title shows the supplied `meetingTitle`.

### Step 5 — Dashboard iframe embed loads + token auth (T-4.9)

- **Action:** Open the claude-bridge dashboard at `http://127.0.0.1:7878`. Navigate to the meeting-copilot agent panel; the dashboard should render an `<iframe src="<uiUrl>"></iframe>` pointing at the `uiUrl` returned in step 4. Refresh the dashboard if it doesn't pick up the new meeting automatically. Open browser devtools (Cmd-Opt-I) → Network → filter on `127.0.0.1:7411`.
- **Expected:** The iframe loads at `/embed/transcript/<meetingId>?token=<uuid>` with a 200 + `Content-Type: text/html` + `Referrer-Policy: no-referrer` + `Cache-Control: no-store`. The CORS preflight (if any) sees `Access-Control-Allow-Origin: http://127.0.0.1:7878` (not `*`). The transcript pane inside the iframe is read-only — no Stop button, no Settings sheet. Now manually craft a URL with a missing token (`http://127.0.0.1:7411/embed/transcript/<meetingId>` no `?token=`) and load it in a fresh tab; expect **401 Unauthorized**. Now craft one with a tampered token (replace the last char of the UUID); expect **401 Unauthorized**. Now load the legitimate URL but in a **non-`127.0.0.1:7878` origin** — easiest way: open a fresh tab at `data:text/html,<iframe src='<uiUrl>'></iframe>`; expect the iframe to render BUT the inner SSE connection to fail with **403 Forbidden** logged in devtools console (origin allow-list).
- **Pass criterion:** legitimate URL → 200 + correct headers; missing/tampered token → 401; mismatched origin → 403 on the SSE endpoint; transcript pane read-only.

### Step 6 — SSE live update (T-4.9 + T-4.5 subscribe)

- **Action:** With the iframe loaded from step 5, **speak 3 short sentences** into the mic with ~3-second gaps between each. Watch the iframe transcript pane.
- **Expected:** Each sentence appears in the transcript pane within < 1 second of finishing speaking (Deepgram chunk cadence). The order is preserved — sentence 1 appears before sentence 2 before sentence 3. The SSE event stream in devtools (Network tab → click the `events` request → EventStream sub-tab) shows `data:` lines tagged `transcript`. If a sentence triggers question detection (Phase 2 carry-forward — say a clear question like "What is our test plan for next quarter?"), an additional `question` SSE event fires, followed by an `answer` event a few seconds later as Sonnet streams. Total events visible across the 3 sentences: ≥ 3 transcript, ≥ 0 question (depends on phrasing), ≥ 0 answer.
- **Pass criterion:** each spoken sentence visible in the iframe within 1 s; event order preserved; SSE connection stays open for the full duration with no reconnect storm (occasional reconnects within 10 s are acceptable per T-3.3 carry-forward); `Referrer-Policy: no-referrer` header confirmed on the SSE response (devtools Network → Headers).

### Step 7 — Discovery auto-register (T-4.8)

- **Action:** Quit the running MCP server (`pkill -f 'mcp-server'`). Make a fresh backup of `~/.claude-bridge/config.json`. Now delete the `meeting_copilots` array entry for this MC version (or delete the whole array — the test exercises the empty-array path). Restart the MCP server (`bun run mcp-server &`).
- **Expected:** Within ~500 ms the MCP server's boot log (stderr) prints a line like `[discovery] registered meeting-copilots[0] version=1.0.0 path=...`. Inspect `~/.claude-bridge/config.json` — the `meeting_copilots` array now has exactly one entry, `{ version: "1.0.0", path: "<absolute repo path>", default: true }`. Other top-level keys (`daemon`, `dashboards`, `channels`) are byte-identical to the backup (the discovery code uses Zod `passthrough()` and `JSON.stringify` round-trip — no key reordering or value drift). Restart again WITHOUT modifying the config — the server boot log says `[discovery] meeting-copilots[0] already up-to-date — no write` (idempotent re-register, T-4.8 AC). Verify config mtime is unchanged on the second restart (`stat -f "%m"`).
- **Pass criterion:** first restart writes the entry; second restart does NOT write (mtime unchanged); other top-level keys preserved byte-identically.

### Step 8 — Privacy-mode refusal at MCP layer (T-4.4 R-2 + T-3.8 carry-forward)

- **Action:** Inside the running app, switch privacy mode to **Local-first** via the Settings sheet (this also auto-reverts STT to MLX per T-3.8). Now from the third terminal, send a JSON-RPC `tools/call` for `bridge_meeting_start` with explicit cloud STT:

  ```jsonc
  {
    "contextPaths": ["/tmp/test-context.md"],
    "sttProvider": "deepgram",
    "model": "claude-sonnet-4-6",
    "privacyMode": "local-first"
  }
  ```

- **Expected:** The reply arrives in < 100 ms with `isError: true` and `content[0].text` of the shape `PrivacyModeViolation: local-first mode does not allow deepgram STT — use mlx or switch to cloud mode.` (the closed error code set in `src/mcp/tools.ts`). **No new `Meeting Copilot.app` process is spawned** — `pgrep "Meeting Copilot" | wc -l` returns the same count as before the call. **No deeplink fires** — the system log shows no new `meeting-copilot://` URL in the time window of the call.
- **Pass criterion:** `PrivacyModeViolation` envelope; PID count unchanged; no deeplink in system log. This is the BLOCKING privacy-bypass test (R-2 in `INDEX.md` Risk Register).

### Step 9 — End-to-end Telegram → bridge → meeting-copilot path (Phase 4 exit criterion)

This step is the **gate** — Phase 4 cannot be "live-verified" without this passing.

- **Action:** From a Telegram chat connected to your local `claude-bridge` instance, send the message:

  ```
  /dispatch meeting-copilots summarize the last meeting
  ```

  (Or whatever the bot's exact dispatch syntax is per `claude-bridge` docs — adjust if the prefix is different.) Watch the claude-bridge daemon log for the JSON-RPC trace.

- **Expected:** Within 30 s of the Telegram message, the claude-bridge daemon log shows:
  1. Inbound message → bot handler.
  2. `tools/call bridge_meeting_status` (or `bridge_meeting_export({format:"markdown"})`) on `meeting-copilots`.
  3. The MCP server replies with the export markdown / status payload.
  4. Bot composes a Telegram reply containing the summary text.
  5. Reply lands in the Telegram chat.

  The summary references the meeting started in step 4 (or whichever was most recent). The end-to-end wall-clock from the Telegram send to the reply landing is < 30 s for the "summarize last meeting" prompt (longer if Sonnet is also re-summarizing on the fly; pure transcript dump is faster).

- **Pass criterion:** Telegram round-trip completes in < 30 s; reply contains transcript-derived text; no error toasts in the daemon log; the `bridge_meeting_status` and/or `bridge_meeting_export` JSON-RPC calls visible in the trace. This mirrors the T-4.10 vitest E2E (mocked stdio + mocked Tauri spawn) but with real Telegram + real daemon + real meeting state.

### Step 10 — `bridge_meeting_stop` + save-on-shutdown (T-4.6)

- **Action:** Send JSON-RPC `tools/call` for `bridge_meeting_stop` with `{ "meetingId": "<id from step 4>" }`. After the reply arrives, immediately re-run the SAME call (idempotent path test).
- **Expected:** First call: reply within 2 s with `{ exportedPath?, durationSec, questionCount }` — `durationSec` ~= step 4-to-step 10 elapsed, `questionCount` matches Phase-2 detector hits during the meeting. The Tauri app's status flips to `completed` (reflected in the past-meetings list on next app open). The SQLite row has `endedAt IS NOT NULL` (verify via `sqlite3 ~/Library/Application\ Support/com.meeting-copilot.app/meetings.db "SELECT id, ended_at, status FROM meetings WHERE id='<id>';"` → status `ended` / `completed`, ended_at is a recent timestamp). Second call: reply identical to first (same `durationSec`, same `questionCount` — idempotent recorded values), no second flush, no error.
- **Pass criterion:** first call lands within 2 s with structured payload; SQLite reflects `ended_at`; second call is bytewise identical (idempotent); no flush re-runs (transcript chunk count unchanged across the two calls).

### Step 11 — `bridge_meeting_export` × 4 formats (T-4.7)

- **Action:** With the meeting from step 4 stopped, send four `bridge_meeting_export` JSON-RPC calls, one per format:

  ```jsonc
  { "meetingId": "<id>", "format": "markdown" }
  { "meetingId": "<id>", "format": "json" }
  { "meetingId": "<id>", "format": "vtt" }
  { "meetingId": "<id>", "format": "srt" }
  ```

- **Expected:** Each call replies within 1 s with `{ path, sizeBytes }`. The four files exist at `~/.claude-bridge/meeting-copilot/exports/<id>.{md,json,vtt,srt}`. **Validate each format:**
  1. **Markdown**: `head <file>.md` shows a header, `> Privacy mode: <mode>` line, `> Cost: $<amount>` line, then `## Transcript` and `## Q&A` sections. Open in any markdown previewer; renders cleanly.
  2. **JSON**: `cat <file>.json | jq .` round-trips through `jq` without error; top-level keys include `meeting`, `chunks`, `questions`, `answers`.
  3. **VTT**: first line is `WEBVTT`; cue timestamps match the regex `\d{2}:\d{2}:\d{2}\.\d{3}`. Drag-drop into Safari over a video; loads as captions.
  4. **SRT**: cue indices `1`, `2`, …; timestamps match `\d{2}:\d{2}:\d{2},\d{3}`. Drag-drop into VLC; loads as subtitles.

  Now attempt a path-traversal: `{ "meetingId": "../../../etc/passwd", "format": "markdown" }`. Expect `isError: true` + `InvalidMeetingId: meetingId rejected: contains '..'.` envelope, **no file written** (`ls ~/.claude-bridge/meeting-copilot/exports/` shows no `..` or `passwd` entries). T-4.7 path-traversal guard test gate.

- **Pass criterion:** all 4 files exist; each validates against its format; markdown contains the privacy + cost header lines; path traversal blocked at the handler layer.

### Step 12 — Restart sanity + discovery idempotency

- **Action:** Quit the MCP server (`pkill -f 'mcp-server'`). Quit the Tauri app (Cmd-Q). Restart everything: open `Meeting Copilot.app`, then `bun run mcp-server &`. Send a `bridge_meeting_status` JSON-RPC call.
- **Expected:** The MCP server's boot log shows `[discovery] meeting-copilots[0] already up-to-date — no write` (re-register idempotency from step 7 still holds across this fuller restart cycle). `bridge_meeting_status` reply lists the meeting from step 4 with `status: completed`, `endedAt` populated. No surprise rows, no orphaned sessions. The helper-daemon socket at `~/.claude-bridge/meeting-copilot.sock` is recreated on this boot — listing `ls -la ~/.claude-bridge/meeting-copilot.sock` shows a fresh inode (compare to the inode from step 4 — should differ; T-4.5 stale-socket unlink). Restore `~/.claude-bridge/config.json` from the backup made in prerequisites (`cp ~/.claude-bridge/config.json.bak ~/.claude-bridge/config.json`); discard the temp test files: `rm /tmp/test-context.md`. Reset privacy mode to **Local-first** in the Settings sheet to leave the host in the privacy-default state for the next session.
- **Pass criterion:** discovery is no-op on second restart (mtime unchanged across the two restarts); status returns the completed meeting; socket file is fresh on boot (no stale-socket bind error); cleanup completed.

---

## Live Metric Tally

After step 12, fill in the live numbers and compare to the unit-test ground-truth:

| Metric | Sandbox value | Live value | Note |
|---|---:|---:|---|
| `bridge_meeting_install` round-trip (step 1) | < 50 ms (mocked) | ____ ms | T-4.3 mdls fallback budget < 500 ms |
| `bridge_meeting_start` reply → app open (step 4) | n/a (Tauri spawn mocked) | ____ ms | T-4.4 AC < 5 000 ms |
| Iframe load (step 5) | n/a (RTL EventSource mock) | ____ ms | T-4.9 AC; no hard budget but < 2 s nominal |
| SSE event-to-render latency (step 6) | n/a (mocked broadcast) | ____ ms | Phase-3 carry-forward; < 1 s per chunk |
| Telegram → reply round-trip (step 9) | n/a (mocked stdio E2E) | ____ s | **Phase 4 exit criterion < 30 s** |
| `bridge_meeting_stop` reply (step 10, first call) | n/a (mocked socket) | ____ ms | T-4.6 AC; no hard budget but < 2 s nominal |
| Export per format (step 11) | < 100 ms (mocked persist) | ____ ms × 4 | T-4.7 AC; no hard budget but < 1 s nominal |
| Privacy refusal (step 8) | < 5 ms (sync gate) | ____ ms | T-4.4 R-2; pre-spawn — should be < 100 ms |
| Discovery re-register (step 7, second restart) | n/a (memfs) | mtime unchanged Y/N | T-4.8 idempotency AC |
| Path-traversal blocked (step 11) | unit test (7 vectors) | Y/N | T-4.7 InvalidMeetingId envelope |

A live miss on **Telegram → reply round-trip** is a Phase 4 BLOCKER (the Phase 4 exit criterion). A live miss on **privacy refusal** is an immediate stop-the-line privacy bug. A live miss on **discovery idempotency** is a Phase-4.x ticket (file under `docs/tasks/phase-4.x/`). A live miss on the path-traversal block is a stop-the-line filesystem-safety bug.

## Pre-flight (carry-forward from Phase 1 / 2 / 3 sign-offs)

These are the **carry-forward host actions** that this Phase 4 plan *does not re-test* but does *depend on*:

- **P-1**: `cargo test --workspace` green on host. Phase 1 baseline 83, Phase 3 cumulative ~159 (Phase 1 + T-3.1..T-3.4 + T-3.7 `--features tts` + T-3.8). Phase 4 net new structural cargo tests: T-4.5 `+9 mcp_rpc.rs`, T-4.6 `+5 dispatch_stop_*` + `+3 mark_meeting_ended_*`, T-4.9 `+11 auth.rs` + `+14 embed_http.rs`. Total Phase 4 net new: **+42 cargo tests** (code-complete; live re-run blocked by sandbox `cargo` carry-forward).
- **P-2**: `cargo test --workspace --features tts` green (Phase 3 carry-forward — TTS feature flag).
- **P-3**: 30-minute STT stress (Phase 3 step 9). Phase 4 does NOT re-run this — the MCP layer does not touch the audio path; Phase 3 carry-forward is binding.
- **P-4**: Telemetry log forbidden-key audit (Phase 3 step 7). Phase 4 emits `mcp_tool_invoked` / `mcp_tool_error` events through the same scrubbed sink — same forbidden-key invariant applies. Verify after step 9: `grep -E '"(text|transcript|pcm|audio)"' ~/Library/Application\ Support/com.meeting-copilot.app/telemetry/*.log` returns 0 matches if telemetry is ON.

## Notes

- The mocked `child_process.spawn` vitest tests (T-4.4) and the in-memory `Duplex` MCP framing tests (T-4.2) are the per-task AC gates. This live re-verify is the **integration** check across the surfaces — it does not replace the unit gates, it complements them.
- If the deeplink from step 4 does not open the app, the most likely cause is **missing URL scheme registration** — the `tauri-plugin-deep-link.desktop.schemes` block in `src-tauri/tauri.conf.json` was not picked up by the bundle build. Fix: `bun tauri build` from a clean state, drag the resulting `.app` to `/Applications/`, launch once manually (this triggers macOS to register the URL handler), then re-run step 4. See `T-4.4-manual-verify-deeplink.md` for the full checklist.
- If the iframe (step 5) shows a CORS error in devtools console (red console line `Access to fetch at … has been blocked by CORS policy`), the most likely cause is the dashboard running on a non-default port. The allow-list is hardcoded to `http://127.0.0.1:7878` per T-4.9; if your `claude-bridge` is on a different port, update `crates/helper-daemon/src/embed_http.rs::CORS_ALLOWED_ORIGIN` and re-build the daemon. **Do NOT** widen the allow-list to `*` — that is the BLOCKING privacy regression in `INDEX.md` Risk Register R-3.
- If the Telegram E2E (step 9) hangs at the `tools/call` step in the daemon log, the most likely cause is the MCP server stdio framing being broken by stderr noise. Phase 4 reserves stdout for JSON-RPC and pushes all logs to stderr — verify by running `bun run mcp-server` interactively and confirming no `console.log` lines on stdout other than valid JSON-RPC frames.
- Reset privacy mode to **Local-first** + uncheck telemetry before exiting to leave the host in the privacy-default state for the next session.
- Cross-references for failure triage:
  - Install probe wrong → `T-4.3-review.md` + `src/mcp/handlers/install.ts` Info.plist parser.
  - Deeplink does not open app → `T-4.4-manual-verify-deeplink.md` + `src-tauri/tauri.conf.json` URL scheme block.
  - Status / stop reply hangs → `T-4.5-review.md` + `crates/helper-daemon/src/mcp_rpc.rs` socket binding.
  - Iframe 401 / 403 wrong → `T-4.9-review.md` + `crates/helper-daemon/src/{auth,embed_http}.rs`.
  - Discovery double-write → `T-4.8-review.md` + `src/discovery/bridgeConfig.ts` idempotent re-register branch.
  - Telegram E2E times out → `T-4.10-review.md` + verify the claude-bridge daemon's `tools/call` framing matches v1.0.4.
  - Privacy refusal does NOT fire pre-spawn → **STOP THE LINE** — privacy regression. `T-4.4-review.md` R-2 gate + `src/mcp/handlers/start.ts` `isSttProviderAllowed` call site.
  - Telemetry log contains transcript content → Phase 3 carry-forward stop-the-line. `T-3.9-review.md` + `src/telemetry/scrub.ts` `FORBIDDEN_KEYS`.
