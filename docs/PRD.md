# Meeting Copilot — Product Requirements Document

> Trạng thái: Draft v0.1 · Owner: Hieu · Last updated: 2026-05-05
> Companion: [README](../README.md) · [ARCHITECTURE](ARCHITECTURE.md) · [IMPLEMENTATION-PLAN](IMPLEMENTATION-PLAN.md)

---

## 1. Vision & Value Proposition

### 1.1 Problem statement

AI hiện đại (Claude, Cursor, GPT) sinh ra **quá nhiều content** với chất lượng cao: PRDs 15 trang, ARCHITECTURE doc 20 trang, code review dài, RFC chi tiết. Trong vòng vài tuần, một dev có thể "ship" 5–10 doc mà bản thân không đủ thời gian đọc lại. Khi vào meeting (design review, stakeholder sync, exec briefing), ngay cả **tác giả** cũng không nhớ hết chi tiết — chứ đừng nói reviewer.

Hệ quả thực tế:

- "Tại sao chọn tRPC?" → tác giả ngập ngừng dù lý do đã viết rõ trong ARCHITECTURE §3.
- "Cost tháng này bao nhiêu?" → PM không nhớ con số chính xác trong financial model.
- "Đã đụng tới legacy auth chưa?" → engineer mở 4 tab tìm trong khi cả room chờ.

Việc lục lại doc giữa meeting **vừa làm gián đoạn flow vừa khiến speaker mất uy tín**. Note-taking AI hiện có (Otter, Granola, Fireflies) chỉ giải quyết phần *sau* meeting (summary, action items) — không hỗ trợ realtime *trong* meeting.

### 1.2 Value proposition

Meeting Copilot là **desktop assistant chạy realtime trong meeting**, làm 4 việc đồng thời:

1. **Capture** audio từ máy host (mic + system audio) qua loopback driver.
2. **Transcribe** ra text live trên UI, latency < 1 giây.
3. **Detect** câu hỏi tự động bằng heuristic + LLM filter.
4. **Answer** ngay lập tức bằng Claude API streaming, dựa trên **context user load trước** meeting (PRDs, code, doc, link). Prompt caching giữ context warm trong 1h.

