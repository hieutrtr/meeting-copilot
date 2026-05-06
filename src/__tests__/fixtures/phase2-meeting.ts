// Phase 2 T-2.10 — synthetic 30-minute meeting transcript fixture.
//
// Each `RawEntry` is one utterance (one final-with-punctuation transcript
// chunk in the test driver). Hand-labeled `isQuestion` is the gold-label for
// the catch-rate metric; `useful` is the gold-label "would Sonnet produce a
// useful answer here" boolean for the useful-rate metric.
//
// Cadence: ~50 utterances over 30 minutes (1 800 000 ms). Mixed EN + VI to
// exercise both heuristic detector branches (T-2.1 wh-en, modal-en, wh-vi).
// One pair of near-identical questions is seeded for the dedup-window AC-6.
//
// The fixture is intentionally biased toward strong-signal questions (qmark +
// wh-aux pattern) so heuristic recall ≥ 0.95 — see T-2.10 task spec §"Risk R-5".

export interface RawEntry {
  text: string;
  isQuestion: boolean;
  useful?: boolean;
  durationMs: number;
  gapToNextMs?: number;
}

export interface FixtureUtterance {
  index: number;
  text: string;
  isQuestion: boolean;
  useful: boolean | null;
  tsMs: number;
  endTsMs: number;
}

export interface FixtureManifest {
  totalDurationMs: number;
  questionCount: number;
  nonQuestionCount: number;
  usefulCount: number;
  utterances: FixtureUtterance[];
}

const DEFAULT_GAP_MS = 30_000;

