# Meeting Copilot — Implementation Plan

> **Mục tiêu:** Đi từ zero đến v1.0 production-ready trong **8-11 tuần** (full-time một dev). Plan chia 5 phase, mỗi phase có atomic tasks ≤ 1 ngày, acceptance criteria rõ, dependencies + risk note. Cuối doc có Risk Register top-5 và Cost Estimate (token + infra + dev time).

**Quy ước task:**
- `[T-x.y]` = task ID (Phase x, task y).
- **AC** = Acceptance Criteria (test pass = task done).
- **Dep** = Dependencies (task khác phải xong trước).
- **Risk** = rủi ro nội tại của task này.
- Effort: `S = ½ ngày`, `M = 1 ngày`, `L = 1.5 ngày` (max). Task nào ước tính > 1.5 ngày phải split nhỏ.

---

## Phase 0 — Spike & Feasibility (3-5 ngày)

**Mục tiêu:** Trước khi commit 2 tháng dev, prove 3 unknown lớn nhất bằng prototype throw-away. Output là **memo go/no-go** với số đo thật.

**3 unknown cần prove:**
1. Capture được mic + system audio đồng thời trên macOS (không cần kernel extension)?
2. MLX whisper streaming chạy real-time (RTF < 1.0) trên M1 Pro 16GB?
3. Claude streaming + prompt cache đạt latency first-token < 2s với context 20k token?

### Atomic Tasks

| ID | Task | AC | Dep | Effort | Risk |
|---|---|---|---|---|---|
| T-0.1 | Spike: BlackHole 2ch install + AVAudioEngine Swift script capture mic + system audio sang 2 file WAV | 30s recording, 2 file WAV mở được, không glitch | — | M | macOS permission prompt |
| T-0.2 | Spike: ScreenCaptureKit (macOS 13+) làm alternative cho BlackHole, đo latency capture | Compare BlackHole vs ScreenCaptureKit, viết note 1 trang | T-0.1 | M | API mới, doc thiếu |
| T-0.3 | Spike: chạy `mlx-whisper large-v3` trên 5 file audio mẫu (1, 5, 10 phút), đo Real-Time Factor | RTF < 1.0 trên ít nhất 3/5 sample, log số liệu | — | M | Model download 3GB |
| T-0.4 | Spike: streaming wrapper quanh MLX whisper, feed PCM chunks 250ms từ mic | First transcript chunk < 2s sau khi nói, end-to-end demo terminal | T-0.3 | L | MLX không có streaming API native |
| T-0.5 | Spike: Claude Sonnet 4.6 streaming với prompt cache 20k context, đo first-token latency | Average < 2s qua 10 lần chạy, cache hit rate > 90% trên call thứ 2+ | — | M | Cache TTL behavior |
| T-0.6 | Viết Spike Memo (1-2 trang): kết quả 3 prove, recommend stack (Tauri vs Electron, MLX vs Deepgram default) | Memo committed vào `docs/spike-memo.md`, có go/no-go cho mỗi unknown | T-0.1...0.5 | S | — |
| T-0.7 | Stakeholder review memo (self hoặc 1 reviewer) | Memo approved hoặc list pivot cần làm | T-0.6 | S | — |
| T-0.8 | Setup repo skeleton: Tauri scaffold, monorepo layout, CI placeholder | `cargo tauri dev` mở được window trống | T-0.7 | M | Toolchain install |

**Phase 0 deliverables:** Spike memo + repo skeleton + 3 throwaway prototype trong `experiments/`.

**Phase exit criteria:** Tất cả 3 unknown go = green. Nếu MLX không đủ nhanh → fallback Deepgram làm default Phase 1, MLX trở thành Phase 3.

---

## Phase 1 — MVP Local-only (2-3 tuần)

**Mục tiêu:** End-to-end demo: user mở app → load 1 PRD → bấm "Start Meeting" → nói vào mic → thấy transcript live → manual mark câu hỏi → AI trả lời. Chưa auto-detect, chưa multi-provider.

**Stack chốt phase này:** Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude API.

