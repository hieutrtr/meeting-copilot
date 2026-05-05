# Phase 1 — Manual Browser Test Plan (10 Steps)

> Loop step 15/16. Companion to `T-1.13-e2e-wiring.md` (vitest E2E) and `PHASE-1-COMPLETE.md` (loop step 16/16, sign-off).
> This document is the human-verified golden-path test. The vitest E2E in `src/__tests__/E2E.test.tsx` simulates the same flow against mocked Tauri + mocked Anthropic SDK; this manual run exercises the same code paths against **live mic + live `mlx-whisper` + live Anthropic API + live SQLite**.

**Stack lock**: Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude Sonnet 4.6 (per `docs/IMPLEMENTATION-PLAN.md` Phase 1 + `docs/spike-memo.md` §"Stack decision").

---

## Sandbox status (this loop)

`bun run tauri dev` was **NOT** executed on the loop sandbox this iteration. Reason: `which cargo` → exit 1 and `which rustup` → exit 1 (per Phase 0 INDEX §"Known Gaps" blocked-action #3). The Rust workspace cannot compile without the toolchain, so the Tauri dev server cannot start. The vitest E2E (`src/__tests__/E2E.test.tsx`) IS sandbox-runnable and lands at **104 green** — that harness is the regression gate this manual plan plugs into on a developer host.

This file is therefore the **manual-only** version of the plan. Every step assumes the operator has resolved the three Phase-0-blocked actions on a real macOS Apple-Silicon host.

---

## Tester

| Field | Value |
|---|---|
| Tester name | _______________________________ |
| Date / time | _______________________________ |
| Host model + RAM | M1 Pro / M1 Max / M2 / M3 — ____ GB |
| macOS version | _____________ |
| App version (`git rev-parse --short HEAD`) | _____________ |

---

## Pre-flight checklist (BEFORE step 1)

All five must be ✅ or the test will not start. These are the three Phase-0-blocked user actions plus two build-side prereqs.

- [ ] **P-1 — Rust toolchain installed.** `rustup default stable` exits 0; `cargo --version` prints `cargo 1.7x`+ ; `cargo install tauri-cli --version "^2"` succeeded once on this host. (Phase 0 blocked-action #3.)
- [ ] **P-2 — `bun install` clean.** Run from `meeting-copilot/` root: `bun install` exits 0. The lockfile (`bun.lock` or `bun.lockb`) does not change.
- [ ] **P-3 — `mlx-whisper` reachable.** `python -c "import mlx_whisper; print(mlx_whisper.__version__)"` exits 0 inside the `experiments/T-0.4/.venv` virtualenv. The first invocation on a fresh host downloads ~3.5 GB of HF weights for the `medium` model (~120–150 s on home broadband — pre-download by running `python -c "import mlx_whisper; mlx_whisper.transcribe('/tmp/silence.wav', path_or_hf_repo='mlx-community/whisper-medium-mlx')"` once before the demo). MLX runtime path is set via `MLX_WHISPER_PYTHON=$(pwd)/experiments/T-0.4/.venv/bin/python` if not on `$PATH`.
- [ ] **P-4 — `ANTHROPIC_API_KEY` exported.** `echo $ANTHROPIC_API_KEY | head -c 12` prints `sk-ant-api03` (or similar). The key is read by `src/llm/claudeClient.ts` synchronously at first `.ask(...)` call. Missing key → step 7 will surface `MissingApiKeyError` in the AnswerPanel — **this is acceptable as a soft-fail demo**, but mark step 7 as ⚠️ and note the key was unavailable.
- [ ] **P-5 — Microphone permission granted.** First `bun run tauri dev` launch on a fresh host triggers macOS Microphone permission prompt. **Approve it.** If you skipped — `Settings → Privacy & Security → Microphone → Meeting Copilot ✓`. Required for steps 4–6 (`cpal` mic capture).

### Optional but recommended (system audio):

- [ ] **P-6 — BlackHole + Multi-Output Device.** Phase 1 ships **mic-only** capture by default (per `T-1.3-audio-capture.md` AC), so this is not strictly required. However, a real meeting includes the remote participant's voice — for that you need: `brew install blackhole-2ch` + Audio MIDI Setup → Multi-Output Device (Built-in Output + BlackHole 2ch) + Aggregate Device (Built-in Mic + BlackHole 2ch). Without it, step 4 captures only your local microphone — the remote-participant audio is dropped. Acceptable for a Phase 1 demo with both speakers in the room.

### Caveats from Phase 0 spike memo (`docs/spike-memo.md` §"Phase 1 readiness"):

- **C-1 — Phase 1 ships `medium` MLX model only.** The `large-v3-turbo` + Silero VAD upgrade lives in the deferred `T-1.5b` task. If the host is M1 Pro 16 GB and `medium` measures > 0.7 RTF on this run, log it in step 5's notes — it triggers the T-1.5b re-measure gate.
- **C-2 — 1.7× M1 Max → M1 Pro scaling is rule-of-thumb, not measurement.** This manual run on M1 Pro 16 GB IS the empirical re-measure (per INDEX §"Inputs Carried Forward"). Capture the per-chunk transcribe latency from step 5's notes.
- **C-3 — Cost AC = $0.015/warm-call advisory** (not the $0.005 in original plan). Step 7's cost readout is the regression gate.

---

## Test environment setup (one-time, before step 1)

```sh
cd /Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot
bun install
bun run tauri dev
```

The first launch builds the Rust workspace (~2–4 min on M1 Pro) and opens a Tauri window. **DO NOT close the terminal** — `bun run tauri dev` streams Rust + Vite logs to stdout; copy the last 20 lines into the `Notes` field for any failed step.

Have ready:

- A short PRD or markdown file at a known absolute path (e.g. `/tmp/sample-prd.md`) with at least 200 chars of business-domain text. Suggested fixture: copy `docs/PRD.md` to `/tmp/sample-prd.md`.
- A quiet room or AirPods. Steps 4–5 require ~10 s of clear English speech.

---

## Step 1 — Open the app

**Action:** `bun run tauri dev` (already running). Wait for the Tauri window to appear — title bar reads `Meeting Copilot`.

**Expected:**
- Window opens within 10 s of "Vite ready" log line.
- Header reads `Meeting Copilot`.
- Four canonical sections render: Context loader, Meeting controls, Transcript view, Answer panel. (`<PastMeetings />` is the fifth, hidden if the count is zero.)
- Browser DevTools console (`Cmd-Opt-I` inside the Tauri window) shows **zero errors** and at most one warning (React StrictMode double-effect notices are acceptable).

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
___________________________________________________________________
___________________________________________________________________
___________________________________________________________________
```

---

## Step 2 — Load PRD context

**Action:**
1. Type the absolute path to your PRD file into the `Context loader` text input (e.g. `/tmp/sample-prd.md`).
2. Click `Load`.

**Expected:**
- The readout (`data-testid="context-readout"`) appears under the input within ~500 ms.
- Readout shows: file path, character count (e.g. `1247 chars`), and estimated token count (`chars/4` proxy — e.g. `~312 tokens`).
- No `[role=alert]` error appears.
- `Start Meeting` button transitions from `disabled` to `enabled` (cursor + color change). Phase 1 gates Start on a loaded context source — this is by design (`T-1.9-meeting-controls.md` AC).

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
___________________________________________________________________
___________________________________________________________________
```

---

## Step 3 — Click Start Meeting

**Action:** Click the `Start Meeting` button.

**Expected:**
- `meeting-status` testid (or visible status indicator) reads `active`.
- `Start Meeting` button hides; `Stop Meeting` and `Mark as question` buttons become visible.
- Mic indicator in macOS menu bar shows the orange dot (mic in use). If absent → `cpal` did not bind the input device — re-check P-5 (Microphone permission).
- `bun run tauri dev` terminal log shows the Rust-side `EventBridge::run_loop` started (look for `meeting:state` payload with `status: "active"`).

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
___________________________________________________________________
___________________________________________________________________
```

---

## Step 4 — Speak into the mic

**Action:** Speak ~10 seconds of clear English. Suggested script:

> "Hello, this is a test of the Meeting Copilot live transcription. The annual recurring revenue is twelve million dollars. What is the ARR?"

Speak at conversational pace. Pause briefly between sentences.

**Expected:**
- Transcript chunks begin appearing in the `TranscriptView` panel **within 2 s** of the first spoken word. The first chunk's appearance latency is the key SLO (`docs/PRD.md` §"Performance" target: < 2 s end-to-end first-token).
- Each chunk shows: text, timestamp range (`startTs` → `endTs`), and a `?` mark-as-question affordance on hover (Phase 1.x polish — may not yet be visible per T-1.9 outcome notes; acceptable to use the global `Mark as question` button instead).
- Chunks append in chronological order; the view auto-scrolls to the latest chunk (per `T-1.7-transcript-view.md` AC).
- No flicker, no chunk reordering, no duplicate chunks.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:** First-chunk latency: _____ ms (target: < 2000 ms). Per-chunk transcribe latency observed: _____ ms (informs C-1/C-2 RTF re-measure).

```
___________________________________________________________________
___________________________________________________________________
___________________________________________________________________
```

---

## Step 5 — Verify live transcript renders < 2 s

**Action:** Verify timing from step 4 — measure with a stopwatch (or eyeball the `data-startTs` attribute against the system clock when the chunk first appears).

**Expected:**
- First chunk visible < 2 s after first spoken word.
- Subsequent chunks visible < 1 s after end-of-utterance (steady-state target).
- If > 2 s on first chunk on M1 Pro 16 GB → C-1 trigger fires (log it; this gates the T-1.5b stretch task). On M1 Max 64 GB the threshold is more like < 1 s; > 1 s is the warning bar.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
First-chunk latency:    _______ ms
P50 chunk latency:      _______ ms (eyeball over 5 chunks)
Worst-case RTF:         _______ (compute as transcribe_ms / chunk_window_ms; target < 0.7)
___________________________________________________________________
___________________________________________________________________
```

---

## Step 6 — Mark a chunk as question

**Action:** Click the `Mark as question` button (or the `?` affordance on the most recent chunk that contains a question — e.g. "What is the ARR?").

**Expected:**
- A new `Question` row appears in the (currently hidden, may surface in Phase 1.x) Question list. The vitest E2E asserts `useQuestionStore.questions[0].text` is the joined-text of the last 3 chunks.
- The `AnswerPanel` transitions from empty (`No question yet`) to a loading state (`status="loading"` — visible spinner or `…` placeholder). This happens within ~200 ms of the click.
- The answer panel does NOT yet show streamed text — that begins in step 7.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
___________________________________________________________________
___________________________________________________________________
```

---

## Step 7 — Verify AI answer streams in

**Action:** Wait. Watch the AnswerPanel.

**Expected:**
- Within ~1.5 s of step 6 click, the first answer tokens appear (Anthropic SDK first-byte latency).
- Tokens stream in token-by-token; markdown headings + lists render as they arrive (no flicker, no full re-render — `react-markdown` handles incremental updates).
- Stream completes within ~5–10 s (depends on response length).
- Once `status="done"`:
  - `Copy` button appears and is enabled.
  - `cost-readout` appears, showing 4dp USD (e.g. `$0.0142`). **Compare against C-3 advisory: $0.015/warm-call.** If > $0.020 → flag in notes.
  - If `cacheReadRatio > 0.5` → green `cache hit` badge appears. (First-call this run will likely be cache-miss; second consecutive call to the same context should hit.)
- DevTools console shows zero errors. **Critically: NO `sk-ant-` substring leaks anywhere** (network panel, console, DOM). The error-fallback redaction in `AnswerPanel.tsx` strips it; verify no error path bypasses this.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
First-token latency:  _______ ms (target: < 2000 ms)
Stream end latency:   _______ ms
Cost (USD):           $______  (target: ~$0.015 per C-3)
Cache read ratio:     _______  (warm-call target: > 0.5)
Answer text excerpt:  _________________________________________________
___________________________________________________________________
```

**If `MissingApiKeyError` shows here:** P-4 was skipped. Mark step 7 ⚠️ (key unavailable) but continue to step 8 — the persistence layer does not depend on a successful answer.

---

## Step 8 — Click Stop Meeting → close the app

**Action:**
1. Click `Stop Meeting`.
2. Verify `meeting-status` reads `ended`.
3. Verify the `Restart` button appears (per T-1.9 outcome notes).
4. Quit the app: `Cmd-Q` or close the window.

**Expected (Stop click):**
- Mic indicator in macOS menu bar disappears (the orange dot goes away).
- `bun run tauri dev` terminal log shows the Rust-side `meeting:state` payload with `status: "ended"`.
- `useMeetingPersist` effect fires exactly once and calls `saveMeetingSnapshot(snap)`. The terminal log shows a SQLite `INSERT` (debug log line, if logging is enabled). The save MUST be synchronous-from-the-user's-perspective (< 50 ms; small payload, single txn).
- No `console.error` in DevTools.

**Expected (quit):**
- App closes within ~500 ms.
- SQLite WAL flushes on `Drop` of the `Connection` inside `RepoHandle`. Verify by listing `~/Library/Application Support/meeting-copilot/`:

```sh
ls -la ~/Library/Application\ Support/meeting-copilot/
# expect: meetings.db (and meetings.db-wal / -shm if WAL not yet checkpointed)
```

`meetings.db` should be > 0 bytes. If 0 bytes → save failed silently — check `bun run tauri dev` log for `RepoHandle::save_meeting` errors.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
~/Library/Application Support/meeting-copilot/meetings.db size: _____ bytes
___________________________________________________________________
___________________________________________________________________
```

---

## Step 9 — Reopen the app

**Action:** Run `bun run tauri dev` again from the same terminal (or a new one in the same dir).

**Expected:**
- App opens within ~5–10 s (no Rust rebuild — incremental).
- On mount, `useMeetingPersist` calls `loadMeetings()` once. The terminal log shows a SQLite `SELECT` against the `Meeting` table.
- The `<PastMeetings />` section becomes visible. The `data-testid="past-meetings-count"` reads `1 past meeting` (or `N past meetings` if you have run prior sessions).
- The list shows the meeting from step 8: title or timestamp, chunk count (3+), question count (1).
- Console: zero errors. The hook treats `loadMeetings` failure as soft-fail (`console.warn`) — if you see a warn line, `loadMeetings` rejected; check the DB file is readable.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
past-meetings-count: _____
Meeting from step 8 visible? [ ] yes [ ] no
___________________________________________________________________
```

---

## Step 10 — Verify transcript persisted

**Action:** Inspect the saved data. Two paths:

**Path A — UI (preferred):** Click into the past meeting in `<PastMeetings />`.

> **Phase 1.x deferred:** per T-1.13 review §"Out-of-scope captured", click-into-past-meeting hydration → live transcript view is **deferred to Phase 1.x**. The Phase 1 demo only shows count + list; per-meeting drill-down is not yet wired. Mark Path A as ⏸ (deferred) and use Path B.

**Path B — DB inspection (Phase 1 fallback):** Open `~/Library/Application Support/meeting-copilot/meetings.db` in any SQLite client (`sqlite3` CLI, DB Browser for SQLite, etc.):

```sh
sqlite3 ~/Library/Application\ Support/meeting-copilot/meetings.db
sqlite> SELECT id, status, started_at, ended_at FROM meeting;
sqlite> SELECT meeting_id, text, start_ts, end_ts FROM transcript_chunk ORDER BY start_ts;
sqlite> SELECT id, meeting_id, text FROM question;
sqlite> SELECT id, question_id, text FROM answer;
sqlite> SELECT id, meeting_id, path, char_count FROM context_source;
sqlite> .quit
```

**Expected:**
- `meeting` has 1 row from step 8: `status='ended'`, `started_at` ≈ step 3 click time, `ended_at` ≈ step 8 click time.
- `transcript_chunk` has ≥ 3 rows for that meeting_id, with text matching what you said in step 4.
- `question` has 1 row, `text` is the joined last-3-chunks text.
- `answer` has 1 row (assuming step 7 succeeded; 0 rows if step 7 was ⚠️ no-key), `question_id` foreign-keys to the `question` row.
- `context_source` has 1 row, `path` matches what you typed in step 2, `char_count` matches step 2's readout.

**Pass / fail:** [ ] PASS  [ ] FAIL

**Notes / observed result:**

```
meeting count:           _____
transcript_chunk count:  _____ (expect ≥ 3)
question count:          _____ (expect 1)
answer count:            _____ (expect 1, or 0 if step 7 was ⚠️ no-key)
context_source count:    _____ (expect 1)
___________________________________________________________________
```

---

## Final verdict

| Step | Title | Pass / Fail / ⚠️ / ⏸ |
|---|---|---|
| 1 | Open the app | _____ |
| 2 | Load PRD context | _____ |
| 3 | Click Start Meeting | _____ |
| 4 | Speak into the mic | _____ |
| 5 | Verify live transcript < 2 s | _____ |
| 6 | Mark a chunk as question | _____ |
| 7 | Verify AI answer streams in | _____ |
| 8 | Stop + close | _____ |
| 9 | Reopen the app | _____ |
| 10 | Verify transcript persisted | _____ |

**Overall:** [ ] 🟢 ALL PASS (Phase 1 ships)  [ ] 🟡 PARTIAL (some ⚠️ / ⏸; document gaps)  [ ] 🔴 FAIL (≥ 1 hard fail; do not sign off `PHASE-1-COMPLETE.md`)

**Tester signature / handle:** _______________________________

**Date:** _______________________________

---

## Failure-mode quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Step 1 — window opens but white screen | Vite dev server not ready; or `index.html` build error | check `bun run tauri dev` log for Vite errors; reload Cmd-R |
| Step 2 — `[role=alert]` "unsupported extension" | file is not `.md` / `.txt` / `.markdown` (per `helper-daemon::context::read_context_file`) | rename or use one of those extensions |
| Step 3 — `Start Meeting` stays disabled after step 2 | `useContextStore.source` did not populate | step 2 silently failed — re-check path, watch DevTools network tab |
| Step 4 — no chunks ever appear | mic permission denied OR `mlx-whisper` subprocess crashed | check System Settings → Mic; tail `bun run tauri dev` for `mlx-whisper exit code != 0` |
| Step 4 — chunks appear but text is `[BLANK_AUDIO]` or empty | mic input level too low; OR speaking before `meeting:state="active"` event fires | wait 1 s after Start before speaking; check mic input volume in macOS Sound settings |
| Step 5 — first-chunk latency > 5 s | MLX cold-start: model weights still loading from HF cache (~30–60 s on first use); OR M1 Pro 16 GB at saturation | pre-warm by transcribing a 1-s WAV before Start; if persistent → C-1 trigger, log T-1.5b re-measure |
| Step 7 — `MissingApiKeyError` | `ANTHROPIC_API_KEY` not in env at app launch time | `export ANTHROPIC_API_KEY=...` BEFORE `bun run tauri dev`; Tauri reads env at process launch |
| Step 7 — `4xx` from Anthropic API | invalid key, expired key, or rate limit | check key in console.anthropic.com; check usage page |
| Step 7 — answer arrives but no cost / no cache badge | `costUsd` not populated by `claudeClient.ts` final `result` event | check terminal for parser errors; `usage` field on `message_stop` event |
| Step 8 — `meetings.db` is 0 bytes | save_meeting Tauri command rejected (DB locked, FS permission, etc.) | tail `bun run tauri dev` for `RepoHandle::save_meeting` errors; check `~/Library/Application Support/meeting-copilot/` is writable |
| Step 9 — `past-meetings-count` reads `0` after step 8 success | `loadMeetings` rejected (DB schema mismatch, file moved, etc.) | check console.warn lines from `useMeetingPersist`; inspect DB with sqlite3 |
| Step 10 — `transcript_chunk` count is 0 but `meeting` row exists | snapshot saved meeting row but chunks insert failed (txn should have rolled back per T-1.13 E2 — file a bug) | export DB, file a regression issue against T-1.13 |

---

## Append after run — environment capture

```sh
# Run these and paste the outputs into the Notes section of any failed step:
sw_vers
sysctl -n hw.model
sysctl -n hw.memsize
rustc --version
cargo --version
bun --version
python --version
echo $ANTHROPIC_API_KEY | head -c 12
ls -la ~/Library/Application\ Support/meeting-copilot/
```

---

## Loop-driver notes (for `PHASE-1-COMPLETE.md`)

This document is the **manual** half of the Phase 1 exit gate. The **simulated** half is `src/__tests__/E2E.test.tsx` (vitest harness against mocked Tauri + mocked Anthropic SDK). Both sides assert the same flow:

| Manual step | Vitest E2E assertion |
|---|---|
| 1 | `getByText("Meeting Copilot")` after `render(<App />)` + zero `console.error` (E22) |
| 2 | `loadContextThroughUi(user)` populates `useContextStore.source` (E2) |
| 3 | `meeting-status` reads `active` after Start click (E3) |
| 4 | `pushTranscript(...)` payloads render via `TranscriptView` (E4) |
| 5 | Per-chunk render is synchronous in vitest; the < 2 s SLO is hardware-only |
| 6 | `useQuestionStore.questions[0].text` joins last-3-chunks (E5) |
| 7 | `FakeAnthropic.messages.stream` → 3 deltas → `answer-body` text + `cost-readout` visible (E6) |
| 8 | Stop click → `useMeetingPersist` fires `saveMeetingSnapshot` once with full snapshot (E7) |
| 9 | Mount → `loadMeetings()` → `past-meetings-count` reads `1 past meeting` (E8) |
| 10 | DB inspection is hardware-only; the vitest mock asserts the snapshot shape end-to-end |

`PHASE-1-COMPLETE.md` (loop step 16) closes Phase 1 once a tester has run this manual plan on a real M1 Pro/Max/M2/M3 host with all 10 steps PASS or accountable ⚠️/⏸.
