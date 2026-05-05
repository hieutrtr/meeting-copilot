# Phase 2 — Auto Question Detection — Task Index

> Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 2 — Auto Question Detection" (lines 72–93). Read-only spec.
> Architecture refs: ARCH §5 "Question Detection" (lines 144–167), §12 "Latency Budget" (lines 411–426), §13 "Cost Model" (lines 430–447).
> PRD refs: US-04 (auto-detected highlighted), US-12 (manual fallback).
> Stack lock (carry-forward from Phase 1): **Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude Sonnet 4.6 (answer) + Claude Haiku 4.5 (filter, NEW)**. No multi-provider — that is Phase 3.
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.

## Phase Goal (verbatim from plan)

> Bỏ "manual mark", AI tự bắt câu hỏi từ transcript stream và generate answer trong < 10s.

## Phase Exit Criteria (verbatim)

> Trong test 30 phút meeting, ≥ 80% câu hỏi thật được detect, ≥ 70% answer được judge là "useful".

This loop's gate (mirrors Phase 1 sign-off shape):

1. `bun test` + `cargo test --workspace` all green (no Phase 1 regression).
2. T-2.10 E2E run produces a metric report — catch-rate ≥ 80%, useful-rate ≥ 70% on the test fixture (real recording on Apple-Silicon hardware OR a synthetic transcript fallback when host hardware is unavailable, with explicit `(fixture-mode)` annotation).
3. `PHASE-2-COMPLETE.md` sign-off committed with the metric report inline.

---

## Inputs Carried Forward From Phase 1

These Phase 1 artifacts are re-used (NOT rewritten) and form the seam Phase 2 plugs into:

- **`src/llm/claudeClient.ts`** (T-1.10) — Sonnet 4.6 streaming + two-block ephemeral cache. T-2.6 invokes this verbatim from the queue worker.
- **`src/llm/pricing.ts`** (T-1.10) — Sonnet token pricing constants. T-2.7 extends with Haiku 4.5 pricing for cost-guard math.
- **`src/store/questionStore.ts`** (T-1.9) — `markFromChunks` manual path stays as US-12 fallback. T-2.6 adds `markAuto` so `Question.method = "auto"` enters the same downstream Q/A flow.
- **`src/hooks/useTranscriptStream.ts`** (T-1.6) — `transcript:chunk` subscription. T-2.2's sliding-window assembler consumes the same hook.
- **`src/hooks/useAskClaude.ts`** (T-1.11) — request-id-gated cancellation + partial-text preservation. T-2.6 fans this out to N concurrent in-flight asks via the queue, max 1 per ARCH constraint.
- **`crates/helper-daemon/src/repo.rs`** (T-1.12) — SQLite `Question` table already has `method: "auto" | "manual"`. T-2.5 may persist queue checkpoint state here.
- **`shared/types.ts`** — `Question.confidence?: number` already exists; T-2.3 fills it with the Haiku verdict score.

Three Phase-0 blocked user-actions stay open (already documented in Phase 1 sign-off `PHASE-1-COMPLETE.md` §"Known caveats"):

1. BlackHole 2ch + Aggregate Device — does NOT block Phase 2 (Phase 2 reads transcript stream, agnostic of mic vs system audio).
2. `ANTHROPIC_API_KEY` — blocks live T-2.3 Haiku and T-2.6 Sonnet calls. Structural tests proceed against mocked SDK; a `MISSING_API_KEY` short-circuit drops the candidate without crashing the queue.
3. `cargo` + `rustup` + `tauri-cli` not installed on loop sandbox — same shape as Phase 1: every Rust task is "code-complete, hardware-verify pending"; static-trace + per-task self-review covers the gap.

---

## Task Checklist (10 tasks)