User chỉ cần **đọc** answer trên panel side-by-side với transcript — không cần mở doc giữa meeting. Meeting Copilot tích hợp với [claude-bridge](https://github.com/anthropics/claude-bridge) qua MCP, biến nó thành một "agent đặc biệt" có thể start/stop/status từ Telegram.

### 1.3 Differentiation

| Feature | Otter / Granola | ChatGPT Voice | Meeting Copilot |
|---|---|---|---|
| Live transcript trên UI | ✅ | ❌ | ✅ |
| Auto question detection | ❌ | ❌ | ✅ |
| Answer dựa trên context user-loaded | ❌ | ❌ | ✅ |
| Local-only mode (zero cloud audio) | ❌ | ❌ | ✅ |
| MCP integration với agent platform | ❌ | ❌ | ✅ |
| Post-meeting summary | ✅ | ❌ | Phase 5+ |

---

## 2. Target Personas

### 2.1 Persona A — "Engineer trong design review" (primary)

**Tên:** Linh, Senior Backend Engineer · 5 năm kinh nghiệm
**Context:** Vừa cùng Claude Code viết xong ARCHITECTURE.md cho dashboard mới (18 trang). Tuần sau có design review với 3 senior engineer khác, mỗi người sẽ challenge từng quyết định.
**Pain:** Linh viết doc bằng cách review-and-accept output của Claude. Khi bị hỏi sâu vào chi tiết (cache TTL, retry policy, schema migration order), Linh phải mở 3 tab cuộn tìm — vừa mất uy tín vừa làm chậm meeting.
**Need:**
- Load ARCHITECTURE.md + 5 PR diff làm context trước meeting.
- Khi peer hỏi "Why pick X over Y?", AI suggest answer trong < 5s với citation §section.
- Có thể disable AI khi muốn tự trả lời (manual mode).

### 2.2 Persona B — "PM trong stakeholder sync" (secondary)

**Tên:** Hà, Product Manager
**Context:** Quản lý 3 product line. Mỗi tuần có 4–5 stakeholder sync với leadership, engineering, sales. Tài liệu sản phẩm scattered trên Linear, Notion, Google Docs.
**Pain:** Bị hỏi "Cost tháng 4 cho feature X?", "Bao nhiêu user đã enable beta?", "Roadmap Q3 có còn item Y?" — số liệu nằm rải rác trong các doc đã đọc 2 tuần trước.
**Need:**
- Load Linear roadmap export + analytics dashboard CSV + monthly review doc làm context.
- Question detect không chỉ câu hỏi trực tiếp mà còn dạng "I'm curious about…", "Do we have data on…".
- Export transcript + Q&A sau meeting để paste vào meeting note.

### 2.3 Persona C — "Exec đi review project" (tertiary)

**Tên:** Quân, VP Engineering
**Context:** Mỗi quý review 8 project. Không có thời gian đọc 8 ARCHITECTURE doc dài — chỉ skim summary 10 phút trước mỗi review.
**Pain:** Trong review, muốn challenge dev về tradeoff nhưng không nắm sâu detail. Hỏi câu generic ("How does this scale?") rồi thấy không hỏi đúng điểm.
**Need:**
- Load tất cả doc của project trước review.
- Copilot gợi ý câu hỏi *Quân nên hỏi* (không phải answer) — dựa vào risk hoặc gap trong doc.
- Quick mode: chỉ hiện top 3 risk + top 3 question, không cần full transcript.

> **Persona C's "suggest question" mode** = stretch goal, không đưa vào v1.

---

## 3. User Stories (MoSCoW)

### Must-have (v1 MVP)

- **US-01 [Must]** Là engineer, tôi muốn capture audio từ system + mic đồng thời, để bắt cả mình và đồng nghiệp nói (qua Zoom/Meet).
- **US-02 [Must]** Là user, tôi muốn thấy live transcript scrollable, để theo dõi nội dung meeting kể cả khi mất focus.
- **US-03 [Must]** Là user, tôi muốn load file (PDF, Markdown, code) làm context trước khi start meeting, để AI có đủ tài liệu trả lời.
- **US-04 [Must]** Là user, tôi muốn thấy auto-detected question highlighted trong transcript, để biết AI đang xử lý câu nào.
- **US-05 [Must]** Là user, tôi muốn answer hiển thị side-by-side với transcript, để vừa nghe vừa đọc gợi ý.
- **US-06 [Must]** Là user, tôi muốn copy answer 1 click, để paste vào chat hoặc dùng làm script trả lời.
- **US-07 [Must]** Là user privacy-conscious, tôi muốn chọn local-only mode (MLX STT, no cloud audio), để audio không rời máy.
- **US-08 [Must]** Là user, tôi muốn pause/resume meeting bất kỳ lúc nào, để xử lý interrupt cá nhân.

### Should-have (v1 if time allows / v1.1)

- **US-09 [Should]** Là user, tôi muốn dùng Deepgram làm STT thay MLX, để có latency thấp hơn khi chấp nhận cloud.
- **US-10 [Should]** Là user, tôi muốn search trong transcript bằng keyword, để jump tới đoạn cụ thể.
- **US-11 [Should]** Là user, tôi muốn export meeting (transcript + Q&A) ra Markdown, để lưu vào meeting note.
- **US-12 [Should]** Là user, tôi muốn manual mark câu hỏi (select text + cmd+Q), khi auto-detect miss.
- **US-13 [Should]** Là user, tôi muốn xem citation cho mỗi answer (file + section), để verify nguồn.

### Could-have (v2)

- **US-14 [Could]** Là user, tôi muốn TTS đọc answer ra loa, để dùng tay khác.
- **US-15 [Could]** Là user, tôi muốn vector retrieval (top-k) khi context > 200KB, để không vượt cache budget.
- **US-16 [Could]** Là claude-bridge user, tôi muốn dispatch `bridge_meeting_start` từ Telegram, để bật copilot từ xa trước meeting.
- **US-17 [Could]** Là user, tôi muốn auto-summary cuối meeting với action items, gộp với note-taking pipeline.
- **US-18 [Could]** Là user, tôi muốn multi-speaker diarization (Speaker 1, 2…), để biết ai hỏi câu nào.

### Won't-have (v1)

- **US-19 [Won't]** Auto join Zoom/Meet/Teams meeting làm bot — v1 capture audio cục bộ, không impersonate user trong meeting platform.
- **US-20 [Won't]** Multi-language transcript song song (EN + VI cùng lúc) — v1 chọn 1 language tại 1 thời điểm.
- **US-21 [Won't]** Calendar integration auto-load context dựa vào event title — Phase 5+.

---

## 4. Goals & Success Metrics

### 4.1 Product goals

1. Một engineer load context, start meeting, được trả lời 1 câu hỏi đúng trong < 10s — **end-to-end mà không cần config thêm gì sau cài đặt lần đầu**.
2. Local-only mode hoạt động đầy đủ trên MacBook M-series, không phụ thuộc cloud STT.
3. MCP tool hoạt động với claude-bridge bot, dispatch start/stop từ Telegram.

### 4.2 Quantitative metrics

| Metric | Target v1 | Method |
|---|---|---|
| Transcript latency (audio in → text on screen) | **< 1s** p50, < 2s p95 | Timestamp probe trong dev mode |
| Question detection accuracy | **> 80%** F1 trên 50-câu eval set | Manual labeling |
| Question detection false positive rate | **< 15%** | Manual labeling |
| Answer first-token latency | **< 2s** p50 | API streaming probe |
| % câu hỏi được trả lời useful trong < 10s | **≥ 70%** | User rating thumbs up/down 50 câu |
| Crash-free hour rate | **> 99%** | Telemetry opt-in |
| Memory footprint (idle) | **< 800MB** | Activity Monitor |
| CPU usage trong meeting (M1) | **< 40%** sustained | Activity Monitor |

### 4.3 Qualitative goals

- "Tôi không phải mở doc giữa meeting nữa" — 3/5 dogfood user nói câu này sau 1 tuần.
- Setup từ download → first useful answer < 15 phút.

---

## 5. Non-goals (v1)

Để giữ scope MVP gọn:

- **Không** auto-summarization / action item extraction post-meeting (Otter đã làm tốt).
- **Không** calendar / Google/Outlook integration để auto-trigger.
- **Không** speaker diarization — chỉ raw transcript.
- **Không** multi-language song song; chọn 1 language tại 1 thời điểm.
- **Không** cloud-hosted version — desktop only.
- **Không** plugin marketplace cho 3rd-party context source.
- **Không** mobile app — chỉ desktop (macOS Apple Silicon priority).
- **Không** team / sharing feature — single-user app v1.
- **Không** record và lưu audio gốc; chỉ giữ transcript text (giảm storage + privacy).

---

## 6. Privacy & Safety

### 6.1 Privacy stance

Audio meeting là **dữ liệu cực nhạy cảm** (chứa identity, business strategy, IP, đôi khi customer data). Meeting Copilot chọn stance "**privacy-first by default**":

| Mode | Audio rời máy? | STT | LLM (answer) | Use case |
|---|---|---|---|---|
| **Local-only** (default) | ❌ Không | MLX (on-device) | Claude API (text-only request) | Sensitive meeting, default |
| **Cloud STT** | ✅ Có (chỉ STT provider) | Deepgram / ElevenLabs WSS | Claude API | Khi muốn latency thấp + transcript chính xác hơn |
| **Air-gapped** (v2) | ❌ | MLX | Local LLM (Ollama) | Maximum privacy |

> **Mặc định:** Local-only. User phải **opt-in explicit** mới chuyển sang Cloud STT.

### 6.2 Consent flow

- Trước meeting đầu tiên, app hiện modal nhắc: *"Meeting Copilot sẽ capture audio system + mic. Bạn có trách nhiệm thông báo và xin consent từ những người tham gia meeting theo law địa phương (GDPR, CCPA, EU AI Act, VN Decree 13)."*
- User phải tick checkbox "Tôi đã đọc và sẽ tự chịu trách nhiệm" trước khi enable mic recording.
- UI có **recording indicator đỏ luôn-on-top** khi đang capture, không thể tắt khi recording đang chạy.

### 6.3 Data retention

- Transcript lưu local SQLite, encrypt at rest bằng macOS Keychain key.
- Default retention: 30 ngày, sau đó auto-purge. User có thể "Delete now" hoặc "Keep forever".
- Context files **không copy** — chỉ lưu path. Nếu user xoá file gốc, copilot không còn truy cập.
- Telemetry opt-in only, không gửi transcript hay context content; chỉ aggregate metric (latency, crash, usage count).

### 6.4 Safety guardrails

- Answer phải có citation (file + section) khi trích dẫn context. Nếu LLM không tìm được citation, prefix answer bằng `⚠️ Không tìm thấy trong context — đây là general knowledge:`.
- "Hallucination guard": nếu LLM confidence < threshold (Haiku check), hide answer + show "Câu này tôi không có đủ context để trả lời".
- Không proactively suggest action ("hãy nói X"); chỉ answer khi có question detected.

---

## 7. Wireframes (ASCII)

### 7.1 Transcript view (main window, full meeting state)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● REC  00:12:34   Meeting: Dashboard Design Review        [⏸] [■]    │
├───────────────────────────────────────────┬──────────────────────────┤
│ TRANSCRIPT                          [🔍] │ AUTO Q&A           [⚙]  │
│                                          │                          │
│ [00:12:01] Linh: ...so I went with tRPC  │ ❓ Why pick tRPC?        │
│  for end-to-end type safety.             │   ↳ ARCHITECTURE §3.2   │
│                                          │   "Type safety + zero    │
│ [00:12:18] Reviewer: Why pick tRPC over  │    codegen step. REST    │
│  REST? We had a debate last quarter.     │    would need OpenAPI…"  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ❓DETECT │   [📋 Copy] [👍] [👎]   │
│                                          │                          │
│ [00:12:31] Linh: Good question, let me   │ ❓ Cost vs REST?         │
│  pull up the doc.                        │   ↳ ARCHITECTURE §3.5   │
│                                          │   (streaming…)           │
│ [00:12:34] Reviewer: Also, what about    │                          │
│  the cost difference vs gRPC?            │                          │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ❓DETECT │                          │
│                                          │                          │
│  [↓ scroll · 142 lines]                  │ [↓ 2 more questions]     │
└───────────────────────────────────────────┴──────────────────────────┘
 Mode: Local-only (MLX) · STT: 0.6s · Answer: 1.4s · CPU 32%
```

### 7.2 Question + Answer panel (zoomed)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ❓ Why pick tRPC over REST?                       Detected 00:12:18 │
│ Confidence: 92% · Source: auto-heuristic + LLM filter                │
├──────────────────────────────────────────────────────────────────────┤
│ ANSWER (Claude Sonnet 4.6, streamed)                                 │
│                                                                      │
│  Lý do chính trong ARCHITECTURE.md §3.2 "Type Safety":               │
│                                                                      │
│  1. End-to-end type safety không cần OpenAPI codegen step            │
│  2. Frontend infer types trực tiếp từ backend router                 │
│  3. Latency comparable (cùng dùng HTTP+JSON underlying)              │
│                                                                      │
│  REST không reject — nhưng team đã có 3 incident type-mismatch       │
│  trong năm trước (xem §3.2.4).                                       │
│                                                                      │
│  📎 Citations:                                                        │
│   • docs/ARCHITECTURE.md §3.2 (line 142-180)                         │
│   • docs/ARCHITECTURE.md §3.2.4 (incident log, line 220-235)         │
│                                                                      │
│ [📋 Copy markdown] [📋 Copy plain] [🔁 Regenerate] [👍 Useful] [👎] │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 Context loader (pre-meeting setup)

```
┌──────────────────────────────────────────────────────────────────────┐
│ NEW MEETING — Setup                                              [✕] │
├──────────────────────────────────────────────────────────────────────┤
│ Title: [ Dashboard Design Review                                  ] │
│                                                                      │
│ Audio source:    [✓] Mic       [✓] System audio (BlackHole 2ch)    │
│ Mode:            (●) Local-only  ( ) Cloud STT  ( ) Mixed           │
│ STT provider:    [ MLX whisper-large-v3-turbo ▾]                    │
│ LLM model:       [ Claude Sonnet 4.6 ▾]   Cache TTL: 1h             │
│                                                                      │
│ ── CONTEXT (3 items, ~48KB / 200KB budget) ─────────────────────── │
│ [✓] docs/ARCHITECTURE.md            18KB   md      [×]              │
│ [✓] docs/PRD.md                     12KB   md      [×]              │
│ [✓] PR-142.diff                     18KB   diff    [×]              │
│ [+ Add file]  [+ Add URL]  [+ Paste text]  [+ From git ref]         │
│                                                                      │
│ Language: [ English ▾]   Auto-detect questions: [✓ ON]              │
│ Privacy: ⚠️ Bạn có trách nhiệm xin consent từ participants.        │
│ [✓] Tôi đã đọc và đồng ý.                                           │
│                                                                      │
│                              [Cancel]  [Save draft]  [▶ Start ⌘↵]  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. Open Questions

1. **Question detection threshold:** dùng pure heuristic (regex `?` + wh-words) đủ không, hay luôn cần Haiku filter? Tradeoff: Haiku call mỗi 5s tốn ~$0.001/meeting, có acceptable?
2. **Context budget hard limit:** 200KB hợp lý cho prompt cache 1h, nhưng nếu user load 2MB code → strategy gì? Reject? Truncate? Vector retrieval?
3. **Whisper model size default:** large-v3-turbo (~600MB, accuracy tốt) vs medium (~250MB, nhanh hơn 2x). Default cho 16GB RAM machine?
4. **System audio capture trên macOS Sequoia:** Apple đã thêm `ScreenCaptureKit` cho system audio không cần BlackHole — dùng được chưa, hay vẫn cần BlackHole fallback?
5. **MCP integration scope:** copilot có cần expose live transcript stream qua MCP cho bot Telegram đọc, hay chỉ start/stop/export đủ?
6. **Multi-window:** 1 meeting at a time đủ chưa, hay cần support 2 meeting đồng thời (rare)?
7. **Pricing:** open-source free + cloud STT user tự pay (BYO key)? Hay có hosted plan? — Defer tới sau Phase 4.
8. **Failure mode UX:** khi STT crash giữa meeting → fallback cloud STT auto, hay show error và user manual switch?

---

> Tài liệu này sẽ được update khi có user feedback từ Phase 0 spike và Phase 1 dogfood. Mọi quyết định ảnh hưởng metric ở §4 phải reference ngược về story tương ứng ở §3.
