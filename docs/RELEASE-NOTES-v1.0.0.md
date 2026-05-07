# Meeting Copilot — v1.0.0 Release Notes

> **Version**: 1.0.0
> **Release date**: `2026-05-?? (operator stamps after notarization)`
> **Sign-off**: `docs/tasks/phase-4/PHASE-4-COMPLETE.md` (forward-ref — lands as final loop step before tag push)
> **Phase trail**: Phase 0 (spike) → Phase 1 (MVP) → Phase 2 (auto-detect) → Phase 3 (providers) → Phase 4 (MCP) — see each phase's `PHASE-<N>-COMPLETE.md` under `docs/tasks/phase-<N>/`.
> **Pinned upstream daemon**: `claude-bridge` v1.0.4 (snapshot taken at T-4.1 reverse-engineer; MCP SDK pin `@modelcontextprotocol/sdk ^1.0.0` shared).

---

## What is Meeting Copilot?

A macOS desktop assistant that runs realtime in meetings: it listens to mic + system audio, shows live transcript on screen, auto-detects questions in the conversation, and generates context-aware answers from PRDs, ARCHITECTURE docs, code diffs, or any markdown the user pre-loaded. It also exposes itself as an MCP tool to `claude-bridge`, so a Telegram bot can dispatch a meeting session, query its status, or export the transcript end-to-end without ever touching the laptop.

v1.0.0 is the first stable release. Pre-1.0.0 versions (0.x) were development snapshots with no API stability guarantees.

---

## Highlights — what shipped

### Phase 1 — Local-only MVP (sign-off: `docs/tasks/phase-1/PHASE-1-COMPLETE.md`)

- Tauri 2 + React + TypeScript shell — single-window app, virtualized transcript pane, settings sheet, manual Start/Stop/Save controls.
- Rust helper-daemon crate (`crates/helper-daemon`) — audio capture (cpal) + 2-second sliding-window PCM chunker + MLX whisper STT adapter behind a `SttProvider` trait.
- SQLite persist (`meetings.db`) — Meeting / TranscriptChunk / Question / Answer entities; same schema carries through to v1.0.
- Claude Sonnet 4.6 answer generator with markdown rendering.
- 104 vitest + 83 cargo tests — Phase 1 baseline.

### Phase 2 — Auto question detection (sign-off: `docs/tasks/phase-2/PHASE-2-COMPLETE.md`)

- Two-stage detector: heuristic (Stage 1, regex + utterance-window) + Haiku 4.5 LLM filter (Stage 2). Dedup window (60-second hash-based) prevents triple-fires on phrasing variations.
- Headline metric: **catch-rate 0.947 / useful-rate 0.889** (fixture-mode). AC margins +0.147 / +0.189 over plan target (0.80 / 0.70).
- Inline question chip + sidebar feed UX; manual + auto modes coexist.
- 408 cumulative vitest tests by phase end.

### Phase 3 — Pluggable providers (sign-off: `docs/tasks/phase-3/PHASE-3-COMPLETE.md`)

- `SttProvider` trait + factory pattern; runtime provider switch without restart.
- New STT adapters: **Deepgram** (WebSocket) + **ElevenLabs Scribe** (streaming HTTP). Reconnect/chaos handling for both.
- Optional ElevenLabs **TTS** (cargo feature `tts` + `VITE_ENABLE_TTS=true`, default OFF).
- Privacy mode constraint gate (`local-first` / `cloud` / `mixed`) — purely-functional check at every provider-init boundary.
- Per-provider cost meter — wall-clock $/min display, daily-budget setting, default Local-only after Phase 3 rollout.
- Opt-in telemetry log (scrubbed event sink, no transcript bytes).
- 602 cumulative vitest tests by phase end.

### Phase 4 — MCP integration (sign-off: forward-ref `docs/tasks/phase-4/PHASE-4-COMPLETE.md`)

- 5-tool MCP surface over stdio (`@modelcontextprotocol/sdk ^1.0.0`):
  - `bridge_meeting_install` — checks `/Applications/Meeting Copilot.app` Info.plist version + idempotent (no fs writes).
  - `bridge_meeting_start` — spawns app via `meeting-copilot://` deeplink, gates `sttProvider` through privacy mode, blocks path-traversal in `contextPaths`.
  - `bridge_meeting_status` — Unix-socket RPC into the helper daemon; lists running meetings or filters by `meetingId`.
  - `bridge_meeting_stop` — graceful flush + DB mark-complete; idempotent on already-stopped meetings.
  - `bridge_meeting_export` — markdown / json / vtt / srt; atomic write under `~/.claude-bridge/meeting-copilot/exports/`; path-traversal guard on `meetingId`.
