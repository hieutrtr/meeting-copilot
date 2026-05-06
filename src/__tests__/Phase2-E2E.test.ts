// Phase 2 T-2.10 — End-to-end pipeline + metric report (fixture-mode).
//
// Drives the production code-path of every Phase-2 stage:
//   chunks → sliding-window (T-2.2) → heuristic (T-2.1) → Haiku gate (T-2.3
//   parser path + oracle classifier) wrapped in classifyWithSettingsGate
//   (T-2.9) + costGuard (T-2.7) → dedup window (T-2.4) → bounded queue (T-2.5)
//   → queue worker (T-2.6) → mocked Sonnet streaming → markAuto (questionStore).
//
// Fixture is sandbox-runnable (no network, no API key, no jsdom). Live-recording
// re-verify is documented in `docs/tasks/phase-2/PHASE-BROWSER-TEST.md`.
//
// Determinism: every call into the production code-path uses an injected
// monotonic clock (driven off the fixture's tsMs) and a seeded ε-noise function
// indexed by utterance position. The catch-rate / useful-rate / latency p95
// numbers are byte-identical across reruns.

import { describe, expect, it } from "vitest";

import type { TranscriptChunk } from "../../shared/types";
import { detectCandidate } from "../detector/heuristic";
import {
  createSlidingWindow,
  DEFAULT_SILENCE_MS,
} from "../detector/sliding-window";
import { createDedupWindow } from "../detector/dedupWindow";
import { createCostGuard } from "../cost/costGuard";
import { createSettingsStore } from "../store/settingsStore";
import { classifyWithSettingsGate } from "../store/settingsStore";
import { useQuestionStore } from "../store/questionStore";
import {
  createQuestionQueue,
  type EnqueueInput,
  type QueuedItem,
} from "../queue/questionQueue";
import { createQueueWorker } from "../queue/queueWorker";
import type { HaikuClassification, HaikuVerdict } from "../llm/haikuFilter";
import type {
  AskClaudeEvent,
  AskClaudeInput,
  AskClaudeResult,
} from "../llm/claudeClient";
import type { AnthropicUsage } from "../llm/pricing";
import {
  buildFixture,
  chunkPunctuation,
  type FixtureUtterance,
} from "./fixtures/phase2-meeting";

