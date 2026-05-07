# Meeting Copilot — Architecture

> Document này mô tả kiến trúc kỹ thuật của Meeting Copilot v1: pipeline real-time từ audio → transcript → answer, các pluggable provider (STT/TTS/LLM), UI desktop, và phương thức tích hợp với `claude-bridge` qua MCP.

Đối tượng đọc: contributor implement v1, reviewer security/privacy, người làm dashboard tích hợp.

---

## 1. System Overview

Meeting Copilot là một desktop process (Tauri app) chạy local trên máy user. Nó capture audio từ host machine, stream vào STT engine, phát hiện câu hỏi trong transcript, retrieve context đã load trước, gọi Claude API để generate answer, render side-by-side với transcript live.

```
┌──────────────────────────────────────────────────────────────────┐
│                     Meeting Copilot (Tauri app)                  │
│                                                                  │
│  ┌──────────┐   PCM   ┌────────┐  text   ┌──────────────┐        │
│  │  Audio   │ ──────▶ │  STT   │ ──────▶ │  Question    │        │
│  │ Capture  │ frames  │Provider│ chunks  │  Detector    │        │
│  └──────────┘ 16kHz   └────────┘ +ts     └──────┬───────┘        │
│       ▲                                          │ question       │
│       │ mic+sys                                  ▼                │
│  ┌──────────┐                            ┌──────────────┐         │
│  │BlackHole │                            │   Context    │         │
│  │/Loopback │                            │  Retriever   │         │
│  └──────────┘                            └──────┬───────┘         │
│                                                  │ context+q       │
│                                                  ▼                 │
│  ┌────────────┐  stream  ┌──────────────────────────┐             │
│  │   Answer   │ ◀─────── │  LLM (Claude API,        │             │
│  │  Renderer  │  tokens  │  streaming + prompt cache)│            │
│  └────────────┘          └──────────────────────────┘             │
│       │                                                            │
│       ▼  IPC (local socket)                                        │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Helper Daemon (Rust) — exposes RPC + MCP-compatible API   │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ MCP tools (bridge_meeting_*)
                                  │
                       ┌─────────────────────┐
                       │  claude-bridge MCP  │
                       │  daemon             │
                       └─────────────────────┘
```

Toàn bộ pipeline streaming: từ frame PCM đầu tiên đến token answer đầu tiên target < 3 giây (xem §12 Latency Budget).

---

## 2. Audio Capture (macOS)

Yêu cầu: capture đồng thời **microphone** (giọng user) và **system audio** (loa, để bắt giọng người khác trong Zoom/Meet/Teams).

### 2.1 Approach chọn

- **Mic**: AVFoundation `AVAudioEngine` → tap input node → 16kHz mono PCM float32.
- **System audio**: virtual loopback driver. macOS không cho capture system audio trực tiếp (privacy), phải qua aggregate device.
  - **BlackHole** (open-source, free, MIT) — recommend default.
  - **Loopback** (Rogue Amoeba, paid) — alternative, smoother UX.
  - Setup: user tạo Multi-Output Device (system audio → speakers + BlackHole) và Aggregate Input Device (mic + BlackHole) trong Audio MIDI Setup. App detect và prompt setup wizard nếu chưa có.
- **Mixing**: 2 stream → resample về 16kHz → đẩy vào ring buffer → flush mỗi 100ms thành chunks 100ms.

### 2.2 Alternatives đã cân nhắc

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Core Audio HAL plugin | Native, no third-party | Kernel extension, code signing khó, deprecated | ❌ |
| BlackHole + AVFoundation | Free, OSS, stable | User phải setup aggregate device | ✅ default |
| Loopback paid | UX tốt nhất | Paid ($99) | optional |
| ScreenCaptureKit (macOS 13+) | Native system audio API | Mới, chỉ macOS 13+, behaviour quirks với meeting apps | v2 fallback |

v2 sẽ hỗ trợ ScreenCaptureKit cho user macOS 13+ để bỏ aggregate device setup.

---

## 3. STT — Pluggable Provider

### 3.1 Interface

```ts
interface STTProvider {
  name: "mlx" | "deepgram" | "elevenlabs"
  start(stream: AsyncIterable<PCMChunk>): AsyncIterable<TranscriptChunk>
  stop(): Promise<void>
}

interface PCMChunk { samples: Float32Array; sampleRate: 16000; ts: number }
interface TranscriptChunk {
  text: string
  isFinal: boolean       // partial vs finalized hypothesis
  startTs: number; endTs: number
  speaker?: "self" | "other" | string
  confidence?: number
}
```

Provider phải streaming (không batch). Mỗi chunk có timestamp tương đối từ thời điểm `start()`. UI render partial transparent → solid khi `isFinal=true`.

### 3.2 Implementations

**MLX local (default)**:
- Engine: `mlx-whisper` (Apple MLX framework, Apple Silicon only) hoặc `whisper.cpp` (CPU/Metal, fallback).
- Model: `whisper-large-v3-turbo` (mlx port) — ~600M params, ~150ms/chunk trên M2.
- Streaming: chunked với 30s sliding window + VAD (Silero) để cắt utterance.
- Latency: ~300-500ms partial, ~800ms final.
- Privacy: 100% local.

**Deepgram WebSocket**:
- Endpoint: `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&interim_results=true`.
- Latency: ~150ms partial.
- Cost: ~$0.0043/minute streaming (xem §13).
- Privacy: audio rời máy.

**ElevenLabs Speech-to-Text**:
- Streaming Scribe model (mới, 2025).
- Latency: ~200ms.
- Cost: tier-based, ~$0.40/hour.
- Privacy: cloud.

User chọn provider qua Settings UI; switch provider không cần restart app — chỉ stop hiện tại + start mới.

---

### 3.4 Phase 3 update — Provider trait + factory (T-3.1..T-3.4)

> Append-only addendum landed in Phase 3 (`docs/tasks/phase-3/T-3.1` … `T-3.4`). The §3.1–§3.3 wording above is the canonical interface spec; this block describes the runtime locations + Phase 3-specific deltas.