### Atomic Tasks

| ID | Task | AC | Dep | Effort | Risk |
|---|---|---|---|---|---|
| T-1.1 | Project structure: `app/` (Tauri), `daemon/` (Rust audio + STT), `shared/` (types) | `bun run dev` chạy app, daemon spawn được | T-0.8 | M | — |
| T-1.2 | Audio capture daemon: ScreenCaptureKit (mặc định) + AVFoundation mic, output 16kHz mono PCM stream qua Unix socket | Daemon listen socket, gửi PCM chunks 100ms, app subscribe nhận được | T-1.1 | L | Permission prompt UX |
| T-1.3 | UI: TranscriptView component (virtualized list, auto-scroll, search input) | 10k chunk vẫn scroll mượt 60fps, search highlight match | T-1.1 | M | Virtualization perf |
| T-1.4 | UI: ContextLoader component — drag&drop file, list display, total token count via tiktoken | Drop 5 file PRD, hiện size + token count, save vào state | T-1.1 | M | Token count Claude tokenizer khác |
| T-1.5 | MLX whisper integration: spawn `mlx-whisper` subprocess, feed PCM stream, parse JSON transcript output | Nói "hello world", thấy chunk hiện trong UI < 2s | T-1.2, T-0.4 | L | Subprocess IPC |
| T-1.6 | DB schema: SQLite cho Meeting + TranscriptChunk + Question + Answer + ContextItem | Migration chạy, insert/query test pass | T-1.1 | S | — |
| T-1.7 | Persist transcript: mỗi chunk insert vào SQLite, batch 1s | Kill app → restart → load lại transcript đầy đủ | T-1.5, T-1.6 | M | — |
| T-1.8 | Manual question marking: button "Mark as question" trên chunk hover | Click → chunk highlight + insert vào Question table | T-1.7 | S | — |
| T-1.9 | Claude API client với prompt cache: load context một lần, cache key = hash(context paths) | Call thứ 2 với same context → log "cache_read_input_tokens > 0" | T-1.6 | M | Cache eligibility (≥ 1024 token) |
| T-1.10 | AnswerPanel UI: stream tokens từ Claude, render markdown, copy button | Mark question → answer hiện streaming < 3s, markdown render đúng | T-1.8, T-1.9 | M | Streaming flicker |
| T-1.11 | Settings panel: API key input (keychain storage qua Tauri plugin), model picker | Reload app, key vẫn còn, không lưu plain text | T-1.1 | M | macOS keychain API |
| T-1.12 | E2E test thủ công: 10 phút meeting recording test, đo metric (transcript latency, answer latency) | Median transcript < 1s, answer first-token < 3s | T-1.10 | M | — |
| T-1.13 | Release build + DMG packaging + code signing (developer ID) | DMG mount, drag to Applications, mở chạy không Gatekeeper block | T-1.12 | L | Apple notarization |

**Phase 1 deliverables:** v0.1 DMG, demo video 5 phút, smoke test report.

**Phase exit criteria:** User bên ngoài (1-2 reviewer) cài DMG, làm 1 meeting test, không cần dev hỗ trợ chạy được flow chính.

---

## Phase 2 — Auto Question Detection (1-2 tuần)

**Mục tiêu:** Bỏ "manual mark", AI tự bắt câu hỏi từ transcript stream và generate answer trong < 10s.

### Atomic Tasks

