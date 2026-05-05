# Phase 1 — MVP Local-only — Task Index

> Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 1 — MVP Local-only" (lines 42–68). Read-only spec.
> Stack lock (per plan + spike memo): **Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude Sonnet 4.6**.
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.

## Phase Goal (verbatim from plan)

> End-to-end demo: user mở app → load 1 PRD → bấm "Start Meeting" → nói vào mic → thấy transcript live → manual mark câu hỏi → AI trả lời. Chưa auto-detect, chưa multi-provider.

## Phase Exit Criteria (verbatim)

> User bên ngoài (1-2 reviewer) cài DMG, làm 1 meeting test, không cần dev hỗ trợ chạy được flow chính.

For this loop run we **demote the DMG/signing exit criterion to Phase 1.x** (deferred — see §"Loop renumbering" below). The loop's own exit gate becomes:

1. `bun test` + `cargo test` all green.
2. `bun run tauri dev` opens app, full golden path runs (Start → speak → see transcript → mark question → see streaming answer → close → reopen → transcript persisted).
3. `PHASE-1-COMPLETE.md` sign-off committed.

---

## Inputs Carried Forward From Phase 0

Three Phase-0 conditions land directly into Phase 1 task definitions (per spike memo §"Phase 1 readiness" + T-0.7 §4 C-1/C-2/C-3):

- **C-1** — `T-1.5b` (Silero VAD + `large-v3-turbo` upgrade) is **deferred from Phase 1**. Phase 1 ships `medium` MLX model only (per spike memo §"Stack decision"). T-1.5b stays in the Phase 1.x backlog; do not surface in MVP unless `medium` re-measure on M1 Pro 16 GB > 0.7 RTF.
- **C-2** — 1.7× M1 Max → M1 Pro scaling is rule-of-thumb, not measurement. **T-1.13 (this loop)** + plan T-1.12 (raw) are the empirical re-measure gate.
- **C-3** — cost AC = $0.015/warm-call advisory (not the $0.005 in original plan). Surface in T-1.10 review.

Three blocked user-actions from Phase 0 stay open (already documented in Phase 0 INDEX §"Known Gaps"):

1. `brew install blackhole-2ch` + Audio MIDI Setup (Multi-Output + Aggregate Device). **Blocks** runtime smoke test in T-1.3 / T-1.13. Code-path TDD continues with WAV fixtures.
2. `export ANTHROPIC_API_KEY=…`. **Blocks** T-1.10 live smoke; structural tests proceed against mocked SDK.
3. `rustup default stable` + `cargo install tauri-cli --version "^2"`. **Blocks** every `cargo test` and `bun run tauri dev`. Code-only tasks proceed; loop driver marks "code complete, hardware verify pending" per loop rule constraint.

---

## Loop renumbering vs raw plan (T-1.1 … T-1.13)

The raw plan's 13 tasks are re-sequenced by the loop driver to (a) insert a Rust-daemon scaffold step before audio capture, (b) split raw T-1.2 (capture + IPC in one step) into capture / chunker / event-bridge sub-steps so each one fits an atomic ≤ 1.5-day budget with a discrete TDD boundary, and (c) defer raw T-1.11 (Settings panel + keychain) and raw T-1.13 (DMG + notarization) to a Phase 1.x packaging cycle so the MVP demo can land first.