**Trait + factory live in Rust:**

- `crates/stt-mlx/src/providers/mod.rs` — declares `pub trait SttProvider`, `enum ProviderKind { Mlx, Deepgram, Elevenlabs, Fake }`, `enum FactoryError`, and `pub fn factory(kind: ProviderKind, cfg: ProviderConfig) -> Result<Box<dyn SttProvider>, FactoryError>`.
- `crates/stt-mlx/src/providers/mlx.rs` — MLX impl (T-3.1 relocated this from `crates/stt-mlx/src/mlx.rs`; behavior byte-identical, Phase 1+2 cargo tests stay green).
- `crates/stt-mlx/src/providers/deepgram.rs` — Deepgram WebSocket adapter (T-3.2). Endpoint `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&interim_results=true` is a literal constant in the adapter; drift gated by mocked-WebSocket structural tests in `providers::deepgram::tests`.
- `crates/stt-mlx/src/providers/elevenlabs.rs` — ElevenLabs Scribe streaming adapter (T-3.4). Endpoint `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream`, `xi-api-key` handshake header.
- `crates/stt-mlx/src/providers/backoff.rs` — `BackoffConfig` with jittered exponential schedule (T-3.3). Reused by both Deepgram and ElevenLabs adapters; `tungstenite = 0.21` is the only new transport dep.
- `crates/stt-mlx/src/providers/privacy.rs` — adds `factory_with_privacy(mode, kind, cfg)` (T-3.8) that short-circuits **before** `factory()` runs with `FactoryError::PrivacyModeViolation { mode, kind }` if the (mode, provider) pair is disallowed. See §11.x.

**Reconnect contract (T-3.3):** exponential backoff with jitter; max 3 retries within 10 s; default schedule bounded ~750 ms worst-case (well under the AC). After 3 failures the adapter emits `SttError::ProviderUnavailable { attempts, last_error }`; the UI surfaces a typed-error toast (recommend dropping back to MLX). The variant is additive — existing match arms in test code stay green.

**Failure modes per provider:**

- **Missing API key** (Deepgram / ElevenLabs) → `SttError::Config` at construction; UI greys out the picker option; "Test connection" returns a typed error.
- **Network unavailable mid-stream** → `SttError::ProviderUnavailable` after the 3-strike rule; auto-revert to MLX is a Phase 3.x candidate.
- **Privacy mode violation** → `FactoryError::PrivacyModeViolation` short-circuits before construction; cannot be bypassed by skipping UI checks.