- [x] **T-2.1** — Heuristic question detector (Stage 1 of two-stage detector per ARCH §5.1). Pure function `detectCandidate(utterance) -> { isCandidate: boolean, signals: string[] }` over text-only input. Signals: `?` suffix, wh-words ("what/why/how/when/where/who/which") + auxiliary verb, modal phrases ("can/could/would/should you"), > 50 chars + (later) intonation flag. **AC:** unit test on a 50-sample fixture (25 question, 25 non-question), precision ≥ 0.7, recall ≥ 0.8. Dep: T-1.5 (transcript producer exists). Risk: false positives from declarative sentences with wh-words. — **DONE: precision 0.926, recall 1.000 (63 new tests; 166 total green). See `T-2.1-review.md`.**
- [x] **T-2.2** — Sliding-window utterance assembler. Stateful struct that consumes `TranscriptChunk` events and emits "utterance" boundaries when (a) silence > 800 ms gap between chunk endTs and next startTs, OR (b) explicit `isFinal=true` chunk with sentence-ending punctuation. Output: `Utterance { text, startTs, endTs, chunkIds: string[] }`. **AC:** unit test on 1-minute synthetic fixture (10 ground-truth utterances) → boundary correctness > 80%. Dep: T-1.5. Risk: silence detection sensitivity — tune via fixture, expose threshold in T-2.9 settings. — **DONE: boundary correctness 10/10 = 100.0 % (18 new tests; 184 total green). See `T-2.2-review.md`.**
- [x] **T-2.3** — Haiku LLM filter (Stage 2 of two-stage detector). Send each heuristic-candidate utterance through `claude-haiku-4-5-20251001` with prompt "Câu sau có phải câu hỏi user nên trả lời không? Trả YES/NO + 1 câu lý do." Threshold: trigger only if Haiku says YES (verdict score ≥ 0.7 mapped from `yes`/`no` log-probs or rule-based confidence). Caches the static instructions block. **AC:** mocked-SDK structural test asserts request shape; gold-label test on a 100-sample set (text-only, hand-labeled in-fixture) → agreement ≥ 85%; latency budget < 500 ms (per ARCH §12 the budget is 200 ms; 500 ms is the AC ceiling from plan). Dep: T-2.1, T-2.2. Risk: Haiku cost accumulation (covered by T-2.7). — **DONE: 96.0 % gold-label agreement (96/100), warm-call cost $0.000174 (cold $0.000300); 29 new tests; 218 / 218 repo TS suite green. Live latency = host-blocked (deferred to PHASE-BROWSER-TEST.md). See `T-2.3-review.md`.**
- [x] **T-2.4** — Dedup window. Hash question text (normalized: lowercase + strip punctuation + collapse whitespace) → reject identical hash within 60 s. Phase 2 ships hash-only; ARCH §5.2 mentions embedding cosine similarity > 0.85 as v1 — that is **deferred** to a Phase 2.x backlog item (`nomic-embed-text` local dependency is non-trivial to wire). **AC:** unit test — repeat "what's the deadline?" 3× in 30 s → exactly 1 admitted; paraphrase test ("when is the deadline?" vs "what's the deadline?") documents the known limitation (both admitted, expected). Dep: T-2.3. Risk: paraphrase miss — explicitly out-of-scope for v0.2. — **DONE: AC gate green (3 admits → 1 admitted, 2 rejected with `reason: "duplicate"`); paraphrase known-limitation test admits both as documented; 35 new tests; 253 / 253 repo TS suite green. See `T-2.4-review.md`.**
- [x] **T-2.5** — `QuestionQueue` with bounded in-memory queue. Max 1 concurrent answer generation (per ARCH §3 pipeline + plan AC), drop-oldest if queue depth > 5. Optional SQLite checkpoint via `Repo` so a crash mid-meeting does not lose admitted-but-unanswered questions. **AC:** stress test 20 questions/min for 60 s → queue never crashes, drops are logged with reason `"backpressure"`, single-flight invariant holds. Dep: T-2.4. Risk: race condition between drain and drop — covered by Tokio mutex test or, if queue lives in TS land, by single-threaded JS event-loop guarantee + explicit busy flag. — **DONE: AC GATE green (20 q/min × 60 s sim — 20 admits, 0 crash, conservation `admitted = completed + failed + dropped + leftover` holds; pending depth never > maxDepth=5). Persistence reconstruct verified: 3 admits → drop ref → fresh queue restores 3-item pending; in-flight item from prior session replays as pending head. Single-flight + drop-oldest + 100-op random conservation all green. 41 new tests; 294 / 294 repo TS suite green; `tsc --noEmit` clean. SQLite-backed adapter (Phase 2.x backlog) — interface seam shipped via `QueuePersistenceAdapter`; in-memory ref impl is the v0.2 production adapter. See `T-2.5-review.md`.**
- [x] **T-2.6** — Auto-trigger: queue admit → Claude streaming → render in `AnswerPanel` with `method: "auto"` badge. Wires T-2.5 worker to `askClaude()` (T-1.10) and pushes answer events into the existing `useAskClaude` hook (or a queue-aware variant). The Question is also pushed onto `useQuestionStore.questions` so the existing Phase-1 manual `AnswerPanel` flow re-uses verbatim. **AC:** integration test (mocked SDK) — utterance enters detector → answer first-token render < 10 s end-to-end (heuristic 2 ms + Haiku 200 ms + Sonnet 2000 ms first-token = ~2.2 s, padded with queue-wait headroom for 10 s budget). Dep: T-2.5, T-1.10. Risk: AnswerPanel concurrent state when manual + auto fire close together — single-flight queue is the mitigation. — **DONE: simulated first-token < 3 000 ms (well under 10 000 ms budget); single-flight peak = 1 across 5-item drain; manual-mark independence verified (`ask` count = 0 after 3 `markFromChunks` calls); 26 new tests (19 worker + 7 `markAuto`); 320 / 320 repo TS suite green; `tsc --noEmit` clean. React hook (`useQueueWorker`) deferred to T-2.8 per spec. See `T-2.6-review.md`.**
- [x] **T-2.7** — Cost guard. Track Haiku token usage per meeting (input + output, summed via `usage` events from each call), translate to USD via `pricing.ts` extension, surface a banner alert when cumulative cost > $0.50/h projected (and a hard pause toggle if user opts in via T-2.9). **AC:** unit test — feed synthetic usage stream, assert threshold crossing fires exactly once at $0.50, pause toggle short-circuits subsequent Haiku calls. Dep: T-2.3. Risk: pricing constant drift — pin to spike-memo-validated values. — **DONE: AC GATE green — 32 / 32 cost-guard tests pass; threshold latch fires exactly once at $0.51/h projection (1 h fake-clock); $0.49/h does NOT fire; warm-up gate (60 000 ms default) suppresses early false alarms; `guardedClassifyWithHaiku` short-circuits Haiku call when paused (classifier-spy callCount === 0); reset un-latches alert + zeroes counters; throwing `onAlert` swallowed (defensive). 32 new tests; 352 / 352 repo TS suite green; `tsc --noEmit` clean; pricing constants pinned via cross-check vs `pricing.test.ts` to 12 decimal places. UI banner deferred to T-2.8; Settings checkbox deferred to T-2.9. See `T-2.7-review.md`.**
- [x] **T-2.8** — UX: question chip in transcript (clickable, highlight corresponding answer in panel). Renders inline with the chunk that contains the utterance start. Click → `scrollIntoView` on the answer card + 1.5 s flash highlight. **AC:** RTL test — render transcript with 1 detected question, click chip → answer panel scrolled, highlight class applied. Dep: T-2.6. Risk: scroll behavior in jsdom — fall back to `aria-current` flip + DOM `scrollIntoView` mock assertion if `behavior: smooth` not supported in test env. — **DONE: AC GATE green — `Element.prototype.scrollIntoView` spy receives `{behavior:"smooth", block:"start"}` exactly once on the answer-target instance; `answer-flash` class added immediately + removed at exactly 1500 ms (fake-timers); custom `flashClass`/`flashDurationMs`/`scrollOptions` honored; confidence tier classes `qf-conf--{high,mid,low}` at boundaries 0.80/0.60/0.5999; `selectedId` flips `data-selected`; truncation preserves full text in `title`; throwing `onSelect` swallowed; rerender mid-flash preserves timer. Sidebar feed (not inline-in-transcript) per spec scope-out — inline placement deferred to Phase 2.x. Component is purely additive (zero edits to T-1.x / T-2.1..T-2.7). 21 new tests; 373 / 373 repo TS suite green; `tsc --noEmit` clean. App.tsx mount deferred to T-2.10 wiring. See `T-2.8-review.md`.**
- [x] **T-2.9** — Settings: detector sensitivity slider (precision-recall tradeoff via heuristic-only-vs-Haiku threshold) + enable/disable Haiku filter toggle. Persisted via `localStorage` (Phase 1 has no Settings panel yet — raw T-1.11 was deferred to Phase 1.x; Phase 2 lands a minimal Settings sheet). **AC:** unit test on settings store — slider change updates threshold, toggle disables Haiku call (heuristic-only mode); persistence across reload via `localStorage` mock. Dep: T-2.3. Risk: scope creep — Settings sheet stays minimal (no API key UI yet, no provider picker yet — those are Phase 1.x and Phase 3 respectively). — **DONE: AC GATE green — 28 / 28 settings-store tests pass; 5-field round-trip + persistence-across-recreate verified; clamp [0,1]/[200,10_000]/[0,100] + NaN-rejection verified per field; corrupted-JSON / null-storage / throwing-`setItem` fallback verified; composer `classifyWithSettingsGate` precedence (disabled > paused > classify) verified; admit math `isQuestion && confidence ≥ cutoff` verified; versioned storage key `meeting-copilot:settings:v1` pinned. 28 new tests; 401 / 401 repo TS suite green; `tsc --noEmit` clean. Single 1-line additive `export` on `DEFAULT_SILENCE_MS` (sliding-window.ts) — strictly additive visibility change. UI Settings sheet deferred to Phase 2.x backlog. See `T-2.9-review.md`.**
- [ ] **T-2.10** — E2E with recording (or synthetic transcript fallback). 30-minute meeting recording — measure (a) catch rate = (auto-detected questions / ground-truth questions), (b) useful rate = (useful answers / detected questions, manually judged YES/NO). **AC:** ≥ 80% catch rate, ≥ 70% useful rate. If no real recording is available on the loop sandbox, ship a 30-minute synthetic-transcript fixture with hand-labeled ground-truth questions so the metric report is sandbox-runnable; mark the live-hardware re-verify as a manual step in `PHASE-BROWSER-TEST.md`. Dep: T-2.8 (full UX wired end-to-end). Risk: synthetic fixture not representative of real meeting cadence — mitigation = blend prompts from PRD §2 personas + spike-memo §"Use cases" + 1 transcript snippet from a real public talk if available.

