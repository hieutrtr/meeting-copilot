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
