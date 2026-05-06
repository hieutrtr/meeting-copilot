# Phase 2 — Browser / Live-Host Manual Test

> Companion to `T-2.10-e2e-recording.md` (the **fixture-mode** sandbox-runnable metric report). This file is the **wall-clock host re-verify**: live `ANTHROPIC_API_KEY`, real Apple-Silicon MLX whisper, real Telegram-meeting-rate cadence. Use it once Phase-2 ships locally to validate the catch-rate / useful-rate / first-token-latency numbers in the live environment.
>
> Why a separate doc: the Phase-2 sandbox lacks `ANTHROPIC_API_KEY` + Apple-Silicon hardware; the fixture-mode metric closes the AC gate, the live numbers are a deferred verify per the Phase-1 sign-off pattern. This 10-step procedure is the deferred verify.
>
> **Run cadence:** once at end-of-phase + after any T-2.x bug-fix. ~25 minutes wall-clock for the full pass.

---

## Prerequisites

- `cargo` + `rustup` + Tauri 2 CLI installed; project builds with `bun tauri dev`.
- `ANTHROPIC_API_KEY` exported in shell (`echo $ANTHROPIC_API_KEY | head -c 6` → `sk-ant`).
- BlackHole 2-channel + Aggregate Device set as system input (Phase-0 prereq; if missing, mic-only is acceptable for steps 1–9, only step 10 cares about system audio).
- A 5–10 minute test conversation script ready (or a prepared talking partner). The fixture used by the sandbox metric (`src/__tests__/fixtures/phase2-meeting.ts`) is a good outline — read questions out loud at conversational cadence.

## Layout

Each step has:

- **Action** — what to do.
- **Expected** — what you should see (UI, log, file).
- **Pass criterion** — the bool gate.

Mark each step `[ ] PASS` / `[ ] FAIL` as you go. A FAIL on any step blocks the live re-verify; file a Phase-2.x ticket with the failing step + screenshot.

---

## Steps

### Step 1 — Boot

- **Action:** `bun tauri dev` from the repo root. Wait for the Tauri window to open.
- **Expected:** "Meeting Copilot" header renders. No console errors in the Tauri devtools (Cmd-Opt-I). Past-meetings section shows count from any prior runs (or `0 past meetings`).
- **Pass criterion:** window opens, no red devtools errors on first paint.

### Step 2 — Load context

- **Action:** Type `docs/PRD.md` (or any plain-text file path you want as the answering context) into the **Context file path** input. Click **Load context**.
- **Expected:** Readout below the input shows the file path + char count + estimated tokens. The Tauri command `read_context_file` resolves with no error (visible in devtools Network/Console).
- **Pass criterion:** char count > 0, no error toast.

### Step 3 — Start meeting

- **Action:** Click **Start meeting**.
- **Expected:** Status pill flips to **active**. The Rust helper-daemon's `transcript:chunk` listener registers (devtools Network → events). MLX whisper begins transcribing your microphone (live captions appear in the transcript view as you speak).
- **Pass criterion:** at least one final transcript chunk renders within 5 seconds of speaking.

### Step 4 — Auto-detection happy path

- **Action:** Speak 3 clear questions, separated by 5–10 seconds of silence each. Suggested:
  1. "What is the latency budget for this feature?"
  2. "When are we shipping the redesign?"
  3. "Tại sao chúng ta dùng Claude Sonnet thay vì GPT?"
- **Expected:** Within ~10 seconds of finishing each question, a `Question` chip appears in the **QuestionFeed** sidebar with method badge **auto** + a confidence percentage. The first answer streams into the **AnswerPanel** (delta-by-delta) while the chip is still pending.
- **Pass criterion:** ≥ 2 of 3 questions detected automatically (`auto` badge, not `manual`); first answer's first token lands < 10 s after the question's final transcript chunk (per-question wall-clock — `Stopwatch` on phone is sufficient).

### Step 5 — Click-to-scroll answer flash (T-2.8 surface)

- **Action:** Click any auto-detected chip in the QuestionFeed.
- **Expected:** AnswerPanel scrolls to the matching answer card; the card briefly flashes (1.5 s yellow→transparent fade). `data-selected` flips to `true` on the clicked chip.
- **Pass criterion:** scroll happens AND flash visibly fires.