// 50 utterances. Order is meaningful — duplicate seed (entry 28+30) tests
// the dedup window. Edits should preserve question-density and at least one
// duplicate pair within 60 s.
const RAW: RawEntry[] = [
  // Opening — 0:00..0:30
  { text: "Alright everybody, thanks for joining the launch sync today.", isQuestion: false, durationMs: 4500, gapToNextMs: 1000 },
  { text: "Let me share my screen and we'll go through the agenda.", isQuestion: false, durationMs: 3500, gapToNextMs: 1500 },

  // Burst — early Q&A on agenda + migration  (~0:35..2:00)
  { text: "What's on the agenda for today's meeting?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 1500 },
  { text: "We have three blockers, the migration script, the auth refresh, and the staging cutover plan.", isQuestion: false, durationMs: 7000, gapToNextMs: 1500 },
  { text: "Can you walk us through the migration script status?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "Sure, the migration script is at 80 percent — we're handling the index rebuild step right now.", isQuestion: false, durationMs: 7500, gapToNextMs: 1500 },
  { text: "How long will the index rebuild take in production?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 1500 },
  { text: "Probably forty minutes given the row count, but we'll batch it.", isQuestion: false, durationMs: 6000, gapToNextMs: 1000 },

  // Pause + statement-only stretch (~2:00..3:30) — exercise non-Q heuristic-quiet path
  { text: "That's good to know.", isQuestion: false, durationMs: 2500, gapToNextMs: 1500 },
  { text: "I think the team has done a great job on the migration plan.", isQuestion: false, durationMs: 4500, gapToNextMs: 180_000 },

  // Cutover + scheduling (~4:30..6:00)
  { text: "When is the staging cutover scheduled?", isQuestion: true, useful: true, durationMs: 4500, gapToNextMs: 1500 },
  { text: "Staging goes live next Tuesday at 10am Pacific.", isQuestion: false, durationMs: 5500, gapToNextMs: 1500 },
  { text: "Should we postpone if the migration is still running?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 1500 },
  { text: "Yes, we have a hard go/no-go gate.", isQuestion: false, durationMs: 4000, gapToNextMs: 2000 },

  // Vietnamese block — exercises wh-vi heuristic (~6:30..8:00)
  { text: "Tại sao chúng ta không dùng feature flag để rollback?", isQuestion: true, useful: true, durationMs: 4500, gapToNextMs: 1500 },
  { text: "Feature flag đã có sẵn nhưng team mobile chưa pull bản mới.", isQuestion: false, durationMs: 6500, gapToNextMs: 1500 },
  { text: "Got it, so we need mobile to pull the SDK update first.", isQuestion: false, durationMs: 3000, gapToNextMs: 1500 },
  { text: "Who owns the mobile SDK update task?", isQuestion: true, useful: true, durationMs: 4500, gapToNextMs: 1500 },
  { text: "Thuy is leading that, she'll have it merged by Thursday.", isQuestion: false, durationMs: 3000, gapToNextMs: 240_000 },

  // Mid-meeting filler + metrics block (~10:00..11:30)
  { text: "Cool.", isQuestion: false, durationMs: 1200, gapToNextMs: 1500 },
  { text: "Let me move on to the next blocker.", isQuestion: false, durationMs: 3000, gapToNextMs: 1500 },
  { text: "I'll show you the latest staging metrics.", isQuestion: false, durationMs: 5000, gapToNextMs: 1500 },
  { text: "What are the latest staging error rates?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 1500 },
  { text: "Error rate is at 0.4 percent, mostly the legacy auth fallback path.", isQuestion: false, durationMs: 6000, gapToNextMs: 180_000 },

  // Statement run (~12:30..13:30)
  { text: "That seems acceptable for the current rollout.", isQuestion: false, durationMs: 2500, gapToNextMs: 1500 },
  { text: "I think we should add a circuit breaker on that endpoint.", isQuestion: false, durationMs: 3500, gapToNextMs: 1500 },
  { text: "I think we have enough headroom for the launch.", isQuestion: false, durationMs: 5000, gapToNextMs: 180_000 },

  // VI Q + duplicate-seed pair (~14:30..16:00)
  { text: "Bao giờ chúng ta phát hành phiên bản mới?", isQuestion: true, useful: true, durationMs: 3500, gapToNextMs: 1500 },
  { text: "Phiên bản mới phát hành vào thứ hai tuần sau.", isQuestion: false, durationMs: 3500, gapToNextMs: 1500 },
  // ── DUPLICATE SEED A ────────────────────────────────────────────────
  { text: "What's the deadline for the launch?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "Launch deadline is end of month, fixed by GTM.", isQuestion: false, durationMs: 4500, gapToNextMs: 1500 },
  // ── DUPLICATE SEED B (same normalized hash, within 60 s) ────────────
  { text: "What's the deadline for the launch?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "Same as before, end of month.", isQuestion: false, durationMs: 5000, gapToNextMs: 180_000 },

  // SLO + on-call (~17:00..19:00)
  { text: "Could you remind me what the SLO is for the new endpoint?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "SLO is 200ms p95, 99.9 percent availability over a 30-day rolling window.", isQuestion: false, durationMs: 5000, gapToNextMs: 2000 },
  { text: "Is there a runbook for the on-call rotation?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "Yes, runbook is at /oncall/launch-2026 in the wiki.", isQuestion: false, durationMs: 4000, gapToNextMs: 2000 },
  { text: "What does the on-call schedule look like for launch week?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "Mai is primary, Khang is secondary, with Lan as the escalation contact.", isQuestion: false, durationMs: 5000, gapToNextMs: 180_000 },

  // Dashboards + closing prep (~21:00..23:30)
  { text: "Where is the dashboard for the launch metrics?", isQuestion: true, useful: true, durationMs: 3500, gapToNextMs: 1500 },
  { text: "Grafana board /launch-2026, panel four shows the headline KPIs.", isQuestion: false, durationMs: 5000, gapToNextMs: 2000 },
  { text: "I think that covers most of the open items for today.", isQuestion: false, durationMs: 3000, gapToNextMs: 2000 },
  { text: "Actually, let's also discuss the security review checklist.", isQuestion: false, durationMs: 5000, gapToNextMs: 240_000 },

  // Security + closing (~25:00..28:30)
  { text: "Has security signed off on the new endpoints?", isQuestion: true, useful: true, durationMs: 4500, gapToNextMs: 2000 },
  { text: "Security signed off last Friday, all green.", isQuestion: false, durationMs: 3500, gapToNextMs: 1500 },
  { text: "Will we run a final pen test before launch?", isQuestion: true, useful: true, durationMs: 4000, gapToNextMs: 2000 },
  { text: "We're scheduling it for next Wednesday.", isQuestion: false, durationMs: 4000, gapToNextMs: 2000 },
  { text: "How can we make sure the rollback path is tested?", isQuestion: true, useful: false, durationMs: 3500, gapToNextMs: 1500 },
  { text: "We'll do a dry run on staging this Friday with the rollback toggle.", isQuestion: false, durationMs: 5500, gapToNextMs: 240_000 },

  // Wrap-up (~30:00 — slightly past)
  { text: "Awesome, that's all from my side.", isQuestion: false, durationMs: 3000, gapToNextMs: 2000 },
  { text: "Anyone else have follow-ups before we wrap?", isQuestion: true, useful: false, durationMs: 4000, gapToNextMs: 0 },
];

export function buildFixture(): FixtureManifest {
  const utterances: FixtureUtterance[] = [];
  let cursor = 0;
  for (let i = 0; i < RAW.length; i++) {
    const e = RAW[i];
    const tsMs = cursor;
    const endTsMs = cursor + e.durationMs;
    utterances.push({
      index: i,
      text: e.text,
      isQuestion: e.isQuestion,
      useful: e.isQuestion ? e.useful ?? false : null,
      tsMs,
      endTsMs,
    });
    cursor = endTsMs + (e.gapToNextMs ?? DEFAULT_GAP_MS);
  }
  const totalDurationMs = utterances[utterances.length - 1]!.endTsMs;
  const questionCount = utterances.filter((u) => u.isQuestion).length;
  const usefulCount = utterances.filter(
    (u) => u.isQuestion && u.useful === true,
  ).length;
  return {
    totalDurationMs,
    questionCount,
    nonQuestionCount: utterances.length - questionCount,
    usefulCount,
    utterances,
  };
}

// Punctuation appended on chunk emission to ensure the sliding-window's
// `endPunct` boundary closes the buffer (one chunk = one utterance, no
// silence-fall-back needed). Q's get `?`, statements get `.`.
export function chunkPunctuation(u: FixtureUtterance): string {
  const trimmed = u.text.trim();
  if (/[?？.!。！…]\s*$/.test(trimmed)) return "";
  return u.isQuestion ? "?" : ".";
}