| Loop task | Raw plan | Notes |
|---|---|---|
| T-1.1 | raw T-1.1 | monorepo layout per ARCH App A + shared TS types (`TranscriptChunk`, `Question`, `Answer`, `Meeting`, `ContextSource`) |
| T-1.2 | *(loop-inserted, slice of raw T-1.2)* | Rust helper-daemon crate scaffold + Tauri command-stub bridge (no audio yet) |
| T-1.3 | raw T-1.2 (slice 1) | Audio capture via `cpal` mic-only; WAV-fixture-driven TDD; system-audio path stays a `cfg(feature = "blackhole")` stub |
| T-1.4 | *(loop-inserted)* | PCM ring buffer + 2-s sliding-window chunker (separate from capture for testability) |
| T-1.5 | raw T-1.5 | MLX whisper subprocess adapter behind `trait STTProvider` (per ARCH §3.1); WAV-fixture fed in test |
| T-1.6 | *(loop-inserted, slice of raw T-1.2)* | Tauri event bridge — emit `transcript:chunk` / `meeting:state` events from Rust to UI |
| T-1.7 | raw T-1.3 | React `TranscriptView` (virtualized list, auto-scroll, simple search) |
| T-1.8 | raw T-1.4 (slice) | `ContextLoader` for **single file** (PRD/MD/TXT) — drag-drop deferred, char-count proxy for token-count to avoid tiktoken dep churn in MVP |
| T-1.9 | raw T-1.8 + start/stop controls | `Start Meeting` / `Stop Meeting` buttons + `Mark as question` action on a transcript chunk |
| T-1.10 | raw T-1.9 | Claude streaming Q&A with two-block ephemeral cache (per ARCH §6.2/§7.2) — request shape is what T-0.5 already proved structurally |
| T-1.11 | raw T-1.10 | `AnswerPanel` streaming markdown render |
| T-1.12 | raw T-1.6 + T-1.7 | SQLite schema (`Meeting` / `TranscriptChunk` / `Question` / `Answer` / `ContextSource`) **and** persistence wiring, in one task |
| T-1.13 | raw T-1.12 | E2E wiring + smoke (manual on hardware where applicable; WAV fixture fallback otherwise) |

Deferred to **Phase 1.x backlog** (NOT in this loop, NOT a regression):

- raw T-1.11 — Settings panel + macOS Keychain API key storage. MVP reads `ANTHROPIC_API_KEY` from env directly; Settings UI + keychain land Phase 1.x.
- raw T-1.13 — DMG packaging + Developer ID signing + notarization. MVP exits at `bun run tauri dev`.
- spike-memo `T-1.5b` — Silero VAD + `large-v3-turbo` upgrade gate. Tracked in Phase 1.x backlog.

This loop ships **13 tasks** (T-1.1 … T-1.13). Each task gets `T-1.<N>-<slug>.md` (plan + AC + TDD plan + risk) and `T-1.<N>-review.md` (post-task self-review).

---

## Task Checklist (13 tasks)