---

## Dependency Graph (ASCII)

```
        ┌────────────────────────────────────────────────────────┐
        │  Phase 1 carry-forward (NOT re-implemented):           │
        │   useTranscriptStream / claudeClient / questionStore   │
        │   pricing / Repo / shared types                        │
        └──────┬──────────────────────────┬──────────────────────┘
               │                          │
               ▼                          ▼
         ┌──────────┐               ┌──────────┐
         │  T-2.1   │               │  T-2.2   │   (independent — both
         │heuristic │               │ sliding  │    consume transcript stream;
         │ detector │               │ window   │    can land in either order)
         └────┬─────┘               └────┬─────┘
              └────────────┬─────────────┘
                           ▼
                     ┌──────────┐
                     │  T-2.3   │  Haiku LLM filter
                     │   (gold  │
                     │ label set)│
                     └────┬─────┘
                          ▼
                     ┌──────────┐                    ┌──────────┐
                     │  T-2.4   │                    │  T-2.7   │  cost guard
                     │  dedup   │                    │ (parallel│  (depends on
                     └────┬─────┘                    │  to 2.4─ │   T-2.3 only)
                          ▼                          │   2.6)   │
                     ┌──────────┐                    └──────────┘
                     │  T-2.5   │  bounded queue + SQLite checkpoint
                     │  queue   │
                     └────┬─────┘
                          ▼
                     ┌──────────┐
                     │  T-2.6   │  auto-trigger → Claude stream → AnswerPanel
                     │ trigger  │
                     └────┬─────┘
                          ├────────────────────┐
                          ▼                    ▼
                     ┌──────────┐         ┌──────────┐
                     │  T-2.8   │         │  T-2.9   │  (parallel after T-2.6)
                     │   UX     │         │ settings │
                     └────┬─────┘         └────┬─────┘
                          └────────┬───────────┘
                                   ▼
                              ┌──────────┐
                              │  T-2.10  │  E2E + metric report
                              │   E2E    │
                              └──────────┘
```

