// Phase 2 T-2.1 — Stage 1 heuristic question detector.
//
// Pure, side-effect-free. Operates on a single utterance text string.
// Returns an `isCandidate` verdict + the list of triggered signals so the
// caller (T-2.3 Haiku filter) can log/observe what fired.
//
// Tuning bias: permissive on recall, lets Stage 2 Haiku trim false positives.
// AC: precision ≥ 0.70, recall ≥ 0.80 on the 50-sample fixture.

export type HeuristicSignal =
  | "qmark"
  | "wh-en"
  | "wh-vi"
  | "modal-en"
  | "long-stmt";

export interface HeuristicResult {
  isCandidate: boolean;
  signals: HeuristicSignal[];
}

export interface HeuristicOptions {
  // Minimum length (chars, trimmed) for `long-stmt` co-signal. Default 50.
  longStmtMinLen?: number;
}

const WH_EN = /\b(what|why|how|when|where|who|which|whose|whom)\b/i;
// English wh + auxiliary/copula or do-support — narrows declarative noise.
// Note: `to` is intentionally NOT in the aux list — "what to do" / "where to go"
// are noun phrases, not questions. Contractions like "what's" don't match here
// (no whitespace between wh + clitic) and fall back to bare WH_EN below.
const WH_EN_AUX = /\b(what|why|how|when|where|who|which|whose|whom)\b\s+\b(is|are|was|were|do|does|did|can|could|would|should|will|may|might|has|have|had|am)\b/i;

// Modal/aux-fronted question (English): "Can you ...", "Should we ...", "Do you ...".
const MODAL_EN = /\b(can|could|would|should|will|won't|may|might|must|shall|do|does|did|is|are|was|were|has|have|had|am)\b\s+\b(you|we|i|they|he|she|it|there|that|this|anyone|someone|everybody)\b/i;

// Vietnamese question particles / patterns. Match raw + diacritic-stripped form.
const WH_VI_RAW = /(\bgì\b|\bnào\b|\bsao\b|\bđâu\b|\bbao giờ\b|\bkhi nào\b|\bở đâu\b|\btại sao\b|\bthế nào\b|\blàm sao\b|\blàm thế nào\b|\bra sao\b|\bphải không\b|\bđúng không\b|\bđã[^?.!]{1,40}\bchưa\b|\bcó[^?.!]{1,40}\bkhông\b|\b(?:là|có)\s+gì\b)/i;
// Diacritic-stripped forms (low-confidence STT may drop accents).
const WH_VI_STRIPPED = /(\bgi\b|\bnao\b|\bsao\b|\bdau\b|\bbao gio\b|\bkhi nao\b|\bo dau\b|\btai sao\b|\bthe nao\b|\blam sao\b|\blam the nao\b|\bra sao\b|\bphai khong\b|\bdung khong\b|\bda[^?.!]{1,40}\bchua\b|\bco[^?.!]{1,40}\bkhong\b|\b(?:la|co)\s+gi\b)/i;

// Strip Vietnamese diacritics so the stripped regex can match transcripts
// that lost accents in low-confidence STT. Covers the seven Vietnamese tone
// marks plus the đ/Đ pair.
function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// Cheap declarative-noise filter: phrases that contain wh-words but are
// almost always statements ("I know what you mean", "Tell me how it works").
// We only suppress *if* the wh-word match is the sole signal (qmark or
// modal-fronted patterns override).
const DECLARATIVE_LEADERS = /^\s*(i\b|we\b|they\b|he\b|she\b|let me\b|let's\b|tell me\b|show me\b|explain\b|i'll\b|i'm\b|i've\b|that's\b|here's\b|here is\b|this is\b|that is\b|it is\b|it's\b)/i;

export function detectCandidate(
  text: string,
  opts?: HeuristicOptions,
): HeuristicResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { isCandidate: false, signals: [] };

  const longMin = opts?.longStmtMinLen ?? 50;
  const signals: HeuristicSignal[] = [];

  if (/[?？]\s*$/.test(trimmed)) signals.push("qmark");

  const stripped = stripDiacritics(trimmed);

  if (WH_VI_RAW.test(trimmed) || WH_VI_STRIPPED.test(stripped)) {
    signals.push("wh-vi");
  }

  // English wh-aux pattern is strictly stronger than bare wh; only fire one.
  if (WH_EN_AUX.test(trimmed)) {
    signals.push("wh-en");
  } else if (WH_EN.test(trimmed) && !DECLARATIVE_LEADERS.test(trimmed)) {
    // Bare wh-word without aux + not a declarative leader → still a weak signal.
    signals.push("wh-en");
  }

  if (MODAL_EN.test(trimmed)) signals.push("modal-en");

  if (signals.length > 0 && trimmed.length > longMin) {
    signals.push("long-stmt");
  }

  return { isCandidate: signals.length > 0, signals };
}