- [ ] **T-1.1** — Monorepo layout per ARCH App A (`crates/audio-capture`, `crates/stt-mlx`, `crates/helper-daemon`) + `shared/` TS types package + workspace wiring. **AC:** `cargo build --workspace` succeeds; `bun run build` succeeds; `shared/` types importable from `src/`. Dep: T-0.8.
- [x] **T-1.2** — `helper-daemon` crate skeleton + Tauri command-stub bridge (no audio yet). Loop step narrowed scope to single `ping` smoke command (full `meeting_start`/`stop`/`status` deferred to T-1.9 where the state machine actually exists). **AC:** `#[tauri::command] ping` registered; `helper_daemon::ping() == "pong"` via Rust unit + Vitest IPC mock. Dep: T-1.1. **Outcome:** 6/6 vitest green; 3 new Rust tests + workspace wiring code-complete (cargo verify pending hardware).
- [x] **T-1.3** — Audio capture via `cpal` (mic-only); WAV-fixture-driven test. **AC:** Given a 16 kHz mono WAV fixture, the capture iterator emits the same PCM samples; live mic path documented as "hardware verify pending". Dep: T-1.2. **Outcome:** new `crates/audio-capture` member with `trait AudioSource` + `WavFileSource` (fixture) + `CpalMicSource` (lazy `start()` / `Drop`-based shutdown); 14 cargo tests added (3 source + 7 wav + 4 mic) — code-complete, hardware verify pending per blocked-action #3.
- [x] **T-1.4** — PCM ring buffer + 2-s sliding-window chunker. **AC:** unit test feeds 5 s of synthetic PCM, asserts ≥ 2 chunks of exactly 2 s window with correct sample-count + timestamps. Dep: T-1.3. **Outcome:** new `crates/audio-capture/src/ring.rs` (`RingBuffer` w/ drop-oldest) + `crates/audio-capture/src/chunker.rs` (`Chunker` + `ChunkerConfig` w/ mono mixdown + linear-interp resample to canonical 16 kHz / 2-s windows); 15 cargo tests added (5 ring + 10 chunker incl. drop-no-panic + Arc-tracer leak proof) — code-complete, hardware verify pending per blocked-action #3. Resampler carry-over formula `phase = pos - logical_len` validated via static trace (the alternative `pos - (logical_len - 1)` would compound 1-sample-per-call drift = ~112 ms over a 30-min meeting).
- [x] **T-1.5** — MLX whisper STT adapter behind `trait SttProvider` (per ARCH §3.1). Subprocess shell-out to `mlx-whisper`; JSON parse. **AC:** integration test feeds WAV fixture (1 short utterance, ASCII-only) → adapter yields ≥ 1 `SttSegment` with non-empty `text`; if `mlx-whisper` not on host, test marks `skip` with documented re-run. Dep: T-1.4, T-0.4. **Outcome:** new `crates/stt-mlx` member with `trait SttProvider` + `FakeStt` (deterministic, used by T-1.6/T-1.9/T-1.13 tests) + `MlxWhisperSubprocess` (production path; embedded `transcribe.py` via `include_str!`, structured exit codes mirroring T-0.4 `bench.py`); 17 cargo tests added (7 provider + 10 mlx incl. parser/builder factor-out + the soft-skipping `mlx_subprocess_transcribes_short_utterance` integration). Cargo feature `mlx-runtime` (default-on) gates the MLX module so headless CI without Python can `--no-default-features` and still get the trait + Fake. Code-complete; integration test soft-skips on this loop sandbox (sandbox python lacks mlx_whisper module — re-run by exporting `MLX_WHISPER_PYTHON=$(pwd)/experiments/T-0.4/.venv/bin/python`).
- [x] **T-1.6** — Tauri event bridge: stream `transcript:chunk` + `meeting:state` events from Rust to UI. **AC:** Vitest harness + Tauri mock listens for `transcript:chunk`, asserts payload schema matches `shared/` type; Rust unit emits N events from a fixture. Dep: T-1.2. **Outcome:** new `crates/helper-daemon/src/bridge.rs` (`EventBridge` + `EventSink` trait + `RecorderSink` + `TranscriptChunkEvent` + `MeetingStateEvent` + `MeetingStatus`, all `serde(rename_all = "camelCase")`); `src-tauri/src/lib.rs` `TauriEventSink` adapter; `src/hooks/useTranscriptStream.ts` (subscribe fn + React hook); `shared/fixtures/transcript_chunk.sample.json` canonical literal consumed by both sides. 6 cargo tests in bridge.rs + 1 type-level src-tauri assertion + 3 vitest tests = **6 + 1 + 3 = 10 net new** (cumulative vitest: 9, cargo: 52 — hardware-verify pending per blocked-action #3).
- [x] **T-1.7** — React `TranscriptView` component (virtualized list, auto-scroll, search input). **AC:** Vitest + Testing Library: render with 50 chunks, last chunk visible; type in search → matched chunks highlighted. Dep: T-1.1. **Outcome:** new `src/components/TranscriptView.tsx` (windowed list w/ fixed row-height + `OVERSCAN=5`; `<mark>`-wrapped case-insensitive search highlight that preserves original casing; `useLayoutEffect`-driven autoscroll keyed on filtered length); 6 vitest cases under per-file `// @vitest-environment jsdom` pragma covering render, autoscroll, append-rerender, filter+restore, highlight casing, and 1000-chunk virtualization cap. Cumulative vitest: **15** (9 prior + 6); `bun run typecheck` clean. RTL + jsdom land as `devDependencies` only — no runtime-bundle change.
- [x] **T-1.8** — `ContextLoader` for single file (PRD/MD/TXT). **AC:** click "Load file" → file path + char count + ~token-estimate (`chars/4` proxy) shown; state stored. Dep: T-1.1. **Outcome:** new `crates/helper-daemon/src/context.rs` (`read_context_file` + `ContextFile { path, content, charCount, estimatedTokens }` + `ContextError::{UnsupportedExtension, Io}` typed enum + `chars/4` ceil); `src-tauri/src/lib.rs` Tauri command `read_context_file` registered (stringifies error for IPC); `src/store/contextStore.ts` (zustand v5 slice — `source / content / error / loadFromPath / clear`); `src/components/ContextLoader.tsx` (input + Load + readout + `[role=alert]` error). 10 new vitest (5 store + 5 component) → cumulative **25** (15 prior + 10); 10 new cargo (8 context.rs + 2 src-tauri command tests) → cumulative **62** (52 prior + 10, code-complete, hardware verify pending per blocked-action #3). `bun run typecheck` clean. File-picker dialog deferred to T-1.9 (lands `tauri-plugin-dialog`); real `tiktoken` flagged for T-1.10 cost-AC re-check.
- [x] **T-1.9** — `Start Meeting` / `Stop Meeting` controls + `Mark as question` on chunk hover. **AC:** clicking Start → meeting state goes `listening`; clicking a chunk's "?" → emits `question:marked` with the chunk text; Stop → state `ended`. Dep: T-1.6, T-1.7, T-1.8. **Outcome:** front-end state machine (`useMeetingStore`: idle → active → ended → reset) + manual mark slice (`useQuestionStore.markFromChunks` defaults to last 3 chunks, newest-first ordering, falls back to `meetingId="unknown"` if no meeting active) + `MeetingControls` component (Start gated on loaded context source; Stop + Mark visible only while active; Restart visible only after ended) + `App.tsx` wiring `useTranscriptStream().chunks` into the controls. INDEX AC text said `"listening"` — renamed to `"active"` to match the `MeetingStatus` enum already shipping in `crates/helper-daemon/src/bridge.rs`. Per-chunk hover "?" affordance and Tauri-side `start_meeting`/`stop_meeting` IPC deferred (former → Phase 1.x polish, latter → T-1.13 audio pipeline wiring). 23 new vitest (8 meetingStore + 8 questionStore + 7 MeetingControls) → cumulative **48** (25 prior + 23); `bun run typecheck` clean; no new runtime prod deps (zustand v5 already landed in T-1.8).
- [x] **T-1.10** — Claude API client with prompt cache (two `cache_control: ephemeral` system blocks per ARCH §6.2/§7.2). Streams answer tokens. **AC:** mocked-SDK test asserts `system[0]/system[1]` both have `cache_control`, recent transcript on `messages[0].user` content **without** `cache_control`, byte-identical request body across 2 calls. Cost AC = $0.015/warm-call advisory (per spike-memo C-3). Dep: T-1.9. **Hardware-blocked**: live latency / cache-ratio AC pending `ANTHROPIC_API_KEY`. **Outcome:** new `src/llm/claudeClient.ts` (`askClaude(input, opts?) -> AsyncGenerator<AskClaudeEvent, AskClaudeResult>` w/ `MissingApiKeyError` synchronous gate + `DeltaQueue` push/pull bridge between SDK `.on("text", …)` and `for await` consumers + `(no recent transcript yet)` placeholder for AC-3 stability when transcript is empty) and `src/llm/pricing.ts` (Sonnet 4.6 constants ported from `experiments/T-0.5/src/pricing.ts` so the prod path doesn't reach into the spike). 21 new vitest (8 pricing + 13 claudeClient) → cumulative **69** (48 prior + 21); `bun run typecheck` clean; `@anthropic-ai/sdk@^0.40.0` added (matches T-0.5 spike pin). Code-complete; live latency / cache-ratio re-verify deferred to T-1.13 once `ANTHROPIC_API_KEY` is in env.
- [x] **T-1.11** — `AnswerPanel` UI: streaming markdown render + copy-button. **AC:** mock token-stream fed → answer area updates incrementally without flicker; markdown headings + lists render correctly; Copy button copies plain text. Dep: T-1.10. **Outcome:** new `src/components/AnswerPanel.tsx` (presentational; `react-markdown@10` for headings/lists/code with default-on raw-HTML stripping for the XSS gate; Copy button gated on `status="done"` with `Copied!` affordance + `navigator.clipboard.writeText` fallback; cache-hit badge gated on `cacheReadRatio > 0.5`; cost readout 4dp; paranoid `sk-ant-` redaction in error fallback) and `src/hooks/useAskClaude.ts` (request-id-gated cancellation + sync `MissingApiKeyError` capture into state + mid-stream error preserves partial text). `App.tsx` now drives `useAskClaude.ask()` off `useQuestionStore.questions[0]` + `useContextStore.content`. 21 new vitest (15 panel + 6 hook) → cumulative **90** (69 prior + 21); `bun run typecheck` clean; `react-markdown@^10.1.0` added (78 transitive packages).
- [x] **T-1.12** — Local persistence: SQLite via `tauri-plugin-sql` (or `rusqlite` if plugin install blocked). Schema: `Meeting`, `TranscriptChunk`, `Question`, `Answer`, `ContextSource` (per ARCH §10). **AC:** integration test: create meeting → insert 10 chunks + 1 Q/A → close DB → reopen → all rows present. Dep: T-1.1. **Outcome:** picked `rusqlite` (`bundled` feature, vendored libsqlite3) over `tauri-plugin-sql` because the cargo-side integration test required by INDEX §"TDD per task" needs DDL-level assertions the plugin's JS shim does not expose. New `crates/helper-daemon/src/repo.rs` (`Repo` w/ `Mutex<Connection>`, idempotent `CREATE TABLE IF NOT EXISTS` DDL for 5 tables + 1 junction, WAL + FK pragmas via `execute_batch`, `INSERT OR IGNORE` for the meeting↔context link, `serde(rename_all = "camelCase")` DTOs that mirror `shared/types.ts`). 15 new cargo tests added (DB-R1..R13 covering AC-1..AC-10 + 2 bonus: optional-fields-None round-trip + meetings ordered DESC). Cumulative cargo: **77** (62 prior + 15) — code-complete, hardware verify pending per blocked-action #3 (sandbox has no `cargo` binary). Vitest unchanged at **90**; `bun run typecheck` clean. Tauri command bindings (`save_meeting` / `load_meeting`) deferred to T-1.13 where the React side actually drives Stop→persist + reload→hydrate.
- [ ] **T-1.13** — E2E wiring + smoke. WAV-fixture fallback for the audio half if mic permission unavailable. **AC:** simulated run end-to-end (fixture → capture → chunker → STT → UI → mark question → mocked Claude stream → answer rendered → persisted → reload). 10-step manual `PHASE-BROWSER-TEST.md` documents the human-verified golden path on hardware. Dep: T-1.1 … T-1.12.

---

## Dependency Graph (ASCII)

```
                   ┌────────────┐
                   │  T-1.1     │  monorepo + shared types
                   │  layout    │
                   └─────┬──────┘
            ┌────────────┼────────────────────────────────┐
            ▼            ▼            ▼                   ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐         ┌──────────┐
      │  T-1.2   │ │  T-1.7   │ │  T-1.8   │         │  T-1.12  │
      │ daemon+  │ │Transcript│ │ Context  │         │  SQLite  │
      │ Tauri cmd│ │  View UI │ │  Loader  │         │ persist  │
      └────┬─────┘ └────┬─────┘ └────┬─────┘         └────┬─────┘
           │            │            │                    │
           ▼            │            │                    │
      ┌──────────┐      │            │                    │
      │  T-1.3   │      │            │                    │
      │  cpal    │      │            │                    │
      │ capture  │      │            │                    │
      └────┬─────┘      │            │                    │
           ▼            │            │                    │
      ┌──────────┐      │            │                    │
      │  T-1.4   │      │            │                    │
      │ chunker  │      │            │                    │
      │ +ring buf│      │            │                    │
      └────┬─────┘      │            │                    │
           ▼            │            │                    │
      ┌──────────┐      │            │                    │
      │  T-1.5   │      │            │                    │
      │ MLX STT  │      │            │                    │
      │ adapter  │      │            │                    │
      └────┬─────┘      │            │                    │
           ▼            │            │                    │
      ┌──────────┐      │            │                    │
      │  T-1.6   │      │            │                    │
      │ Tauri    │      │            │                    │
      │ event br │      │            │                    │
      └────┬─────┘      │            │                    │
           └────────────┴────────────┘                    │
                        ▼                                 │
                  ┌──────────┐                            │
                  │  T-1.9   │  Start/Stop + Mark-Q       │
                  └────┬─────┘                            │
                       ▼                                  │
                  ┌──────────┐                            │
                  │  T-1.10  │  Claude streaming + cache  │
                  └────┬─────┘                            │
                       ▼                                  │
                  ┌──────────┐                            │
                  │  T-1.11  │  AnswerPanel (markdown)    │
                  └────┬─────┘                            │
                       └────────────────┬─────────────────┘
                                        ▼
                                  ┌──────────┐
                                  │  T-1.13  │  E2E + smoke
                                  └──────────┘
```

Critical path: T-1.1 → T-1.2 → T-1.3 → T-1.4 → T-1.5 → T-1.6 → T-1.9 → T-1.10 → T-1.11 → T-1.13. Off-path parallelizable: T-1.7, T-1.8, T-1.12 (all depend only on T-1.1 → can land any time).

---

## Layout decision (ARCH App A canonical)

```
meeting-copilot/
├── src/                       React/TS frontend (already exists, Phase 0)
├── src-tauri/                 Tauri 2 host (already exists, Phase 0) — registers commands, embeds helper-daemon as a child
├── crates/                    NEW (T-1.1) — Cargo workspace member crates
│   ├── audio-capture/         cpal + (later) coreaudio-rs
│   ├── stt-mlx/               mlx-whisper subprocess wrapper (trait STTProvider impl)
│   └── helper-daemon/         meeting state + RPC + Tauri command implementations
├── shared/                    NEW (T-1.1) — TS-only types package (TranscriptChunk, Question, Answer, Meeting, ContextSource)
└── docs/
```

Notes:
- The user's prompt mentioned `app/` + `daemon/` + `shared/` "or layout per plan". ARCH App A is the explicit plan layout — pick it; `app/` ≈ `src/` + `src-tauri/`, `daemon/` lives inside `crates/helper-daemon/`. This avoids restructuring Phase 0's working scaffold.
- `crates/` will be a Cargo workspace; `src-tauri/Cargo.toml` becomes the workspace root (or a virtual workspace at repo root if the Phase 0 `Cargo.toml` is moved). T-1.1 makes the call.
- `shared/` is a thin `package.json` workspace (or just a `src/types/` folder if a Bun workspace is overkill for one consumer).

---

## TDD per task

Per loop rule 2 (TDD strict):

| Task | TDD harness | Notes |
|---|---|---|
| T-1.1 | Vitest + `cargo test` smoke | Confirm types compile + workspace builds |
| T-1.2 | `cargo test` Rust unit + Vitest IPC mock | Tauri command bridge integration test |
| T-1.3 | `cargo test` w/ WAV fixture | Hardware mic path documented; fixture covers code |
| T-1.4 | `cargo test` synthetic PCM | Pure unit test, deterministic |
| T-1.5 | `cargo test` integration (subprocess `mlx-whisper`) | If `mlx-whisper` missing, test = `skip` not fail |
| T-1.6 | Vitest IPC mock + `cargo test` event emit | Two-side schema parity check |
| T-1.7 | Vitest + Testing Library | Component render + interaction |
| T-1.8 | Vitest + Testing Library | File-load happy path + size readout |
| T-1.9 | Vitest + Testing Library + state machine assertion | Cover Start / Stop / Mark transitions |
| T-1.10 | Vitest with mocked Anthropic SDK | Live key gate stays in T-1.13 hardware verify |
| T-1.11 | Vitest streaming-render harness | Mock token-by-token feed |
| T-1.12 | `cargo test` SQL integration (in-memory `:memory:` SQLite) | Round-trip + reopen |
| T-1.13 | Vitest E2E + manual `PHASE-BROWSER-TEST.md` | Hardware verify pending where blocked |

---

## Outputs Per Task

Every task creates:
- `docs/tasks/phase-1/T-1.<N>-<slug>.md` — plan + AC + TDD plan + risk + mitigation
- Code under `crates/`, `src-tauri/`, `src/`, or `shared/` per layout decision above
- Tests alongside the code (`cargo test` / Vitest)
- `docs/tasks/phase-1/T-1.<N>-review.md` — self-review (test count, AC met, no over-eng, no secret leak, audio-buffer cleanup, streaming non-blocking)

Final phase outputs:
- `docs/tasks/phase-1/PHASE-BROWSER-TEST.md` — 10-step manual golden-path test
- `docs/tasks/phase-1/PHASE-1-COMPLETE.md` — sign-off

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's headline outcome (test count + AC verdict) appears next to the title. Final state must show all 13 boxes ticked before `PHASE-1-COMPLETE.md` is written.

Per-task git commits land on `main` (no push — user pushes manually post-phase). Commit type per loop rule 4: `feat` (UI / new feature), `build` (Rust crate / workspace plumbing), `test` (test-only commit if any), `docs` (review / index / browser-test), `chore` (config). Each commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