| ID | Task | AC | Dep | Effort | Risk |
|---|---|---|---|---|---|
| T-2.1 | Heuristic detector: regex `\?$`, wh-words ("what/why/how/when/where/who/which"), modal ("can/could/would/should you") | Unit test 50 sample (25 question, 25 không), precision ≥ 0.7, recall ≥ 0.8 | T-1.5 | M | False positive |
| T-2.2 | Sliding window assembler: gộp transcript chunks thành "utterance" (silence > 800ms = boundary) | Test: 10 utterance từ 1 phút audio, boundary đúng > 80% | T-1.5 | M | Silence detection |
| T-2.3 | Haiku filter: gửi candidate utterance → Haiku 4.5 prompt "is this a meaningful question worth answering? yes/no + reason" | Latency < 500ms, agreement với gold label > 85% trên test set 100 | T-2.1, T-2.2 | M | Haiku cost (xem T-2.7) |
| T-2.4 | Dedup window: hash question text (normalized lowercase, strip punctuation), reject duplicate trong 60s | Lặp lại "what's the deadline?" 3 lần trong 30s → chỉ 1 answer generate | T-2.3 | S | Edge: paraphrase không dedup |
| T-2.5 | QuestionQueue: in-memory queue, max 1 concurrent answer generation, drop oldest nếu queue > 5 | Test stress 20 question/phút, không crash, drop log đúng | T-2.4 | M | — |
| T-2.6 | Answer auto-trigger: queue → Claude streaming → render vào AnswerPanel với badge "auto" | Question detected → answer xuất hiện trong < 10s end-to-end | T-2.5, T-1.10 | M | — |
| T-2.7 | Cost guard: track Haiku token usage per meeting, warning UI nếu > $0.50/hour | Counter chạy realtime, alert hiện đúng threshold | T-2.3 | S | — |
| T-2.8 | UX: question chip trong transcript (clickable, highlight tương ứng answer trong panel) | Click question → scroll answer panel + highlight | T-2.6 | M | — |
| T-2.9 | Settings: detector sensitivity slider (precision-recall tradeoff), enable/disable Haiku filter | Slider thay đổi → precision/recall log đổi, save persist | T-2.3 | S | — |
| T-2.10 | E2E test: 30-phút meeting recording (Loom hoặc real call), measure: % câu hỏi caught, % câu hỏi useful answer | ≥ 80% catch rate, ≥ 70% useful (manual judge) | T-2.8 | L | — |

**Phase 2 deliverables:** v0.2 với auto-detection, metric report.

**Phase exit criteria:** Trong test 30 phút meeting, ≥ 80% câu hỏi thật được detect, ≥ 70% answer được judge là "useful".

---

## Phase 3 — Pluggable Providers (1-2 tuần)

**Mục tiêu:** Cho phép user switch STT provider (MLX ↔ Deepgram ↔ ElevenLabs) và optional TTS, qua interface clean.

### Atomic Tasks

| ID | Task | AC | Dep | Effort | Risk |
|---|---|---|---|---|---|
| T-3.1 | Refactor: extract `STTProvider` trait (Rust) + factory pattern, MLX implementation move sang `providers/mlx.rs` | Tests Phase 2 vẫn pass, không regression | T-2.10 | M | Refactor risk |
| T-3.2 | Deepgram WebSocket adapter: send PCM, parse interim + final results, map sang TranscriptChunk | Demo: switch provider trong UI → câu nói lên transcript đúng, latency < 800ms | T-3.1 | M | API key mgmt |
| T-3.3 | Deepgram error handling: reconnect on disconnect, fallback prompt user nếu fail 3 lần | Pull network cable → reconnect tự động trong 10s | T-3.2 | M | — |
| T-3.4 | ElevenLabs STT adapter (Scribe API hoặc latest streaming endpoint) | Same demo như T-3.2 với ElevenLabs | T-3.1 | M | API maturity |
| T-3.5 | Cost meter UI: realtime $/hour theo provider current, total cost per meeting | Switch MLX → Deepgram → cost tăng đúng số liệu Deepgram pricing | T-3.2, T-3.4 | S | Pricing changes |
| T-3.6 | Settings: STT provider picker, API key per provider, "test connection" button | Click test → success/fail toast trong < 3s | T-3.2, T-3.4 | M | — |
| T-3.7 | TTS interface (optional, behind feature flag): `TTSProvider` + ElevenLabs implementation, button "Speak answer" | Click button → audio play < 2s sau khi answer xong | T-3.1 | M | Audio device routing |
| T-3.8 | Privacy mode picker: Local-only / Cloud / Mixed → constraint provider list (Local chỉ MLX) | Pick Local-only → Deepgram option disabled với tooltip | T-3.6 | S | — |
| T-3.9 | Telemetry opt-in: count provider switches, errors, latencies (local-only file, không gửi remote) | Log file rotate 10MB, không có audio/transcript content | T-3.5 | S | Privacy review |
| T-3.10 | Update docs ARCHITECTURE.md, viết provider-comparison.md | Docs reflect Phase 3 reality | T-3.7 | S | — |