- Discovery hook — auto-registers in `~/.claude-bridge/config.json` `meeting_copilots: []` slice. Idempotent re-register; rejects `config.version > 1`; atomic write.
- Helper-daemon HTTP+SSE iframe embed — `127.0.0.1:7411/embed/transcript/:meetingId?token=…` + `/events`. CORS allow-list = `127.0.0.1` only (no wildcard); single-use UUID token, 5-minute TTL, scoped to `meetingId`. `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + `X-Frame-Options: SAMEORIGIN`.
- E2E harness (`tests/e2e/mcp-dispatch.e2e.test.ts`) — spawns the real MCP child process, exercises 4 of 5 tools end-to-end through subprocess JSON-RPC; 3/3 deterministic runs.
- Discovery + iframe + dispatch all documented in README "MCP Integration" + `docs/mcp-tools.md` + ARCH §9.5/§9.6/§9.7 + §16.
- 900 cumulative vitest tests across 57 files at v1.0 launch.

### Cross-cutting wins

- Single privacy gate (`isSttProviderAllowed`) reused by both the UI Start button (Phase 3) and the MCP `bridge_meeting_start` tool (Phase 4). Cloud STT cannot be dispatched in local-first mode from any surface.
- Cost meter cumulative + privacy-mode badge embedded in every markdown export (T-4.7 spec + golden test).
- Telemetry sink scrubbed of transcript bytes; opt-in only.
- Atomic-write pattern shared between settings persist (Phase 2) + bridge config registration (T-4.8).

---

## Breaking changes

**None.** v1.0.0 is the first stable release.

Pre-1.0.0 versions were 0.x development snapshots with no API stability guarantees and should not be treated as production deployments. The MCP tool surface (`bridge_meeting_*`), the discovery `~/.claude-bridge/config.json` schema, and the SQLite `meetings.db` schema are now considered v1 stable — future minor versions will ship additive-only changes.

---

## Install matrix

| Channel | Prerequisite | Install command | Verify |
|---|---|---|---|
| **DMG (notarized)** | macOS 13+ on Apple Silicon (M1/M2/M3); BlackHole 2ch + Aggregate Device for system audio (see Phase 0 carry-forward below) | Download `Meeting Copilot_1.0.0_aarch64.dmg` from the GitHub release; double-click; drag to `/Applications` | `xcrun stapler validate /Applications/Meeting\ Copilot.app` → `The validate action worked!` |
| **Homebrew cask** *(operator submits PR; not yet on `homebrew-cask`)* | Homebrew installed; macOS 13+ Apple Silicon | `brew install --cask meeting-copilot` | `brew info --cask meeting-copilot` shows v1.0.0 |
| **Source build** | Bun ≥ 1.1; Rust toolchain 1.77+; tauri-cli; macOS 13+ Apple Silicon | `git clone <repo> && cd meeting-copilot && bun install && bun run tauri build --target aarch64-apple-darwin` | DMG at `src-tauri/target/release/bundle/dmg/Meeting\ Copilot_1.0.0_aarch64.dmg` |
| **MCP server only (headless)** | Bun ≥ 1.1; no Tauri toolchain needed | `bun install && bun run mcp-server --version` | Prints `1.0.0 (mcp 0.4.0-skeleton)` |

---

## MCP integration quick-start

Once the app is installed and at least one meeting has been recorded locally, register the MCP server in `claude-bridge`:

```jsonc
// ~/.claude-bridge/config.json
{
  "version": 1,
  "meeting_copilots": [
    {
      "name": "default",
      "version": "1.0.0",
      "path": "/Applications/Meeting Copilot.app",
      "default": true
    }
  ]
}
```

Then, from a `claude-bridge` agent, dispatch any of the five tools — see `docs/mcp-tools.md` for the full Zod input/output schemas + error envelope, and `README.md#mcp-integration-with-claude-bridge` for the verbatim copy-paste snippet plus three Telegram-style invocation examples.

End-to-end: from Telegram → claude-bridge → MCP `bridge_meeting_start` → Tauri app launch → user speaks → transcript streams into the helper-daemon SSE channel → claude-bridge dashboard iframe renders → `bridge_meeting_export` returns markdown back through the MCP RPC → Telegram reply. Setup time < 30 s once the cask is installed.

---

## Known issues / Phase 0 carry-forward

These ship as **acknowledged limitations** in v1.0.0; Phase 4.x or v1.1 follow-ups are tracked under `docs/tasks/phase-4/PHASE-4-COMPLETE.md` "Caveats".

### Phase 0 carry-forward (× 3)

