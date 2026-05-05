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

## Supported Platforms

| Platform | STT Local (MLX) | STT Cloud | Status |
|---|---|---|---|
| **macOS Apple Silicon (M1+)** | ✅ priority | ✅ Deepgram, ElevenLabs | Phase 1 target |
| macOS Intel | ⚠️ slow (CPU only) | ✅ | Best effort |
| Linux x86_64 | ❌ MLX không support | ✅ | Phase 3+ |
| Windows | ❌ | ✅ | Phase 3+ (cần WASAPI loopback) |

UI built với Tauri (Rust + system WebView). Audio capture macOS dùng Core Audio + BlackHole/Loopback cho system audio, AVFoundation cho mic. Xem [ARCHITECTURE §2](docs/ARCHITECTURE.md) chi tiết.

## Documentation

- **[docs/PRD.md](docs/PRD.md)** — Vision, persona, user stories, success metrics, privacy posture, wireframes.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — System design: audio pipeline, pluggable STT/TTS providers, question detection, context loader với prompt caching, UI framework pick (Tauri vs Electron), MCP integration với claude-bridge, data model, privacy modes, latency + cost budget.
- **[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)** — 5 phase từ spike → MCP integration, atomic task ≤ 1 day, acceptance criteria, risk register, cost estimate.

## License

TBD (likely BSL 1.1 → MIT after 2 years, theo pattern của claude-bridge-dashboard).