**Phase 3 deliverables:** v0.3 multi-provider.

**Phase exit criteria:** Switch provider runtime không cần restart, ≥ 2 provider STT hoạt động ổn định trong 30-phút stress test.

---

## Phase 4 — MCP Integration với claude-bridge (1-2 tuần)

**Mục tiêu:** Meeting Copilot trở thành MCP tool, dispatch được từ Telegram qua `bridge`, transcript embed được trong claude-bridge dashboard.

### Atomic Tasks

| ID | Task | AC | Dep | Effort | Risk |
|---|---|---|---|---|---|
| T-4.1 | Đọc + reverse-engineer claude-bridge dashboard ARCHITECTURE.md, viết integration design 1 trang | Design committed, share với claude-bridge owner | T-3.10 | M | API thay đổi |
| T-4.2 | MCP server skeleton: stdio transport, register 5 tool placeholder | `mcp inspector` connect được, tool list hiện | T-4.1 | M | MCP SDK version |
| T-4.3 | Tool `bridge_meeting_install`: kiểm tra app installed (path `/Applications/Meeting Copilot.app`), version check | Call tool → return `{installed: true, version: "0.3.0"}` hoặc instruction install | T-4.2 | S | — |
| T-4.4 | Tool `bridge_meeting_start({ contextPaths, sttProvider, model })`: spawn app với deeplink `meeting-copilot://start?...` | App mở, load context, vào trạng thái listening | T-4.3 | L | Deeplink registration |
| T-4.5 | Tool `bridge_meeting_status`: query running daemon qua local socket, return current meeting state | Trong meeting → return `{state: "listening", chunks: 142, questions: 3}` | T-4.4 | M | Socket discovery |
| T-4.6 | Tool `bridge_meeting_stop`: gửi stop signal, lưu meeting kết thúc | Call → app dừng capture, DB row updated | T-4.5 | S | — |
| T-4.7 | Tool `bridge_meeting_export({ meetingId, format })`: export markdown / json / VTT | 3 format đều valid (markdown render đúng, VTT play subtitle được) | T-4.6 | M | — |
| T-4.8 | Discovery hook: meeting-copilot đọc `~/.claude-bridge/config.json` (nếu tồn tại) → auto-register vào dashboard agent list | bridge `list-agents` thấy `meeting-copilot--default` | T-4.7 | M | Config schema drift |
| T-4.9 | Dashboard iframe embed endpoint: `/embed/transcript/:meetingId` serve readonly transcript HTML | iframe load, display realtime updates qua SSE | T-4.8 | L | CORS, auth |
| T-4.10 | bridge dispatch test: từ Telegram bot gõ `dispatch meeting-copilot "summarize last meeting"` → trả lời chứa summary từ transcript | E2E test pass 3/3 lần | T-4.8 | M | — |
| T-4.11 | Docs: update README + ARCHITECTURE với MCP section + example bridge config | Docs có copy-paste config block hoạt động | T-4.10 | S | — |
| T-4.12 | v1.0 release: tag, GitHub release notes, DMG + Homebrew cask submission | Cask PR open, DMG download link live | T-4.11 | L | Notarization re-do |

**Phase 4 deliverables:** v1.0 với MCP integration, dashboard embed live.

**Phase exit criteria:** Từ Telegram → dispatch meeting-copilot → app start → user nói → transcript hiện trong dashboard iframe → câu hỏi tự detect → answer back về Telegram qua bridge notify. End-to-end < 30s setup từ Telegram.

---