Critical path: T-2.1/T-2.2 (parallel) → T-2.3 → T-2.4 → T-2.5 → T-2.6 → T-2.8/T-2.9 (parallel) → T-2.10. T-2.7 parallelizable any time after T-2.3 (does not gate the critical path).

---

## TDD per task

| Task | Harness | Notes |
|---|---|---|
| T-2.1 | Vitest + 50-sample text fixture | 25 question + 25 non-question; precision ≥ 0.7, recall ≥ 0.8 |
| T-2.2 | Vitest + 1-min synthetic chunk-stream fixture | 10 ground-truth utterances; boundary correctness > 80% |
| T-2.3 | Vitest + mocked Anthropic SDK + 100-sample gold-label set | Structural request-shape test + agreement ≥ 85% |
| T-2.4 | Vitest unit | Hash dedup happy path + paraphrase known-limitation doc test |
| T-2.5 | Vitest stress test (fake timer + 20 admits in synthetic 60 s) | Single-flight invariant + drop log |
| T-2.6 | Vitest integration with mocked SDK | End-to-end < 10 s simulated; answer renders with `method:"auto"` badge |
| T-2.7 | Vitest unit | Cost counter accumulation + threshold-crossing alert + pause toggle short-circuit |
| T-2.8 | Vitest + Testing Library | Click chip → `scrollIntoView` mock + highlight class |
| T-2.9 | Vitest unit (settings store) + Vitest component (slider + toggle) | `localStorage` persistence + threshold propagation |
| T-2.10 | Vitest E2E + manual `PHASE-BROWSER-TEST.md` | 30-min synthetic transcript fixture sandbox-runnable; live recording = manual host step |

---

## Acceptance Criteria Summary

