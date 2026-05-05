// Phase 1 T-1.10 — Claude streaming Q&A with prompt cache.
//
// Two-block ephemeral cache layout per ARCH §6.2:
//   system: [STATIC_INSTRUCTIONS, CONTEXT_BLOCK]   (both cache_control)
//   messages[0].user.content: [recentTranscript, question]   (NEVER cached)
//
// Public surface: `askClaude(input, opts?)` returns an `AsyncGenerator<Event,
// AskClaudeResult>`. T-1.11's AnswerPanel `for await`s deltas; the final
// `result` lands as the generator's return value (`step.value` once `done`).
//
// Phase 0 spike `experiments/T-0.5/` proved this shape both structurally and
// live (warm-cache first-token < 2s, cache_read_ratio > 0.9). This file lifts
// the proven shape into prod under TDD; live re-verify happens in T-1.13.

import Anthropic from "@anthropic-ai/sdk";

import {
  cacheReadRatio,
  computeCostUsd,
  type AnthropicUsage,
} from "./pricing";

export const MODEL = "claude-sonnet-4-6" as const;
export const MAX_TOKENS = 600 as const;
export const TEMPERATURE = 0 as const;

const STATIC_INSTRUCTIONS_TEXT = [
  "You are Meeting Copilot, an in-meeting assistant.",
  "Use the supplied context block to answer questions about the meeting subject.",
  "Cite specific lines from the context when relevant. Keep answers ≤ 150 words.",
  "If the context does not cover the question, say so plainly and label the answer as a general-knowledge guess.",
  "Never invent quotes or numbers that are not in the context.",
].join(" ");

const NO_TRANSCRIPT_PLACEHOLDER = "(no recent transcript yet)";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Anthropic API key not configured — set ANTHROPIC_API_KEY in your environment or pass `apiKey` to askClaude().",
    );
    this.name = "MissingApiKeyError";
  }
}

export interface AskClaudeInput {
  question: string;
  contextDoc: string;
  recentTranscript?: string;
}

export interface AskClaudeOptions {
  apiKey?: string;
}

export type AskClaudeEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: AnthropicUsage }
  | { type: "stopReason"; reason: string };

export interface AskClaudeResult {
  text: string;
  usage: AnthropicUsage;
  cacheReadRatio: number;
  costUsd: number;
  stopReason?: string;
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

interface AnthropicUserContentPart {
  type: "text";
  text: string;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  temperature: number;
  system: AnthropicSystemBlock[];
  messages: Array<{
    role: "user";
    content: AnthropicUserContentPart[];
  }>;
}

export function buildRequest(input: AskClaudeInput): AnthropicRequestBody {
  const transcript =
    input.recentTranscript && input.recentTranscript.length > 0
      ? input.recentTranscript
      : NO_TRANSCRIPT_PLACEHOLDER;

  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: STATIC_INSTRUCTIONS_TEXT,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: input.contextDoc,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Recent transcript (last 90s):\n${transcript}` },
          {
            type: "text",
            text: `Question detected: "${input.question}"\n\nĐưa ra answer ngắn gọn (≤ 150 từ), reference context block khi có. Nếu context không cover, nói thẳng "không có trong context — guess based on general knowledge".`,
          },
        ],
      },
    ],
  };
}

function resolveApiKey(opts?: AskClaudeOptions): string {
  const explicit = opts?.apiKey;
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.length > 0) return env;
  throw new MissingApiKeyError();
}

// Bridge between the SDK's event-emitter `text` callback and an async
// generator. The producer pushes text fragments into a queue; the generator
// awaits `next` Promises that the producer resolves.
class DeltaQueue {
  private buf: string[] = [];
  private waiters: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;
  private err: Error | null = null;

  push(text: string): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: text, done: false });
    else this.buf.push(text);
  }

  fail(err: Error): void {
    this.err = err;
    this.close();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<string>> {
    if (this.err) return Promise.reject(this.err);
    const head = this.buf.shift();
    if (head !== undefined) return Promise.resolve({ value: head, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function askClaude(
  input: AskClaudeInput,
  opts?: AskClaudeOptions,
): AsyncGenerator<AskClaudeEvent, AskClaudeResult, void> {
  // AC-5: synchronous credential gate — must throw BEFORE entering the
  // generator so the UI doesn't have to enter a `for await` to learn the
  // key is missing.
  const apiKey = resolveApiKey(opts);
  const body = buildRequest(input);

  return runStream(apiKey, body);
}

async function* runStream(
  apiKey: string,
  body: AnthropicRequestBody,
): AsyncGenerator<AskClaudeEvent, AskClaudeResult, void> {
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream(body) as unknown as {
    on: (event: string, cb: (arg: unknown) => void) => unknown;
    finalMessage: () => Promise<{
      content?: Array<{ type: string; text?: string }>;
      usage?: AnthropicUsage;
      stop_reason?: string;
    }>;
  };

  const queue = new DeltaQueue();
  let aggregated = "";

  stream.on("text", (text: unknown) => {
    if (typeof text !== "string" || text.length === 0) return;
    aggregated += text;
    queue.push(text);
  });

  // `finalMessage()` resolves with the assembled message + usage block. We
  // race the promise against the queue so deltas yield as they arrive. If it
  // rejects, the queue surfaces the error to the consumer; we swallow the
  // promise's own rejection here to avoid an unhandledRejection warning.
  let finalMsg: Awaited<ReturnType<typeof stream.finalMessage>> | undefined;
  let finalErr: Error | null = null;
  const finalP = stream.finalMessage().then(
    (msg) => {
      finalMsg = msg;
      queue.close();
    },
    (err: unknown) => {
      finalErr = err instanceof Error ? err : new Error(String(err));
      queue.fail(finalErr);
    },
  );

  // Yield deltas as they land. queue.next() rejects if finalMessage() failed.
  while (true) {
    const step = await queue.next();
    if (step.done) break;
    yield { type: "delta", text: step.value };
  }

  await finalP;
  if (finalErr) throw finalErr;
  if (!finalMsg) throw new Error("Claude stream ended without a final message");
  const usage: AnthropicUsage = finalMsg.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
  };
  const stopReason = finalMsg.stop_reason;

  yield { type: "usage", usage };
  if (stopReason) yield { type: "stopReason", reason: stopReason };

  return {
    text: aggregated,
    usage,
    cacheReadRatio: cacheReadRatio(usage),
    costUsd: computeCostUsd(usage),
    stopReason,
  };
}