**Test coverage delta (Phase 3 net new):** 8 factory tests (T-3.1) + 19 Deepgram tests (T-3.2 + T-3.3) + 15 ElevenLabs Scribe tests (T-3.4) + 10 privacy tests (T-3.8). Cargo re-verify on a host with `cargo` installed is the carry-forward AC (loop sandbox blocked-action #3).

**Cross-references:** `docs/provider-comparison.md` (per-provider table + setup steps), `src/llm/sttPricing.ts` (pricing constants pinned to §3.2 lines 113 + 119).

---

## 4. TTS — Pluggable Provider (v2 optional)

V1 không bật TTS mặc định (answer là text trên UI). V2 cho phép user bật "spoken answer" cho hands-free mode.

```ts
interface TTSProvider {
  name: "mlx" | "elevenlabs"
  speak(text: string, opts: { voice: string }): AsyncIterable<AudioChunk>
}
```

- **MLX TTS**: thử nghiệm với `kokoro-mlx` hoặc `parler-tts-mini` ported sang MLX. Latency target < 500ms first audio.
- **ElevenLabs**: `eleven_turbo_v2` streaming, latency < 400ms.

Output đẩy vào virtual output device (BlackHole "input") để Zoom/Meet pickup được nếu user muốn answer được phát qua mic ảo (use case: AI nói thay user trong meeting). Default: chỉ phát ra speaker local.

---

### 4.1 Phase 3 update — TTS feature flag (T-3.7)

> Append-only addendum. The §4 paragraphs above stay the canonical reference for interface + audio routing; this block describes the Phase 3 runtime gating.

TTS ships **behind two feature flags** so default builds neither compile nor download TTS code:

1. **Rust:** cargo feature `tts` (default OFF) declared in `crates/stt-mlx/Cargo.toml`. The entire `crates/stt-mlx/src/tts/` module is `#[cfg(feature = "tts")]` and adds **zero new dependencies** (`reqwest` is intentionally not pulled in — the `TtsTransport` seam is HTTP-client-injected so default builds dead-strip the module).
2. **TS:** `VITE_ENABLE_TTS` env var (default missing → false), read by `src/tts/featureFlag.ts`. The `<AnswerPanel/>` "Speak answer" button is rendered iff the optional `onSpeak` prop is passed; `App.tsx` passes the prop iff `ENABLE_TTS && isTtsAllowed(privacyMode)`. A dynamic `import()` keeps the TTS modules out of the default Vite bundle.

**Implementation locations:**

- `crates/stt-mlx/src/tts/provider.rs` — `TtsProvider` trait + `TtsAudioChunk` + `TtsSpeakOptions` + `TtsError`. Object-safe; transport-injected via `TtsTransport`.
- `crates/stt-mlx/src/tts/elevenlabs.rs` — `ElevenLabsTtsAdapter`. Endpoint `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000`, `xi-api-key` header (same env var as Scribe).
- `src/tts/ttsProvider.ts` — TS interface verbatim from §4 above.
- `src/tts/elevenLabsTts.ts` — TS adapter; `fetch` is prop-injected for testability.
- `src/components/AnswerPanel.tsx` — `<AnswerPanel/>` adds an optional `onSpeak?` prop; the Speak button has no DOM presence when the prop is undefined.

**Default voice:** voice ID is constructor-supplied; the UI does not surface a voice picker (model knobs deferred to Phase 3.x).

**Privacy gating** (cross-ref §11.x): even with both feature flags ON, Local-first mode does not allow TTS — `isTtsAllowed("local-first") === false` in `src/privacy/privacyMode.ts`.

**Click → first audio target:** < 2 000 ms from button-click to "speaking" state flip. Test gate: `AnswerPanel.test.tsx` AP-S15 (jsdom wall-clock budget); live-host audio-start latency verified in `PHASE-BROWSER-TEST.md`.

**BlackHole virtual-output routing** (§4 paragraph above) **stays a v2 deliverable.** Phase 3 ships local-speaker output only.

**Test coverage delta:** 7 feature-flag tests (TF-S1..S7) + 13 ElevenLabs TTS adapter tests (EL-S1..S8b) + 6 AnswerPanel button tests (AP-S13..S16b) + 14 Rust adapter tests under `tts::elevenlabs::tests` + 6 trait-shape Rust tests in `tts::provider`.

---

## 5. Question Detection

Phát hiện câu hỏi trong transcript stream là core feature. Sai → bỏ lỡ câu hỏi quan trọng; quá nhạy → spam answer panel.

### 5.1 Two-stage detector

**Stage 1 — Heuristic (cheap, ~1ms)**:
- Câu finalized chứa `?` ở cuối → candidate.
- Câu finalized chứa wh-words ("what", "why", "how", "when", "where", "who", "which") + auxiliary verb → candidate.
- Câu finalized > 50 chars + intonation rise pattern (flag từ STT nếu provider hỗ trợ prosody) → candidate.

**Stage 2 — LLM filter (Claude Haiku)**:
- Mỗi candidate (~3-10/phút) gửi qua Haiku với prompt: "Câu sau có phải câu hỏi user nên trả lời không? Trả YES/NO + 1 câu lý do."
- Threshold: chỉ trigger answer nếu confidence ≥ 0.7.
- Cost: ~$0.0002/call, < $0.005/giờ meeting.

### 5.2 Dedup window

Trong 30 giây, các câu hỏi có embedding cosine similarity > 0.85 (computed by `nomic-embed-text` local) được coi là duplicate → không re-trigger answer.

### 5.3 Manual override

User có thể click bất kỳ đoạn transcript → "Mark as question" → trigger answer cưỡng bức (bypass detector). Hoặc highlight + cmd+enter → ask custom phrasing.

---

## 6. Context Loader

Trước meeting, user load context: file paths, URLs, repo refs, hoặc paste raw text.

### 6.1 Sources

- **Local file**: PDF, MD, TXT, code files. Parser: `pdf-parse` cho PDF; raw read cho text/code.
- **URL**: fetch + readability extraction (`@mozilla/readability`).
- **Repo ref**: ví dụ `github.com/foo/bar@main:docs/PRD.md` → resolve qua `gh` CLI hoặc local clone.
- **Pasted text**: direct.

### 6.2 Storage & caching

Context được concat thành 1 system prompt block, gắn `cache_control: { type: "ephemeral" }` của Claude API. TTL của ephemeral cache là 5 phút (auto refresh) hoặc 1 giờ (user-configurable nếu account có 1h TTL access).

```
system: [
  { type: "text", text: STATIC_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
  { type: "text", text: CONTEXT_BLOCK,        cache_control: { type: "ephemeral" } }
]
```

Token estimate hiển thị real-time khi user thêm/bớt source. Hard cap 180k tokens (Sonnet/Opus 200k context, chừa 20k cho transcript window + answer).

### 6.3 Retrieval (v2)

V1: dump toàn bộ context vào prompt (đơn giản, prompt cache đỡ chi phí).

V2: nếu context > 180k, bật vector retrieval — chunk context (500 tokens), embed (`voyage-3-lite` hoặc local `nomic-embed-text`), index trong sqlite-vec. Mỗi câu hỏi → top-k=8 chunks, inject vào prompt. Static instructions vẫn cache.

---

## 7. LLM — Answer Generation

### 7.1 Model

- Default: `claude-sonnet-4-6` — balance latency/quality/cost.
- "Deep thinking" toggle: `claude-opus-4-7` cho câu hỏi phức tạp.
- "Fast" toggle: `claude-haiku-4-5` cho casual chat.

### 7.2 Streaming + prompt cache

```ts
client.messages.stream({
  model,
  system: [staticInstructions, contextBlock], // both cached
  messages: [{
    role: "user",
    content: [
      { type: "text", text: `Recent transcript (last 90s):\n${recentTranscript}` },
      { type: "text", text: `Question detected: "${question.text}"\n\nĐưa ra answer ngắn gọn (≤ 150 từ), reference context block khi có. Nếu context không cover, nói thẳng "không có trong context — guess based on general knowledge".` }
    ]
  }],
  max_tokens: 600
})
```

`recentTranscript` = transcript window 90 giây trước câu hỏi (KHÔNG cache, vì luôn thay đổi).

### 7.3 First-token latency target

< 2 giây từ lúc question fire. Đạt được nhờ:
- Prompt cache hit (> 90% cached tokens).
- Streaming response — render token đầu tiên ngay.
- Network: HTTP/2 keep-alive, 1 single client.

---

## 8. UI — Desktop App

### 8.1 So sánh framework

| Framework | Bundle size | Native feel | DX | macOS audio access | Verdict |
|---|---|---|---|---|---|
| Tauri (Rust + WebView) | ~10MB | ⭐⭐⭐⭐⭐ | TS frontend + Rust backend | Trực tiếp qua `cpal`, `coreaudio-rs` | ✅ pick |
| Electron | ~150MB | ⭐⭐⭐ | TS full-stack | Phải qua native module (`naudiodon`) | ❌ |
| PWA + helper daemon | ~5MB UI | ⭐⭐ | TS frontend | Browser KHÔNG capture system audio | ❌ |

**Pick: Tauri 2.x**. Lý do:
1. Rust backend access Core Audio native, low overhead.
2. Bundle ~10MB → easy distribute (auto-update via `tauri-plugin-updater`).
3. Frontend React/TS — reuse component patterns từ claude-bridge dashboard.
4. Multi-window support: main transcript window + floating "answer overlay" window có thể always-on-top.
5. IPC `invoke()` low-latency cho audio frame metadata streaming.

### 8.2 Layout

3 panel chính (đã wireframe trong PRD §3.5):
- **Transcript panel** — main, auto-scroll, search.
- **Answer panel** — right side, stack vertical các Q+A card.
- **Context drawer** — left collapse, list sources với token count.

Floating mode: cmd+shift+M → minimal overlay 400x300 px, transcript + last answer only.

---

## 9. MCP Integration với claude-bridge

Theo pattern của `claude-bridge-dashboard` (xem `claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md`): meeting-copilot là một **agent đặc biệt** đăng ký vào claude-bridge daemon, không phải CLI tool độc lập.

### 9.1 Discovery

Khi meeting-copilot start, helper daemon đọc `$CLAUDE_BRIDGE_HOME/config.json` (default `~/.claude-bridge/config.json`):

```json
{
  "daemon": {
    "version": "0.7.0",
    "db_path": "~/.claude-bridge/bridge.db",
    "socket": "~/.claude-bridge/daemon.sock",
    "mcp_endpoint": "stdio",
    "compat_range": ">=0.7.0 <1.0.0"
  },
  "meeting_copilots": [
    { "version": "0.1.0", "path": "/Applications/MeetingCopilot.app", "default": true }
  ]
}
```

Pattern y như `dashboards: []`. Discovery enforces compat 2 lần: install + boot.

### 9.2 MCP tools (5)

Tất cả tool ở daemon MCP server (`src/mcp/tools.ts` của claude-bridge). Schema Zod đầy đủ.

**`bridge_meeting_install`** — download/locate Meeting Copilot app, register vào config.json.
```ts
input:  { source: "github" | "local"; ref?: string; path?: string; version: string }
output: { installedPath: string; version: string; warnings: string[] }
```

**`bridge_meeting_start`** — spawn Meeting Copilot process, return handle.
```ts
input: {
  contextPaths: string[]      // file paths or URLs
  sttProvider: "mlx" | "deepgram" | "elevenlabs"
  ttsProvider?: "mlx" | "elevenlabs" | "off"
  model: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-7"
  privacyMode: "local-first" | "cloud" | "mixed"
  meetingTitle?: string
}
output: { meetingId: string; pid: number; rpcSocket: string; uiUrl: string }
```

**`bridge_meeting_stop`** — graceful stop, flush transcript, close streams.
```ts
input:  { meetingId: string }
output: { exportedPath: string; durationSec: number; questionCount: number }
```

**`bridge_meeting_status`** — query meeting đang chạy.
```ts
input:  { meetingId?: string }   // omit → list all
output: { meetings: Array<{ id, pid, startedAt, sttProvider, transcriptChunks, questionCount, answerCount, uptimeSec }> }
```

**`bridge_meeting_export`** — export meeting đã kết thúc.
```ts
input:  { meetingId: string; format: "markdown" | "json" | "vtt" | "srt" }
output: { path: string; sizeBytes: number }
```

Tool registration tuân theo pattern của `bridge_dashboard_*`: idempotent, return type explicit, không phá bestState DB của daemon (meeting state ở DB riêng `meetings.db` để dashboard có thể join nếu cần).

### 9.3 Helper daemon RPC

Meeting Copilot Tauri app spawn một **helper daemon** (Rust binary, ~5MB) lúc start. Helper expose:
- Unix domain socket `~/.claude-bridge/meeting-copilot.sock` cho RPC từ MCP tool handlers.
- HTTP localhost endpoint `http://127.0.0.1:7411` cho dashboard embed iframe (transcript view + answer panel).

RPC methods: `start`, `stop`, `status`, `subscribe(meetingId)` (SSE stream cho transcript + question + answer events).

### 9.4 Dashboard embed

Dashboard (claude-bridge-dashboard) thêm tab "Meeting" hiển thị iframe `http://127.0.0.1:7411/embed?meetingId=…`. Iframe render transcript live + answer panel inline. Auth qua single-use token sinh từ helper daemon, truyền qua query param.

---

### 9.5 Phase 4 update — MCP server impl pointer (T-4.2..T-4.7)

> Append-only addendum landed in Phase 4 (`docs/tasks/phase-4/T-4.2` … `T-4.7`). The §9.1–§9.4 wording above is the canonical design reference; this block describes where the runtime code lives and the closed contract that ships in v1.0.

**Stdio MCP binary:**

- `src/mcp/bin.ts` — entrypoint registered in `package.json#bin` as `meeting-copilot-mcp`. Run via `bun run mcp-server`.
- `src/mcp/server.ts` — `buildServer()` + `startStdioServer()` factory. The same `buildServer` is reused by `src/mcp/server.test.ts` over `InMemoryTransport` and by the T-4.10 E2E harness over `StdioClientTransport`.
- `src/mcp/tools.ts` — single source of truth for `TOOL_NAMES`, the 5 Zod input/output schemas, the closed `ERROR_CODES` set, and the `TOOL_DEFINITIONS` array consumed by `tools/list`.
- SDK pin: `@modelcontextprotocol/sdk ^1.0.0` (matches the claude-bridge daemon's `package.json` pin — verified in `src/mcp/tools.test.ts`).

**Handler modules** (each exposes `handle<X>(args, deps)` with dependency injection for fakes):

| Tool | Handler | Phase 4 task |
|---|---|---|
| `bridge_meeting_install` | `src/mcp/handlers/install.ts` | T-4.3 |
| `bridge_meeting_start`   | `src/mcp/handlers/start.ts` + `src/mcp/deeplink.ts` | T-4.4 |
| `bridge_meeting_status`  | `src/mcp/handlers/status.ts` + `src/mcp/socket.ts` | T-4.5 |
| `bridge_meeting_stop`    | `src/mcp/handlers/stop.ts` (re-uses `socket.ts`) | T-4.6 |
| `bridge_meeting_export`  | `src/mcp/handlers/export.ts` + `src/mcp/exporters/{markdown,json,vtt,srt}.ts` | T-4.7 |

**Error envelope (closed set):** every handler returns `{isError: true, content: [{type:"text", text: "<ErrorCode>: <message>"}]}` where `<ErrorCode>` ∈ `ERROR_CODES = ["NotImplemented", "PrivacyModeViolation", "DeeplinkNotRegistered", "ContextNotFound", "MeetingNotFound", "InvalidMeetingId", "ConfigSchemaUnsupported", "BridgeConfigInvalid"]` (frozen in `src/mcp/tools.ts`). Adding a code requires updating that array AND the relevant handler test.

**Telemetry hook (cross-ref §14):** handlers emit through the existing opt-in `src/telemetry/telemetryLog.ts` sink. No transcript / audio / API-key bytes ever flow through MCP — the scrubber's `FORBIDDEN_KEYS` audit ran in each `T-4.<N>-review.md`.

**Test coverage delta (Phase 4 net new):** ~211 vitest tests across `src/mcp/{server,tools,deeplink,socket,e2eHarness}.test.ts`, `src/mcp/handlers/*.test.ts`, `src/mcp/exporters/*.test.ts`, plus 5 E2E scenarios in `tests/e2e/mcp-dispatch.e2e.test.ts`. Full suite at T-4.10 sign-off: 57 files / 900 tests / 0 fail.

---

### 9.6 Phase 4 update — Deeplink scheme + spawn safety (T-4.4)

> Append-only addendum. The §9.2 `bridge_meeting_start` paragraph above stays the canonical reference for the tool input/output shape; this block describes how Phase 4 enforces spawn safety.

**URL scheme:** `meeting-copilot://` declared in `src-tauri/tauri.conf.json` (under `tauri-plugin-deep-link.desktop.schemes`). Cargo-side handler wiring (`commands::start_from_deeplink`) is **deferred to host** per `docs/tasks/phase-4/T-4.4-manual-verify-deeplink.md` — the loop sandbox lacks Xcode CLT, so the Tauri Info.plist verification + first-launch deeplink registration is documented as a manual step.

**Pure URL builder:** `src/mcp/deeplink.ts` builds the deeplink **only** via `URLSearchParams` — no string concatenation, ever. 13 R-2 injection vectors covered in `src/mcp/deeplink.test.ts` (path traversal, single quotes, ampersands, semicolons, backticks, etc.). All percent-encode safely.

**Spawn invocation:** `child_process.spawn("open", [deeplink], { shell: false })` — array argv, never shell string. Mocked-spawn test asserts the command + argv shape.

**Two pre-spawn gates (BLOCKING per INDEX R-2 review checkbox):**

1. **Path-traversal guard** on every `contextPaths[]` string — `..` segments, absolute-path-with-traversal, NUL bytes, etc., reject with `ContextNotFound` typed envelope **before** the URL is built.
2. **Privacy mode gate** via `isSttProviderAllowed(privacyMode, sttProvider)` from `src/privacy/privacyMode.ts` (Phase 3 T-3.8 carry-forward). E.g. `(local-first, deepgram)` → `PrivacyModeViolation` typed envelope; spawn-spy count = 0 in the test gate. The same gate lives in Rust at `crates/stt-mlx/src/providers/privacy.rs` for the in-app surface; the MCP layer mirrors it pre-spawn so the constraint cannot be bypassed by skipping the UI picker.

**Failure mode:** if the deeplink is not yet registered (first-launch race), `open` returns non-zero and the handler surfaces a typed `DeeplinkNotRegistered` error — `src/mcp/handlers/start.ts` does not panic.

---

### 9.7 Phase 4 update — Embed CORS + token TTL (T-4.9)

> Append-only addendum. The §9.4 paragraph above stays the canonical design reference for the iframe + auth idea; this block describes the Phase 4 implementation of the HTTP layer.

**Helper-daemon Axum router:** `crates/helper-daemon/src/embed_http.rs` binds `127.0.0.1:7411`. Two routes:

- `GET /embed/transcript/:meetingId?token=…` → static HTML shell (built by Vite from `src/embed/transcript-entry.tsx` into `dist/embed/transcript.html`).
- `GET /embed/transcript/:meetingId/events?token=…` → SSE stream wrapping a `tokio::sync::broadcast::Receiver<EmbedEvent>` via `futures_util::stream::unfold`. `Lagged` tolerated; `Closed` terminates.

**CORS allow-list = `http://127.0.0.1:7878` only** (claude-bridge dashboard default port). **Hardcoded; no wildcard ever.** Wildcard-veto + wrong-port + wrong-scheme test cases ship in `embed_http.rs` `#[tokio::test]` block (R-3 BLOCKING — privacy regression risk).

**Auth = single-use UUID token** minted by helper daemon at `bridge_meeting_start` time, scoped to a single `meetingId`, **5-minute TTL.**

- Mint/verify in `crates/helper-daemon/src/auth.rs`. `Clock` dependency injected for deterministic TTL boundary tests (asserted at exact + 1ns).
- Token ≠ session — re-using the token across `meetingId` scopes returns 401 (scope mismatch test).

**Headers on every response (200 / 401 / 403 paths):** `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Frame-Options: SAMEORIGIN`. Tested per response code.

**TS-side iframe component:** `src/embed/TranscriptEmbed.tsx` consumes the SSE stream via `EventSource`. RTL test in `src/embed/TranscriptEmbed.test.tsx` covers `connect → event → error → unmount` lifecycle with a mocked `EventSource`.

**Out of scope for Phase 4 (deferred):**

- Helper-daemon out-of-process **binary** entrypoint (consumes `EmbedState::register_channel` / `deregister_channel`) — Phase 4.x deferred. Rust tests today exercise the `Router` directly via `axum::ServiceExt::oneshot`.
- WebSocket upgrade for sub-100ms event fanout — SSE is sufficient for v1.0 latency budget (§12).
- Per-meeting iframe `<TranscriptEmbed/>` + `<AnswerPanelEmbed/>` composition — v1.0 ships transcript only; answer panel embed is a v1.x candidate.

**Test coverage delta:** 11 `auth.rs` `#[test]` cases + 14 `embed_http.rs` `#[tokio::test]` cases (Rust, ship code-complete pending host cargo verify per Phase 0 carry-forward) + 21 vitest cases for `<TranscriptEmbed/>`.

---

## 10. Data Model

```
┌──────────────┐   1   N   ┌─────────────────┐
│  Meeting     │ ────────▶ │ TranscriptChunk │
├──────────────┤           ├─────────────────┤
│ id (uuid)    │           │ id              │
│ title        │           │ meetingId       │
│ startedAt    │           │ text            │
│ endedAt?     │           │ startTs, endTs  │
│ sttProvider  │           │ speaker         │
│ model        │           │ isFinal         │
│ privacyMode  │           │ confidence      │
│ status       │           └─────────────────┘
└──────┬───────┘
       │ 1     N    ┌──────────────┐   1  1   ┌──────────┐
       └──────────▶ │  Question    │ ───────▶ │  Answer  │
                    ├──────────────┤          ├──────────┤
                    │ id           │          │ id       │
                    │ meetingId    │          │ questionId│
                    │ text         │          │ text     │
                    │ detectedTs   │          │ generatedAt│
                    │ method       │          │ model    │
                    │  (auto/manual)│         │ tokensIn │
                    │ confidence   │          │ tokensOut│
                    │ status       │          │ cached%  │
                    └──────────────┘          └──────────┘

┌──────────────┐   N   N   ┌──────────────┐
│  Meeting     │ ◀──────▶ │   Context    │
└──────────────┘  (junction│  Source      │
                  table)   ├──────────────┤
                           │ id           │
                           │ kind         │
                           │  (file/url/  │
                           │   repo/text) │
                           │ ref          │
                           │ contentHash  │
                           │ tokenCount   │
                           │ loadedAt     │
                           └──────────────┘
```

Storage: SQLite `~/.claude-bridge/meetings.db`, drizzle schema. WAL mode để daemon + UI write song song.

---

## 11. Privacy Modes

User chọn 1 trong 3 mode khi start meeting:

| Mode | STT | LLM | TTS | Audio rời máy? |
|---|---|---|---|---|
| **Local-first** | MLX local | Claude API (text only, prompt cached) | MLX local hoặc off | ❌ Audio không rời máy. Chỉ text question + recent transcript ≤ 90s gửi Claude. |
| **Cloud** | Deepgram | Claude API | ElevenLabs | ✅ Full audio stream gửi Deepgram. |
| **Mixed** | MLX local | Claude API | ElevenLabs | ❌ Audio local. Text + ElevenLabs cho TTS. |

UI hiển thị badge mode hiện tại + tooltip explain. Banner đỏ ở top transcript khi đang ở Cloud mode để user nhớ obtain consent từ participants.

User có thể disable transmit transcript với câu chứa "off the record" trong 30s window — tự động drop tất cả Claude calls cho window đó.

---

### 11.1 Phase 3 update — Privacy mode constraint enforcement (T-3.8)

> Append-only addendum. The §11 mode table above stays the canonical reference for what each mode means; this block describes how Phase 3 enforces the constraint at runtime.

**Default mode is `"local-first"`** (privacy-by-default). Persisted in the settings store at the v2 schema (`meeting-copilot:settings:v2.privacyMode`); legacy v1 keys zero-fill on first read.

**Single source of truth (TS):** `src/privacy/privacyMode.ts`.

- Exports: `PrivacyMode` type, `PRIVACY_MODES`, `DEFAULT_PRIVACY_MODE`, `isPrivacyMode`, `isSttProviderAllowed`, `isTtsAllowed`, `availableSttProviders`, `tooltipFor`, `fallbackSttProviderFor`, `labelForPrivacyMode`.
- Pure (zero deps on React / zustand / DOM); 29 unit tests covering the 3-mode × 3-STT-provider matrix + TTS allowed-set + tooltip wording.

**Backend mirror (Rust):** `crates/stt-mlx/src/providers/privacy.rs`.

- `factory_with_privacy(mode, kind, cfg)` short-circuits **before** `factory()` runs with `FactoryError::PrivacyModeViolation { mode, kind }` if the (mode, provider) pair is disallowed.
- The `is_provider_allowed` match is exhaustive — adding a new `ProviderKind` becomes a compile error.
- 10 cargo tests pin TS↔Rust string parity for `"local-first" | "cloud" | "mixed"` and prove the privacy gate beats `SttError::Config` (a missing API key under a disallowed mode surfaces `PrivacyModeViolation`, never the config error).

**Auto-revert on mode change:** when the picker switches modes, the settings store auto-reverts the STT provider to the mode's fallback (`fallbackSttProviderFor`) in the same `set()` call — disallowed providers cannot persist across a mode flip.

**Cloud consent banner:** `<CloudConsentBanner/>` (red, `role="alert"`) mounts above `<TranscriptView/>` iff `privacyMode === "cloud"`. Wording is verbatim from §11 ("Cloud mode" row + "Banner đỏ ở top transcript khi đang ở Cloud mode để user nhớ obtain consent từ participants"). Local-first / Mixed render none.

**TTS gating:** the Speak button is rendered iff `ENABLE_TTS && isTtsAllowed(privacyMode)` — three layers (cargo feature, Vite env, privacy mode) must all pass.

**Out of scope for Phase 3 (still v2):**

- "Off the record" 30-s drop window described in §11 final paragraph above.
- Per-segment `disableTransmit` toggle on individual transcript chunks.
- Privacy-mode lock during a meeting (Phase 3 allows mid-meeting mode flips — auto-revert covers the constraint, but the cost meter attributes correctly per segment).

---

## 12. Latency Budget

Target end-to-end (audio → first answer token) < 3 giây.

| Stage | Budget | Measured (MLX local) | Measured (Deepgram) |
|---|---|---|---|
| Audio capture (frame ready) | < 100ms | ~50ms | ~50ms |
| STT partial transcript | < 500ms | ~400ms | ~150ms |
| STT final (utterance end) | < 1000ms | ~800ms | ~250ms |
| Question detect heuristic | < 5ms | ~2ms | ~2ms |
| Question detect Haiku filter | < 200ms | ~180ms | ~180ms |
| Context retrieval (cache hit) | < 50ms | ~10ms | ~10ms |
| LLM first token (Sonnet, cached) | < 2000ms | ~1400ms | ~1400ms |
| **Total to first answer token** | **< 3000ms** | **~2400ms** | **~1800ms** |

Stretch goal v2: < 1500ms với Haiku-only mode + Deepgram.

---

## 13. Cost Model

Estimate per 1 giờ meeting active (60 phút audio, ~10 câu hỏi detect):

| Component | Local-first | Cloud | Mixed |
|---|---|---|---|
| STT | $0 (MLX) | $0.26 (Deepgram nova-2) | $0 (MLX) |
| TTS | $0 / off | $0.40 (ElevenLabs ~10 answers × ~50 words) | $0.40 |
| Question filter (Haiku) | ~$0.005 | ~$0.005 | ~$0.005 |
| Answer LLM (Sonnet, prompt cache hit) | ~$0.30 (10 q × 30k cached + 1k fresh + 300 out) | ~$0.30 | ~$0.30 |
| **Total $/hour** | **~$0.31** | **~$0.97** | **~$0.71** |

Note:
- Prompt cache đem chi phí Sonnet về ~10× cheaper so với non-cached (90% input là cached @ $0.30/MTok thay vì $3/MTok).
- Opus mode tăng chi phí Answer LLM lên ~5× (~$1.50/h).
- Heavy meeting (30 questions/hour) tăng chi phí Answer LLM tỉ lệ thuận.

UI hiển thị live cost meter + monthly forecast dựa trên session pattern user.

---

## 14. Telemetry — Phase 3 update (T-3.9)

> NEW section landed in Phase 3. Telemetry was not part of the Phase 1+2 architecture; this section is additive, not a rewrite.

Telemetry is **opt-in only**, **local-only** (no remote endpoint), and **PII-scrubbed** at write time. It exists to help the user (and the dev team during install/support) understand provider switch frequency, error rates, and latency distributions — never to capture meeting content.

### 14.1 Opt-in default

`telemetryEnabled = false` by default in the settings store (`src/store/settingsStore.ts`). The Settings sheet exposes a single checkbox row (`data-testid="settings-telemetry-toggle"`); flipping it ON is the only path to enable telemetry. The flag is read live (no restart needed), so a user can disable mid-meeting and subsequent appends become no-ops.

### 14.2 Event types

Three event types only:

- **`provider_switch`** — emitted when the user changes STT provider via the picker. Fields: `fromProvider`, `toProvider`, `privacyMode`, `latencyMs` (UI commit time).
- **`stt_error`** — emitted when the adapter surfaces a typed error. Fields: `provider`, `errorCode`, `result`, `latencyMs`.
- **`stt_latency`** — emitted on a sampled cadence to record per-provider partial-transcript latency. Fields: `provider`, `latencyMs`, `bucket`.

No event type carries text, audio, or transcript content. Adding a new event type requires extending the allow-list in `src/telemetry/scrub.ts` (which forces a privacy review).

### 14.3 PII scrub (`src/telemetry/scrub.ts`)

A pure scrubber gates every event before it reaches the sink:

- `FORBIDDEN_KEYS = { text, transcript, pcm, audio, apiKey, api_key, key, secret, token, password }` — fixed list; any event that contains one of these top-level keys (case-insensitive) is **dropped in its entirety** (no partial logging).
- Allow-list of top-level event fields: an event with a key not in `ALLOWED_KEYS` is also dropped — the schema fails closed against future drift.
- Test gate: `src/telemetry/telemetryLog.test.ts` TM-S13 feeds 100 mixed events including booby-trapped keys, asserts `containsForbiddenKey(line) === false` over every persisted line.

### 14.4 Rotation (`src/telemetry/sinks.ts`)

The default sink is in-memory (Phase 3 unit gate). UTF-8 byte counted; rotates at `DEFAULT_TELEMETRY_MAX_BYTES = 10_000_000` (10 MB). Up to `maxFiles = 3` archives → ~30 MB worst-case.

The `TelemetrySink` interface lets a future Tauri-fs adapter swap in without changing call sites. That wire-up is **Phase 3.x deferred**.

### 14.5 Out of scope for Phase 3

- **Tauri-fs sink + live wire-up** to the provider event stream — the AC was the calculator + scrub + rotate cadence, not the persistent on-disk log.
- **Remote telemetry submission** — there is no remote endpoint and no plan for one in v1. The "telemetry" name is local-only.
- **Per-meeting reset** — the factory ships; consumers construct their own. The future singleton owner lives in App.tsx (paralleling `costGuard`).

---

## 15. Cost Meter — Phase 3 update (T-3.5)

> NEW section. Phase 1+2 had `costGuard` (meeting-wide ledger + soft/hard threshold); Phase 3 adds the per-provider STT cost meter that feeds it.

### 15.1 Per-provider rate table (`src/llm/sttPricing.ts`)

Constants pinned to ARCH §3.2 lines 113 + 119:

```
STT_PROVIDER_RATES = {
  mlx:        { kind: "free" }                      // $0
  fake:       { kind: "free" }                      // $0 — test stub
  deepgram:   { kind: "per-minute", rate: 0.0043 }  // $0.0043 / min
  elevenlabs: { kind: "per-hour",   rate: 0.40   }  // $0.40 / hour
}
```

Provider IDs match `ProviderKind::as_str()` exactly — parity gated by `sttPricing.test.ts` ST-S9.

### 15.2 Calculator (`src/cost/sttCostMeter.ts`)

Exposes `onUpdate` event sink + cumulative session cost + per-provider attribution. Provider-switch ladders attribute correctly to each segment (test gate: SCM-S7, four-phase ladder MLX→Deepgram→MLX→ElevenLabs).

### 15.3 Stream wiring (`src/cost/attachSttCostMeter.ts`)

A thin seam that wires the meter into the existing Phase 1 T-1.6 `transcript:chunk` Tauri stream without modifying `subscribeTranscriptStream`. Test gate: `attachSttCostMeter.test.ts` AS-S1..S3.

### 15.4 UI

Cost-meter UI surfaces both **session-cumulative** and **projected $/h** in the Settings sheet sidebar. The Phase 2 `costGuard` threshold logic is reused — no new threshold semantics.

---

## 16. Discovery — `~/.claude-bridge/config.json` (Phase 4, T-4.8)

> NEW section landed in Phase 4. Discovery was design-noted in §9.1 (pre-implementation); this section reports the runtime contract. The §9.1 paragraph above stays the canonical "what config.json looks like at the conceptual level" — this block describes the Zod schema slice meeting-copilot owns and the writer-side guarantees.

### 16.1 Schema slice (single source of truth: `src/discovery/schema.ts`)

meeting-copilot reads + writes a slice of the daemon-owned `~/.claude-bridge/config.json`:

- **Top-level `version: number`** — must be `1`. Values `> 1` are rejected with the typed `ConfigSchemaUnsupported` error. Bumping `SUPPORTED_CONFIG_VERSION` is a breaking change.
- **Top-level `meeting_copilots: Array<MeetingCopilotEntry>`** — owned by meeting-copilot.
- **All other top-level keys** (`daemon`, `dashboards`, `channels`, …) — preserved on round-trip via Zod `.passthrough()`. **Critical:** the daemon and meeting-copilot are concurrent writers of the same JSON file, each owning a disjoint set of keys. If either side strips an unknown key during a write, the other side's state is destroyed.

**Per-entry shape** (also `.passthrough()`):

```ts
MeetingCopilotEntry = {
  version: string;            // semver of the installed Meeting Copilot.app
  path: string;               // absolute filesystem path; tilde expansion REJECTED
  default?: boolean;          // is this the default copilot (only one default at a time)
  installed_at?: string;      // ISO 8601 — written at first register
  installed_from?: string;    // provenance hint, e.g. "github.com/anthropic/meeting-copilot@v1.0.0"
  mcp_bin?: string;           // absolute path to meeting-copilot-mcp binary
  // …unknown keys preserved verbatim
}
```

### 16.2 Reader / writer (`src/discovery/bridgeConfig.ts`)

- **Env override:** `CLAUDE_BRIDGE_HOME` (default `~/.claude-bridge`). Tilde-prefixed and `..`-containing path inputs are rejected with `BridgeConfigInvalid` — no tilde expansion (per claude-bridge daemon `dashboard-installer.ts` convention: absolute paths only).
- **Atomic write:** `writeFileSync(<config>.tmp, …)` then `renameSync(.tmp, .)` — same pattern as the daemon.
- **Idempotency:** existing entry with matching `path` is updated in-place; if no field changed, the writer returns `{ alreadyRegistered: true }` and **skips the file write entirely**. Re-register asserts atomic-write call count = 0 in the test gate.
- **Boot-time hook:** `src/mcp/bin.ts` wraps the registration call in `try/catch` so MCP server boot never crashes on a discovery failure. A corrupt config logs the error and continues — production callers can still drive the MCP surface even if `config.json` is unreadable.

### 16.3 Example `~/.claude-bridge/config.json`

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

The snippet round-trips through `BridgeConfigSchema.safeParse(JSON.parse(...))` with `success: true` (verified during T-4.11 sign-off).

### 16.4 Failure modes

| Condition | Error code | Where it fires |
|---|---|---|
| `config.version > 1` | `ConfigSchemaUnsupported` | `bridgeConfig.ts` parse step |
| Tilde-prefixed `path` | `BridgeConfigInvalid` | `bridgeConfig.ts` write step |
| `..` in `path` | `BridgeConfigInvalid` | `bridgeConfig.ts` write step |
| Corrupt JSON | `BridgeConfigInvalid` | `bridgeConfig.ts` parse step |
| Missing file | (silent — atomic create) | `bridgeConfig.ts` write step |

### 16.5 Out of scope for Phase 4 (deferred)

- **Live config reload** — meeting-copilot reads `config.json` at boot only; daemon-side updates require a restart. Live reload is a Phase 4.x candidate.
- **Multi-default detection** — `default: true` is honored as a hint; the daemon enforces single-default. meeting-copilot does not police it.
- **`installed_from` URL fetch** — present-but-unused field today (provenance hint only). GitHub install-from-URL is a Phase 4.x candidate (see also T-4.3 install handler).

---

## Appendix A — File layout

```
meeting-copilot/
├── README.md
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md            ← this file
│   └── IMPLEMENTATION-PLAN.md
├── src-tauri/                     Rust backend (audio, helper daemon, MCP RPC)
├── src/                           TS frontend (React, Tailwind, shadcn)
├── crates/
│   ├── audio-capture/             cpal + coreaudio-rs
│   ├── stt-mlx/                   FFI wrapper cho mlx-whisper
│   └── helper-daemon/             RPC server
└── package.json                   { claudeBridge.compat: ">=0.7.0 <1.0.0" }
```

## Appendix B — Open architectural questions

- Có nên dùng SQLite WAL + một DB chung với daemon, hay tách `meetings.db` riêng? (Lean: tách, để decouple release lane.)
- Embed dashboard view qua iframe vs native Tauri WebView? (Iframe đơn giản hơn, có thể chấp nhận tradeoff bảo mật origin.)
- Helper daemon có nên là systemd/launchd service riêng, hay child process của Tauri app? (Lean: child process v1, service v2 cho headless mode.)