// ── Deterministic ε-noise helper ────────────────────────────────────────────
//
// Mulberry32-style integer hash off a (salt, idx) pair. Returns a stable
// pseudo-random number in [0,1). Used to flip the Haiku oracle's verdict on a
// fixed ~5 % of utterances so the test exercises the parser + admit path even
// when the oracle would otherwise be perfect, while staying byte-stable across
// reruns.
function seededRand(salt: number, idx: number): number {
  let x = (salt ^ (idx * 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
}

const ORACLE_FLIP_RATE = 0.05;

interface PipelineRunOptions {
  haikuEnabled?: boolean;
  costGuardPaused?: boolean;
}

interface PipelineRunResult {
  fixtureQuestions: number;
  fixtureUseful: number;
  utteranceCount: number;
  candidateCount: number;
  classifyCalls: number;
  oracleFlips: number;
  haikuVerdictsYes: number;
  dedupAdmits: number;
  dedupRejects: number;
  enqueueAdmits: number;
  enqueueDropped: number;
  workerCompleted: number;
  workerErrors: number;
  catchRate: number;
  usefulRate: number;
  // Latency metrics under the fake clock — note these reflect the simulated
  // wall-clock between enqueue and first-token / completion, not the test's
  // real CPU time. The fake clock is advanced inside the oracle ask.
  firstTokenLatencyP95: number;
  endToEndLatencyP95: number;
  peakInFlight: number;
  costSnapshot: ReturnType<ReturnType<typeof createCostGuard>["snapshot"]>;
  detectedQuestions: Array<{
    fixtureIdx: number;
    text: string;
    useful: boolean;
    isFalsePositive: boolean;
  }>;
}

async function runPipeline(
  opts: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  const fixture = buildFixture();

  // ── Single shared monotonic clock ─────────────────────────────────────────
  // Drive off the fixture timeline so dedup window / cost guard / worker
  // metrics all see the same ramp.
  let fakeNow = 0;
  const clock = () => fakeNow;

  // ── Stores and gates ──────────────────────────────────────────────────────
  const storage = (() => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  })();
  const settingsStore = createSettingsStore({ storage });
  if (opts.haikuEnabled === false) {
    settingsStore.getState().setHaikuEnabled(false);
  }
  if (opts.costGuardPaused === true) {
    settingsStore.getState().setCostGuardPaused(true);
  }

  // Cost guard — threshold set deliberately high for fixture (1.0 USD/h) so
  // the projected $/h on a chatty 30-min run does not auto-pause mid-drain.
  // T-2.7 already AC-tests the firing path at 0.5 USD/h.
  const guard = createCostGuard({
    thresholdUsdPerHour: 1.0,
    minElapsedMsForProjection: 60_000,
    meetingStartTs: 0,
    now: clock,
    paused: settingsStore.getState().costGuardPaused,
  });

  const dedup = createDedupWindow({ windowMs: 60_000, now: clock });

  const questionStore = useQuestionStore;
  questionStore.getState().clear();

  // ── Oracle Haiku classifier ───────────────────────────────────────────────
  // Returns a HaikuClassification whose `isQuestion` mirrors the gold-label
  // 95 % of the time, flipped 5 %. Mints a synthetic usage block so the cost
  // guard and pricing helpers populate.
  let classifyCalls = 0;
  let oracleFlips = 0;
  let haikuVerdictsYes = 0;

  function findFixtureEntry(text: string): FixtureUtterance | undefined {
    // Recover the fixture entry from the utterance text. Some fixture rows
    // already carry trailing punctuation (questions ending in `?`); the
    // sliding-window may also append the test driver's punct. Strip on both
    // sides so the comparison is punctuation-agnostic.
    const norm = (s: string) =>
      s.replace(/[?？.!。！…]+\s*$/, "").trim().toLocaleLowerCase();
    const target = norm(text);
    return fixture.utterances.find((u) => norm(u.text) === target);
  }

  async function oracleClassify(
    text: string,
    _opts?: { apiKey?: string },
  ): Promise<HaikuClassification> {
    classifyCalls += 1;
    // Advance fake clock by ~200ms per Haiku call (per ARCH §12 budget).
    fakeNow += 200;

    const entry = findFixtureEntry(text);
    const goldIsQuestion = entry?.isQuestion ?? false;
    const flip = entry ? seededRand(0xa5a5_a5a5, entry.index) < ORACLE_FLIP_RATE : false;
    if (flip) oracleFlips += 1;
    const isQuestion = flip ? !goldIsQuestion : goldIsQuestion;
    if (isQuestion) haikuVerdictsYes += 1;
    const verdict: HaikuVerdict = isQuestion
      ? { isQuestion: true, confidence: 0.9, reason: "fixture-oracle: YES" }
      : { isQuestion: false, confidence: 0.1, reason: "fixture-oracle: NO" };
    const usage: AnthropicUsage = {
      input_tokens: 4,
      cache_read_input_tokens: 50,
      output_tokens: 20,
    };
    return {
      isQuestion: verdict.isQuestion,
      confidence: verdict.confidence,
      reason: verdict.reason,
      rawText: `${verdict.isQuestion ? "YES" : "NO"} ${verdict.reason}`,
      latencyMs: 200,
      usage,
      costUsd: 0,
    };
  }

  // ── Oracle askClaude ──────────────────────────────────────────────────────
  // Returns a deterministic streaming generator. First-token latency = 1500ms
  // (well under the 10s plan AC); 3 deltas total.
  async function* oracleAsk(
    input: AskClaudeInput,
  ): AsyncGenerator<AskClaudeEvent, AskClaudeResult, void> {
    const entry = findFixtureEntry(input.question);
    const isUseful = entry?.useful === true;
    const deltas = [
      isUseful ? "Per the context, " : "Not sure: ",
      isUseful ? "the answer is grounded " : "context does not cover ",
      isUseful ? "in the meeting agenda." : "this question explicitly.",
    ];
    // First-token at +1500ms.
    fakeNow += 1500;
    yield { type: "delta", text: deltas[0] };
    fakeNow += 200;
    yield { type: "delta", text: deltas[1] };
    fakeNow += 200;
    yield { type: "delta", text: deltas[2] };
    const usage: AnthropicUsage = {
      input_tokens: 10,
      cache_read_input_tokens: 8000,
      output_tokens: 60,
    };
    return {
      text: deltas.join(""),
      usage,
      cacheReadRatio: 0.8,
      costUsd: 0,
      stopReason: "end_turn",
    };
  }

  // ── Pipeline ──────────────────────────────────────────────────────────────
  const window = createSlidingWindow({ silenceThresholdMs: DEFAULT_SILENCE_MS });
  const queue = createQuestionQueue({ maxDepth: 5, now: clock });

  const detectedQuestions: PipelineRunResult["detectedQuestions"] = [];
  // Tracks the fixture entry attached to each enqueued item via verdict.reason
  // (we encode the fixture index into the verdict for traceability through the
  // worker's onItemDone).
  const itemToFixtureIdx = new Map<string, number>();
  let dedupAdmits = 0;
  let dedupRejects = 0;
  let enqueueAdmits = 0;
  let enqueueDropped = 0;
  let candidateCount = 0;

  let inFlight = 0;
  let peakInFlight = 0;

  const firstTokenLatencies: number[] = [];
  const endToEndLatencies: number[] = [];
  let workerCompleted = 0;
  let workerErrors = 0;

  const worker = createQueueWorker({
    queue,
    ask: oracleAsk,
    store: questionStore.getState(),
    getContextDoc: () => "Synthetic meeting context (Phase 2 T-2.10 fixture).",
    getRecentTranscript: () => undefined,
    onItemStart: () => {
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
    },
    onItemDone: (_item: QueuedItem, result: AskClaudeResult) => {
      inFlight -= 1;
      workerCompleted += 1;
      guard.recordSonnetUsage(result.usage);
    },
    onItemError: () => {
      inFlight -= 1;
      workerErrors += 1;
    },
    onMetric: (_item, m) => {
      firstTokenLatencies.push(m.firstTokenLatencyMs);
      endToEndLatencies.push(m.endToEndLatencyMs);
    },
    now: clock,
  });

  const meetingId = "m-phase2-e2e";

  // Drive the fixture: 1 chunk per utterance, isFinal=true with appended
  // sentence-terminator so the sliding window cleanly emits one Utterance per
  // entry. The window's silence-boundary path is implicitly verified by the
  // fixture's gap design (gaps ≥ 800 ms between successive utterances).
  for (const u of fixture.utterances) {
    fakeNow = u.tsMs;
    const punct = chunkPunctuation(u);
    const chunk: TranscriptChunk = {
      id: `c-${u.index}`,
      meetingId,
      text: u.text + punct,
      startTs: u.tsMs,
      endTs: u.endTsMs,
      isFinal: true,
    };
    const utterances = window.push(chunk);
    for (const utt of utterances) {
      const heur = detectCandidate(utt.text);
      if (!heur.isCandidate) continue;
      candidateCount += 1;
      const gateResult = await classifyWithSettingsGate(
        utt.text,
        oracleClassify,
        settingsStore.getState(),
        guard,
      );
      if (gateResult.status !== "classified") continue;
      if (!gateResult.admit) continue;
      // Dedup window (T-2.4) — feed the utterance endTs as the timestamp so
      // the window math is fixture-driven, not clock-driven.
      const dedupResult = dedup.admit(utt.text, utt.endTs);
      if (!dedupResult.admitted) {
        dedupRejects += 1;
        continue;
      }
      dedupAdmits += 1;
      // Move clock to the utterance endTs before enqueuing so the worker's
      // firstTokenLatencyMs measure starts from a sensible base.
      fakeNow = utt.endTs;
      const fixtureEntry = findFixtureEntry(utt.text);
      const verdict: HaikuClassification = gateResult.result;
      const enqueueInput: EnqueueInput = {
        meetingId,
        utterance: utt,
        verdict: {
          isQuestion: verdict.isQuestion,
          confidence: verdict.confidence,
          reason: verdict.reason,
        },
        dedupHash: dedupResult.hash,
      };
      const eq = queue.enqueue(enqueueInput);
      enqueueAdmits += 1;
      if (eq.droppedItemIds && eq.droppedItemIds.length > 0) {
        enqueueDropped += eq.droppedItemIds.length;
      }
      itemToFixtureIdx.set(eq.itemId, fixtureEntry?.index ?? -1);
      worker.notify();
      // Drain to idle between items so the fake clock doesn't get tangled
      // across multiple in-flight asks (single-flight is structurally enforced
      // by the queue, but waiting between items keeps latency bookkeeping
      // attributable per item).
      await worker.waitIdle();

      const detectedFixture = fixtureEntry;
      detectedQuestions.push({
        fixtureIdx: detectedFixture?.index ?? -1,
        text: utt.text,
        useful: detectedFixture?.useful === true,
        isFalsePositive: detectedFixture ? !detectedFixture.isQuestion : true,
      });
    }
  }

  // End-of-meeting flush: emit any pending utterance from the assembler. In
  // this fixture every entry closes via isFinal+punct, so the buffer is empty
  // at end — but exercising the flush call is part of AC-9.
  for (const utt of window.flush()) {
    const heur = detectCandidate(utt.text);
    if (!heur.isCandidate) continue;
    candidateCount += 1;
    // (Same gate path; not expected to fire for this fixture but kept for
    // completeness.)
  }

  worker.stop();
  await worker.waitIdle();

  // ── Metrics ───────────────────────────────────────────────────────────────
  const detectedSetByIdx = new Set<number>();
  for (const dq of detectedQuestions) {
    if (dq.fixtureIdx >= 0) detectedSetByIdx.add(dq.fixtureIdx);
  }
  let caughtGtQuestions = 0;
  for (const u of fixture.utterances) {
    if (u.isQuestion && detectedSetByIdx.has(u.index)) caughtGtQuestions += 1;
  }
  const catchRate = caughtGtQuestions / fixture.questionCount;

  const usefulDetected = detectedQuestions.filter((dq) => dq.useful).length;
  const usefulRate =
    detectedQuestions.length === 0
      ? 0
      : usefulDetected / detectedQuestions.length;

  function p95(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.floor(0.95 * (sorted.length - 1)),
    );
    return sorted[idx];
  }

  return {
    fixtureQuestions: fixture.questionCount,
    fixtureUseful: fixture.usefulCount,
    utteranceCount: fixture.utterances.length,
    candidateCount,
    classifyCalls,
    oracleFlips,
    haikuVerdictsYes,
    dedupAdmits,
    dedupRejects,
    enqueueAdmits,
    enqueueDropped,
    workerCompleted,
    workerErrors,
    catchRate,
    usefulRate,
    firstTokenLatencyP95: p95(firstTokenLatencies),
    endToEndLatencyP95: p95(endToEndLatencies),
    peakInFlight,
    costSnapshot: guard.snapshot(),
    detectedQuestions,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("T-2.10 fixture sanity", () => {
  const f = buildFixture();

  it("F-1: fixture has ≥ 12 questions and ≥ 30 non-questions", () => {
    expect(f.questionCount).toBeGreaterThanOrEqual(12);
    expect(f.nonQuestionCount).toBeGreaterThanOrEqual(30);
  });

  it("F-2: total fixture wall-clock span ≥ 30 minutes", () => {
    expect(f.totalDurationMs).toBeGreaterThanOrEqual(1_800_000);
  });

  it("F-3: every entry's endTsMs > tsMs and inter-entry gap ≥ silence threshold", () => {
    for (let i = 0; i < f.utterances.length; i++) {
      const u = f.utterances[i]!;
      expect(u.endTsMs).toBeGreaterThan(u.tsMs);
      if (i + 1 < f.utterances.length) {
        const next = f.utterances[i + 1]!;
        expect(next.tsMs - u.endTsMs).toBeGreaterThanOrEqual(DEFAULT_SILENCE_MS);
      }
    }
  });

  it("F-4: fixture seeds at least 1 dedup-duplicate pair within 60 s", () => {
    const map = new Map<string, FixtureUtterance[]>();
    for (const u of f.utterances) {
      if (!u.isQuestion) continue;
      const key = u.text.toLowerCase().replace(/[?？.!。！…]+\s*$/, "").trim();
      const list = map.get(key) ?? [];
      list.push(u);
      map.set(key, list);
    }
    let foundDup = false;
    for (const [, list] of map) {
      if (list.length < 2) continue;
      for (let i = 1; i < list.length; i++) {
        const gap = list[i]!.tsMs - list[i - 1]!.endTsMs;
        if (gap < 60_000) {
          foundDup = true;
          break;
        }
      }
      if (foundDup) break;
    }
    expect(foundDup).toBe(true);
  });
});

describe("T-2.10 pipeline E2E (fixture-mode)", () => {
  it("E-1..E-9: drains, hits AC, emits a metric report", async () => {
    const r = await runPipeline();

    // Diagnostic table — visible on `bun run test --reporter verbose`.
    // eslint-disable-next-line no-console
    console.log(
      "\n──── Phase 2 T-2.10 Metric Report (fixture-mode) ────\n" +
        `  fixture utterances ........... ${r.utteranceCount}\n` +
        `  fixture GT questions ......... ${r.fixtureQuestions}\n` +
        `  fixture GT useful ............ ${r.fixtureUseful}\n` +
        `  heuristic candidates ......... ${r.candidateCount}\n` +
        `  Haiku classify calls ......... ${r.classifyCalls}\n` +
        `  oracle flip count ............ ${r.oracleFlips}\n` +
        `  Haiku YES verdicts ........... ${r.haikuVerdictsYes}\n` +
        `  dedup admits ................. ${r.dedupAdmits}\n` +
        `  dedup rejects ................ ${r.dedupRejects}\n` +
        `  queue admits ................. ${r.enqueueAdmits}\n` +
        `  queue dropped (backpressure) . ${r.enqueueDropped}\n` +
        `  worker completed ............. ${r.workerCompleted}\n` +
        `  worker errors ................ ${r.workerErrors}\n` +
        `  peak in-flight ............... ${r.peakInFlight}\n` +
        `  catch rate .................... ${r.catchRate.toFixed(3)}\n` +
        `  useful rate ................... ${r.usefulRate.toFixed(3)}\n` +
        `  first-token p95 (ms) .......... ${r.firstTokenLatencyP95}\n` +
        `  end-to-end p95 (ms) ........... ${r.endToEndLatencyP95}\n` +
        `  haiku cost ................... $${r.costSnapshot.haiku.costUsd.toFixed(6)}\n` +
        `  sonnet cost .................. $${r.costSnapshot.sonnet.costUsd.toFixed(6)}\n` +
        `  total cost ................... $${r.costSnapshot.totalCostUsd.toFixed(6)}\n` +
        `  projected $/h ................ $${r.costSnapshot.projectedCostPerHourUsd.toFixed(6)}\n` +
        "──────────────────────────────────────────────────────\n",
    );

    // E-1: drain ran without throwing.
    expect(r.workerErrors).toBe(0);

    // E-2: AC-1 catch-rate ≥ 0.80.
    expect(r.catchRate).toBeGreaterThanOrEqual(0.8);

    // E-3: AC-2 useful-rate ≥ 0.70.
    expect(r.usefulRate).toBeGreaterThanOrEqual(0.7);

    // E-4: AC-3 end-to-end first-token p95 < 10 000 ms.
    expect(r.firstTokenLatencyP95).toBeLessThan(10_000);

    // E-5: AC-4 single-flight invariant holds.
    expect(r.peakInFlight).toBeLessThanOrEqual(1);

    // E-6: AC-5 cost snapshot non-zero + finite.
    expect(r.costSnapshot.haiku.calls).toBeGreaterThan(0);
    expect(r.costSnapshot.sonnet.calls).toBeGreaterThan(0);
    expect(Number.isFinite(r.costSnapshot.totalCostUsd)).toBe(true);
    expect(Number.isFinite(r.costSnapshot.projectedCostPerHourUsd)).toBe(true);
    expect(r.costSnapshot.totalCostUsd).toBeGreaterThan(0);

    // E-7: AC-6 dedup admitted exactly once for the seeded duplicate.
    expect(r.dedupRejects).toBeGreaterThanOrEqual(1);

    // E-8: every heuristic candidate produced exactly one Haiku call (gate
    // open + not paused).
    expect(r.classifyCalls).toBe(r.candidateCount);
  });
});

describe("T-2.10 settings precedence carry-through", () => {
  it("S-1: haikuEnabled=false skips classification; queue still admits via heuristic-only short-circuit (off in v0.2)", async () => {
    const r = await runPipeline({ haikuEnabled: false });
    // With Haiku disabled the gate returns `skipped-disabled` and the v0.2
    // pipeline does not admit (heuristic-only admit is a Phase-2.x stretch).
    // We assert the absence of classify calls + queue admits to lock in the
    // current contract.
    expect(r.classifyCalls).toBe(0);
    expect(r.enqueueAdmits).toBe(0);
    expect(r.workerCompleted).toBe(0);
  });

  it("S-2: costGuardPaused=true short-circuits Haiku; pipeline drains with no admits", async () => {
    const r = await runPipeline({ costGuardPaused: true });
    expect(r.classifyCalls).toBe(0);
    expect(r.enqueueAdmits).toBe(0);
    expect(r.workerCompleted).toBe(0);
  });
});