### Step 6 — Cost guard banner (T-2.7 surface)

- **Action:** Set the cost-guard threshold low (e.g. 0.05 USD/h) via the Settings sheet (T-2.9). Speak ~5 questions in quick succession to drive Haiku + Sonnet usage past the threshold.
- **Expected:** A red/amber banner appears at the top of the AnswerPanel reading "Projected cost > $0.05/h — pause auto-detect?" with a **Pause** button. The banner fires AT MOST ONCE per meeting (latched).
- **Pass criterion:** banner appears within 2 questions of crossing the projected threshold; clicking **Pause** stops further Haiku calls (verify by speaking another Q — no new chip should appear).
- **Note:** The Phase-2 default threshold is $0.50/h; lowering it for the test is intentional.

### Step 7 — Settings persistence (T-2.9 surface)

- **Action:** Open Settings. Move the **Detector sensitivity** slider to the strict end (e.g. cutoff 0.9). Toggle **Enable Haiku filter** off, then back on. Close + reload the window (Cmd-R inside the Tauri webview, or quit + restart).
- **Expected:** Re-opening Settings shows the slider at the value you set + the toggle in the state you left it. The detector pipeline observes the new cutoff (no chip fires for low-confidence Haiku verdicts).
- **Pass criterion:** values persist across reload AND a borderline question (intentionally weak signal — e.g. just "Maybe we should think about timelines") fires NO chip when the cutoff is at 0.9.

### Step 8 — Manual fallback (T-1.9 carry-forward, US-12)

- **Action:** With Haiku disabled (Settings toggle off), speak a question. Then click the **Mark question** button.
- **Expected:** A chip appears with method badge **manual** (not **auto**). The Sonnet answer streams as in Phase 1.
- **Pass criterion:** manual flow is unbroken — Phase-1 functionality regressions would be a blocker.

### Step 9 — Stop + persistence

- **Action:** Click **Stop meeting**.
- **Expected:** Status flips to **ended**. `save_meeting` Tauri command fires (devtools Console: a single `[invoke] save_meeting` line). The transcript / questions / answer / context-source bundle is written to SQLite via the helper daemon. The PastMeetings section count increments by 1.
- **Pass criterion:** count increments AND no error in the Tauri-helper stderr.

### Step 10 — Reload + past-meetings hydration

- **Action:** Quit the app (Cmd-Q). Restart with `bun tauri dev`.
- **Expected:** On boot, `load_meetings` Tauri command fires, the PastMeetings section renders the meeting you just ran (title, time, status). Click into it (Phase-1 hydrate-on-mount path).
- **Pass criterion:** the meeting from step 9 appears in the past-meetings list. Detail view shows the questions you asked + answers Sonnet returned.

---

## Live Metric Tally

After step 10, fill in the live numbers and compare to the fixture-mode metric in `T-2.10-review.md`:

| Metric | Fixture-mode value | Live value | Note |
|---|---:|---:|---|
| Catch rate (auto / GT) | 0.947 | __ / __ | Phase 2 AC ≥ 0.80 |
| Useful rate (useful / detected) | 0.889 | __ / __ | Phase 2 AC ≥ 0.70 |
| First-token p95 (ms) | 1500 (simulated) | ____ | Plan AC < 10 000 |
| Total cost ($) | $0.062229 | $______ | Per-meeting budget < $0.50 |
| Cost-guard fire count | 0 | __ | Should be 0 unless step 6 lowered the threshold |

A live miss on **catch rate** or **useful rate** is a Phase-2.x tuning ticket (file under `docs/tasks/phase-2.x/`), not a Phase-2 blocker — fixture-mode is the AC gate. A live miss on **first-token latency** is a Phase-2 blocker; the fixture is a simulated-clock test, the live measure is the only ground truth for the budget.

## Notes

- The fixture seeds a duplicate question pair to exercise dedup; the live test relies on you noticing if you accidentally repeat yourself within 60 s and the second chip is suppressed.
- Step 6's threshold must be reset to the default (0.5 USD/h) in Settings before exiting, or future runs will keep alarming.
- If `transcript:chunk` events do not arrive on step 3, check that BlackHole is the system input AND the Tauri-helper has microphone permission (System Settings → Privacy → Microphone → Tauri / claude-bridge entry).
