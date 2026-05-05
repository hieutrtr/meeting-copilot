// Phase 2 T-2.3 — Stage 2 LLM filter (Haiku 4.5).
//
// Pipeline position (per ARCH §5.1): heuristic candidate (T-2.1) → sliding-
// window utterance (T-2.2) → THIS module → admit gate (T-2.5 queue).
//
// The classifier asks `claude-haiku-4-5-20251001` to reply on a single line:
// `YES <reason>` or `NO <reason>`. We parse the leading YES/NO into a boolean
// + a confidence (0.9 / 0.1; 0.5 for ambiguous replies). T-2.5 admits only when
// `confidence ≥ HAIKU_ADMIT_THRESHOLD` (0.7).
//
// Non-streaming `messages.create` is used (vs. Sonnet's stream): output is
// short (≤ 80 tokens), the consumer only needs the final verdict, and the
// non-stream path has slightly less wire overhead at this length. The static
// instructions block is `cache_control: ephemeral` so warm-cache calls reuse it
// (per ARCH §6.2 same shape as Sonnet).

import Anthropic from "@anthropic-ai/sdk";

import {
  computeHaikuCostUsd,
  type AnthropicUsage,
} from "./pricing";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001" as const;
export const HAIKU_MAX_TOKENS = 80 as const;
export const HAIKU_TEMPERATURE = 0 as const;
// Verdict-score gate consumed by T-2.5 queue. YES → 0.9, NO → 0.1, ambiguous
// → 0.5; only ≥ 0.7 admits.
export const HAIKU_ADMIT_THRESHOLD = 0.7 as const;

const HAIKU_SYSTEM_TEXT = [
  "You are a question classifier for a meeting transcript.",
  "Decide whether the given utterance is a real question that the user (a meeting participant with access to a context document) should answer.",
  "Reply on a single line: 'YES <one-sentence reason>' or 'NO <one-sentence reason>'.",
  "Treat embedded interrogatives ('I wonder how X', 'let me think about what Y') and rhetorical exclamations ('what a mess') as NO.",
  "Treat imperatives ('tell me about X', 'show me Y') as NO unless the speaker is explicitly asking for an answer.",
  "Vietnamese and English utterances are both possible.",
].join(" ");

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Anthropic API key not configured — set ANTHROPIC_API_KEY in your environment or pass `apiKey` to classifyWithHaiku().",
    );
    this.name = "MissingApiKeyError";
  }
}

export interface HaikuRequestSystemBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

export interface HaikuRequestUserPart {
  type: "text";
  text: string;
}

export interface HaikuRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  system: HaikuRequestSystemBlock[];
  messages: Array<{
    role: "user";
    content: HaikuRequestUserPart[];
  }>;
}

export interface ClassifyOptions {
  apiKey?: string;
}

export interface HaikuClassification {
  isQuestion: boolean;
  confidence: number;
  reason: string;
  rawText: string;
  latencyMs: number;
  usage: AnthropicUsage;
  costUsd: number;
}

export interface HaikuVerdict {
  isQuestion: boolean;
  confidence: number;
  reason: string;
}

export function buildHaikuRequest(text: string): HaikuRequestBody {
  return {
    model: HAIKU_MODEL,
    max_tokens: HAIKU_MAX_TOKENS,
    temperature: HAIKU_TEMPERATURE,
    system: [
      {
        type: "text",
        text: HAIKU_SYSTEM_TEXT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Utterance: ${text}` },
        ],
      },
    ],
  };
}

// Robust to: leading whitespace, "YES"/"Yes"/"yes", trailing punctuation
// (`YES,`, `YES.`, `YES:`), `YES — reason`, multi-line replies (use first
// non-empty line), and CJK quote wrappers around the verdict word.
const VERDICT_LINE = /^[\s"'“”'"`]*([A-Za-z]+)[\s,.:;—–-]*(.*)$/;

export function parseHaikuVerdict(raw: string): HaikuVerdict {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { isQuestion: false, confidence: 0.5, reason: "" };
  }
  const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0) ?? trimmed;
  const m = VERDICT_LINE.exec(firstLine);
  const head = (m?.[1] ?? "").toUpperCase();
  const tail = (m?.[2] ?? "").trim();

  if (head === "YES") {
    return { isQuestion: true, confidence: 0.9, reason: tail };
  }
  if (head === "NO") {
    return { isQuestion: false, confidence: 0.1, reason: tail };
  }
  return { isQuestion: false, confidence: 0.5, reason: trimmed };
}

function resolveApiKey(opts?: ClassifyOptions): string {
  const explicit = opts?.apiKey;
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.length > 0) return env;
  throw new MissingApiKeyError();
}

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: AnthropicUsage;
  stop_reason?: string;
}

export async function classifyWithHaiku(
  text: string,
  opts?: ClassifyOptions,
): Promise<HaikuClassification> {
  // Synchronous credential gate — same shape as askClaude(): the caller
  // (queue) drops the candidate without entering an awaited path if the
  // key is missing.
  const apiKey = resolveApiKey(opts);
  const body = buildHaikuRequest(text);
  const client = new Anthropic({ apiKey });

  const t0 =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const response = (await (client.messages as unknown as {
    create: (b: HaikuRequestBody) => Promise<AnthropicMessageResponse>;
  }).create(body)) as AnthropicMessageResponse;

  const t1 =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const rawText = (response.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  const verdict = parseHaikuVerdict(rawText);
  const usage: AnthropicUsage = response.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
  };

  return {
    isQuestion: verdict.isQuestion,
    confidence: verdict.confidence,
    reason: verdict.reason,
    rawText,
    latencyMs: Math.max(0, t1 - t0),
    usage,
    costUsd: computeHaikuCostUsd(usage),
  };
}