## Risk Register (Top 5)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **macOS audio permission UX** — user reject Screen Recording / Microphone permission, app không hoạt động và không có cách recover gracefully | High | High | Onboarding wizard step-by-step có ảnh chụp; detect denied state → deeplink `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`; fallback: chỉ mic mode |
| 2 | **MLX performance trên non-M-series Mac** (Intel hoặc M1 base 8GB) — RTF > 1.0, transcript lag tích lũy, UX vỡ | Medium | High | Phase 0 benchmark trên 3 hardware; auto-detect chip → suggest Deepgram; document min-spec rõ trong README; failsafe: drop accuracy (whisper-small) trên chip yếu |
| 3 | **Tauri WebView quirks** (macOS WKWebView khác Chromium) — virtualized list lag, font render khác, IPC race | Medium | Medium | Phase 1 chọn library WebView-tested (TanStack Virtual); test trên 2 macOS version; có sẵn Electron fallback design (4-6 ngày extra nếu phải pivot) |
| 4 | **Prompt cache invalidation surprise** — user thay đổi context giữa meeting → cache miss → cost x10, latency x3 | Medium | Medium | Cache key hash bao gồm full context content; UI cảnh báo "thay context = mất cache, thêm $X"; cache stats panel debug; lock context once meeting start (mặc định) |
| 5 | **Deepgram cost overrun** — user để default Cloud mode, meeting 8-tiếng/ngày → $50+/ngày bất ngờ | Medium | High | Cost guard hard limit (default $5/meeting); soft warning $1; daily budget setting; default mode = Local-only sau Phase 3 (không phải Cloud); pricing display trong picker |

---

## Cost Estimate

### Token Cost (per hour meeting, ước tính)

| Mode | STT | Detection (Haiku) | Answer (Sonnet 4.6) | Total |
|---|---|---|---|---|
| **Local-only** | $0 (MLX) | $0 (heuristic only) | ~$0.30 (cached context 20k + 10 questions × 1k completion) | **~$0.30/h** |
| **Mixed** (local STT + cloud answer + Haiku filter) | $0 | ~$0.05 (Haiku, 30 candidates × 200 token) | ~$0.40 (more aggressive context refresh) | **~$0.45/h** |
| **Cloud** | $0.27 (Deepgram Nova-3 streaming, $0.0043/min × 60) | ~$0.05 | ~$0.40 | **~$0.72/h** |

**Heavy user assumption** (4h meeting/ngày × 22 ngày): Local-only ~$26/tháng, Cloud ~$63/tháng. Acceptable cho individual; warrant team plan ở scale.

### Infra Cost

- **Dev/test**: $0 (local Mac, free tier Anthropic + Deepgram trials).
- **Production**: $0 server-side (app desktop, không có backend). Domain + Apple Developer ($99/year) + code signing certs ($0 nếu dùng cá nhân).
- **Optional**: telemetry backend (Phase 5 stretch) ~$5-10/tháng (Cloudflare Workers + D1).

### Dev Time (full-time 1 dev)

| Phase | Estimate | Buffer (×1.3) |
|---|---|---|
| Phase 0 — Spike | 5 ngày | 7 ngày |
| Phase 1 — MVP | 15 ngày | 20 ngày |
| Phase 2 — Auto detect | 8 ngày | 10 ngày |
| Phase 3 — Providers | 8 ngày | 10 ngày |
| Phase 4 — MCP integration | 10 ngày | 13 ngày |
| **Total** | **46 ngày (~9.2 tuần)** | **60 ngày (~12 tuần)** |

Part-time (50%): nhân đôi = 24 tuần (~6 tháng).

### Decision Gates

- **Sau Phase 0**: go/no-go dựa trên 3 prove. Nếu MLX fail → Phase 1 default Deepgram, +3 ngày setup paid account.
- **Sau Phase 2**: nếu detection accuracy < 70% → kéo dài Phase 2 thêm 1 tuần tune prompt + heuristic, hoặc downgrade scope (manual + auto-suggest mode thay vì pure auto).
- **Sau Phase 4**: v1.0 launch. Phase 5+ (vector retrieval, multi-language, Windows/Linux port) là roadmap riêng, không trong plan này.