1. **System audio capture requires BlackHole 2ch + Aggregate Device on macOS.** Tauri / cpal cannot tap system output directly; users must follow the BlackHole + Audio MIDI Setup procedure (linked in README quickstart). Without it, only mic audio is captured. Tracked since Phase 0 spike.
2. **Apple Silicon only.** MLX whisper inference targets `aarch64-apple-darwin`. Intel macs fall back to Deepgram or ElevenLabs (cloud) only — privacy mode `local-first` is effectively unusable on Intel. Documented in IMPLEMENTATION-PLAN.md hardware lock.
3. **Live re-verify deferred to host.** The loop sandbox has no `cargo` / `rustup` / `tauri-cli`; cargo tests are code-complete + structurally reviewed but not wall-clock-verified. Operator runs `cargo test --workspace` once on host before cutting the DMG. Same caveat shape as Phase 1/2/3 sign-offs.

### Phase 3 carry-forward (× 2)

4. **`DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` required for cloud STT.** No bundled credentials. Privacy mode = `local-first` works without keys (MLX-only).
5. **TTS feature flag is BUILD-TIME on Rust + RUNTIME on TS.** Both gates must hold (`cargo build --features tts` + `VITE_ENABLE_TTS=true`). Default OFF.

### Phase 4 deferred (× 4)

6. **Tauri-fs telemetry sink** — Phase 4 telemetry events go through the existing scrubbed sink (no transcript bytes); a Tauri-fs sink for desktop-only events is a v1.1 add.
7. **GitHub install-from-URL** — `bridge_meeting_install` returns a download URL only; auto-fetch + verify-signature is Phase 4.x.
8. **mdls fallback for Info.plist parse** — install handler currently relies on XML parse; `mdls -name kMDItemVersion` fallback for parse-corrupt plists is a v1.1 add.
9. **Embed BlackHole virtual-output routing** — iframe embed shows transcript only; piping audio out through the embed back to the dashboard is Phase 5.

### Open security review items

The Phase 4 review checklist enforced four blocking gates per task: deeplink injection (URL-builder uses `URLSearchParams` exclusively, never string concat); privacy gate fires pre-spawn (verified by spawn-spy count = 0 on `PrivacyModeViolation`); CORS allow-list = `127.0.0.1:7878` hardcoded (no wildcard); token TTL = 5 minutes single-use UUID. No outstanding security regressions identified at v1.0.0 cut. Phase 5 will add a third-party audit hand-off if the project goes external.

---

## Verification commands

For the operator, post-clone, before cutting the DMG:

```bash
# 1. TS tests + typecheck (fast — no native deps)
bun install
bun run typecheck            # tsc --noEmit, exits 0
bun test                     # 900 / 900 across 57 files (Phase 4 baseline)

# 2. Rust tests (host-only — needs cargo + rustup)
cargo test --workspace       # baseline 83 cargo tests + Phase 4 mocked-socket additions

# 3. MCP server self-check
bun run mcp-server --version # → "1.0.0 (mcp 0.4.0-skeleton)"

# 4. E2E harness (subprocess JSON-RPC; deterministic 3/3)
bun test tests/e2e/mcp-dispatch.e2e.test.ts

# 5. Tauri build (Apple Silicon only)
bun run tauri build --target aarch64-apple-darwin
# → src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg

# 6. Notarize + staple — see docs/release/DMG-INSTRUCTIONS.md
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg"

# 7. Local cask test (before homebrew-cask PR)
brew install --cask docs/release/HOMEBREW-CASK-TEMPLATE.rb
brew uninstall --cask meeting-copilot
```

---

## Acknowledgements + License

Built with **Claude Code (Opus 4.7)** under the loop driver convention. Every task in Phase 1+2+3+4 was implemented under the strict TDD + per-task code-review + per-task commit pattern, with the loop INDEX (`docs/tasks/phase-<N>/INDEX.md`) acting as the source of truth for dependency graph + acceptance criteria.

License: **MIT** — see `LICENSE` (placeholder; operator confirms before public release).

---

## Issue tracker

Bugs, feature requests, and Phase 5 roadmap items go to the project's GitHub issue tracker (URL omitted from this doc per CLAUDE.md "never generate URLs" rule — operator wires it in when publishing the release on GitHub).

---

## Companion docs

- `docs/release/DMG-INSTRUCTIONS.md` — operator codesign + notarize + staple checklist.
- `docs/release/HOMEBREW-CASK-TEMPLATE.rb` — drop-in cask formula draft + DO-NOT-SUBMIT comment block.
- `docs/tasks/phase-4/PHASE-4-COMPLETE.md` — Phase 4 sign-off (forward-ref; lands in loop step 14 before tag push).
- `docs/tasks/phase-4/PHASE-BROWSER-TEST.md` — 12-step manual browser/host test plan covering install + start + status + export + dashboard embed.
- `docs/mcp-tools.md` — 1-page MCP tool reference (5 tools).
- `docs/ARCHITECTURE.md` §9.5/§9.6/§9.7 + §16 — Phase 4 architecture addendum.