| Task | Numeric AC |
|---|---|
| T-2.1 | precision ≥ 0.7, recall ≥ 0.8 on 50-sample fixture |
| T-2.2 | utterance boundary correctness > 80% on 10-utterance fixture |
| T-2.3 | Haiku-vs-gold-label agreement ≥ 85% on 100-sample fixture; latency budget < 500 ms (200 ms per ARCH §12, 500 ms is plan ceiling) |
| T-2.4 | repeated-question dedup = 1 admit / 3 sends within 60 s |
| T-2.5 | 20 q/min stress = 0 crash, drop-oldest invariant holds, single-flight invariant holds |
| T-2.6 | end-to-end utterance → first answer token < 10 s (mocked-SDK simulated) |
| T-2.7 | cost-threshold alert fires exactly once at projected > $0.50/h |
| T-2.8 | click chip → answer panel scrolled + highlight visible |
| T-2.9 | slider/toggle persist across reload; threshold change observable in detector pipeline |
| T-2.10 | catch rate ≥ 80%, useful rate ≥ 70% on 30-min fixture |

---

## Risk Register (Phase 2 specific — top 5)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Haiku false positives spam answer panel.** Heuristic too liberal + Haiku threshold too low → AnswerPanel floods with low-value answers, user confidence drops. | Medium | High | Phase 2 default sensitivity slider tuned conservative (precision-favored over recall). User-visible "auto" badge + dismiss button (T-2.6 stretch). T-2.10 metric report quantifies useful-rate as the empirical guardrail. |
| R-2 | **Silence-boundary detection wrong on real audio cadence.** Synthetic fixtures may not capture real meeting rhythm (stutter, filler, overlap) → utterances mis-segmented → detector misses or duplicates. | Medium | Medium | T-2.2 ships threshold (800 ms) tunable via T-2.9 settings; T-2.10 real-recording verify is the empirical gate; explicit `isFinal=true` punctuation override is a second boundary signal. |
| R-3 | **Haiku cost overrun.** Talky meeting (3-10 candidates/min × 60 min × $0.0002/call ≈ $0.04-0.12 just for filter) accumulates; combined with Sonnet auto-answers (10 q/h × ~$0.03 = $0.30) approaches $0.50/h faster than expected. | Medium | Medium | T-2.7 cost guard hard-fires alert + optional pause; T-2.9 toggle disables Haiku entirely (heuristic-only mode = $0 filter cost, accepts higher false-positive rate). |
| R-4 | **Queue races with manual mark.** User clicks "Mark as question" while auto-detector also admits the same utterance → 2 answers fire, AnswerPanel state corrupts. | Low | Medium | T-2.5 single-flight invariant covers all admit paths (manual + auto enter the same queue); T-2.4 dedup window catches identical text from both paths within 60 s. |
| R-5 | **Hardware-blocked AC re-verification.** ANTHROPIC_API_KEY + Apple-Silicon host not available on loop sandbox → live Haiku latency, real-recording catch-rate cannot be measured during the loop. | High | Medium | Same `CAVEAT-GO` shape as Phase 1 sign-off — code-complete via mocks + structural tests; live re-verify documented in `PHASE-BROWSER-TEST.md` as the manual host pass. T-2.10 ships a sandbox-runnable synthetic-transcript fallback so the metric report is not entirely paper-only. |

---

## Outputs Per Task

Every task creates:

- `docs/tasks/phase-2/T-2.<N>-<slug>.md` — plan + ARCH ref + AC + TDD plan + risk + mitigation
- Code under `src/`, `crates/`, `src-tauri/`, or `shared/` per Phase 1 layout
- Tests alongside the code (Vitest / `cargo test`)
- `docs/tasks/phase-2/T-2.<N>-review.md` — self-review (file changed, test count, metrics measured numerically, no Phase-1 regression, cost tracking on, no `sk-ant-` leak, background-worker cleanup verified, no `git push`)

Final phase outputs:

- `docs/tasks/phase-2/PHASE-BROWSER-TEST.md` — 10-step manual golden-path test for Phase 2 (live host)
- `docs/tasks/phase-2/PHASE-2-COMPLETE.md` — sign-off with the metric report inline (catch rate, useful rate, cost/h, end-to-end first-token latency)

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's headline outcome (test count + AC verdict) appears next to the title. Final state must show all 10 boxes ticked before `PHASE-2-COMPLETE.md` is written.

Per-task git commits land on `main` (no push — user pushes manually post-phase). Commit type per loop rule 4: `feat` (logic mới), `test` (test fixture-only commit), `docs` (review / index / browser-test), `chore` (config). Each commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
