// experimental, not for prod — T-0.5 deterministic prompt builder.
// Mirrors the request shape mandated by docs/ARCHITECTURE.md §6.2 and §7.2:
//   system: [STATIC_INSTRUCTIONS (cached), CONTEXT_BLOCK (cached)]
//   messages[0].content: [{ recentTranscript: NOT cached }, { question: NOT cached }]
// Goal of "20k context": ARCH spec phrasing — cached portion ≥ 20 000 tokens.
// Heuristic: ~3.5 chars/token English prose. We over-pad to ~75 000 chars to
// guarantee we clear 20k tokens after tokenization. Verify post-hoc via the
// usage block on call #1 (cache_creation_input_tokens) and tighten if needed.

export const MODEL = "claude-sonnet-4-6" as const;
export const MAX_TOKENS = 600 as const;
export const TARGET_CONTEXT_CHARS = 75_000 as const;

const STATIC_INSTRUCTIONS_TEXT = [
  "You are Meeting Copilot, an in-meeting assistant.",
  "Use the supplied context block to answer questions about the meeting subject.",
  "Cite specific lines from the context when relevant. Keep answers ≤ 150 words.",
  "If the context does not cover the question, say so plainly and label the answer as a general-knowledge guess.",
  "Never invent quotes or numbers that are not in the context.",
].join(" ");

// Synthetic PRD-flavoured paragraph used as a deterministic context filler.
// Repeated until we hit TARGET_CONTEXT_CHARS. Real prod context is the user's
// uploaded PRD/docs; this is just a stand-in to bench cache behaviour.
const FILLER_PARAGRAPH = [
  "The Meeting Copilot product is a desktop application that captures live meeting audio,",
  "transcribes it on-device using MLX whisper, and generates LLM-powered answers to",
  "detected questions while leveraging Anthropic's prompt-cache feature so that the same",
  "20-thousand-token context block is not re-billed on every turn. The PRD specifies a",
  "first-token latency budget of two seconds, a worst-case real-time-factor of one for the",
  "transcription pipeline, and an end-to-end question-to-first-answer-token target of three",
  "seconds. Privacy posture: audio never leaves the host machine. Only text — recent",
  "transcript snippets and the detected question — flows to Anthropic. Cache breakpoints",
  "are placed on the static instructions block and the user-supplied context block, both",
  "marked ephemeral with the standard five-minute TTL. The bench harness in T-0.5 of the",
  "Phase 0 spike validates that warm-cache calls return their first streamed token in well",
  "under two seconds and that cache_read_input_tokens accounts for at least ninety percent",
  "of input tokens on every call after the first.",
].join(" ") + "\n\n";

export function buildContextBlock(targetChars: number = TARGET_CONTEXT_CHARS): string {
  // Deterministic — same string every test run, so cache hashing is stable.
  let out = "# Synthetic Context Block (T-0.5 Spike Filler)\n\n";
  out += "The following content is repeated synthetic prose used solely to exercise\n";
  out += "Anthropic's prompt-cache pricing tier. It is not real product spec.\n\n";
  let i = 0;
  while (out.length < targetChars) {
    out += `## Section ${i}\n\n${FILLER_PARAGRAPH}`;
    i++;
  }
  return out;
}

export const RECENT_TRANSCRIPT_FIXTURE = [
  "Speaker 1: Okay so the next thing on the agenda is the Q3 launch timeline.",
  "Speaker 2: Right — we said we wanted GA by mid-September. Engineering thinks that's still on.",
  "Speaker 1: What about the latency target? Last I heard we were at about 2.4 seconds end-to-end.",
  "Speaker 2: We shaved 400 milliseconds off the streaming path last week. Should be at two flat now.",
  "Speaker 1: Cool. Also — what's the cost per active user looking like with the prompt cache enabled?",
].join(" ");

export const QUESTION_FIXTURE = "What is the current end-to-end latency and how does prompt cache affect it?";

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  temperature: number;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
};

export function buildRequest(opts?: {
  contextChars?: number;
  recentTranscript?: string;
  question?: string;
}): AnthropicRequestBody {
  const contextBlock = buildContextBlock(opts?.contextChars ?? TARGET_CONTEXT_CHARS);
  const transcript = opts?.recentTranscript ?? RECENT_TRANSCRIPT_FIXTURE;
  const question = opts?.question ?? QUESTION_FIXTURE;
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: [
      { type: "text", text: STATIC_INSTRUCTIONS_TEXT, cache_control: { type: "ephemeral" } },
      { type: "text", text: contextBlock, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Recent transcript (last 90s):\n${transcript}` },
          {
            type: "text",
            text:
              `Question detected: "${question}"\n\n` +
              `Đưa ra answer ngắn gọn (≤ 150 từ), reference context block khi có. ` +
              `Nếu context không cover, nói thẳng "không có trong context — guess based on general knowledge".`,
          },
        ],
      },
    ],
  };
}
