// experimental, not for prod — T-0.5 streaming bench harness.
// Single Anthropic client across all calls (HTTP/2 keep-alive per ARCH §7.3).
// Measures first-token latency from "stream() returns" → first text delta event.
// Captures `usage` from the SSE message_start + message_delta events.

import Anthropic from "@anthropic-ai/sdk";
import { buildRequest, type AnthropicRequestBody } from "./buildPrompt.ts";
import { computeCostUsd, cacheReadRatio, type Usage } from "./pricing.ts";

export type RunResult = {
  run_index: number;                  // 1-based
  ok: boolean;
  first_token_ms: number | null;      // null if no text emitted before stream end
  total_ms: number;
  output_chars: number;
  output_tokens: number;
  usage: Usage;
  cache_read_ratio: number;
  cost_usd: number;
  stop_reason?: string;
  error?: string;
};

export type BenchSummary = {
  runs: number;
  cold_first_token_ms: number;        // run 1
  warm_first_token_ms_avg: number;    // runs 2..N
  warm_first_token_ms_p50: number;
  warm_first_token_ms_p95: number;
  warm_cache_read_ratio_min: number;  // worst warm-call ratio
  warm_cache_read_ratio_avg: number;
  cached_context_tokens: number;      // measured cache_creation on cold call
  cost_total_usd: number;
  cost_warm_avg_usd: number;
  ok: boolean;
  ac_results: Record<string, { pass: boolean; measured: number | string; bar: string }>;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function runOne(
  client: Anthropic,
  body: AnthropicRequestBody,
  runIndex: number,
): Promise<RunResult> {
  const t0 = performance.now();
  let firstTokenAt: number | null = null;
  let outputChars = 0;
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: string | undefined;

  try {
    // Use the high-level helper. It exposes raw `message_start` and `message_delta`
    // events via .on('streamEvent') so we can capture usage cleanly.
    const stream = client.messages.stream(body);

    stream.on("streamEvent", (event: any) => {
      if (event.type === "message_start") {
        const u = event.message?.usage ?? {};
        usage = {
          input_tokens: u.input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
        };
      } else if (event.type === "message_delta") {
        const u = event.usage ?? {};
        if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text ?? "";
        if (firstTokenAt === null && text.length > 0) {
          firstTokenAt = performance.now();
        }
        outputChars += text.length;
      }
    });

    await stream.finalMessage();
    const t1 = performance.now();

    const ratio = cacheReadRatio(usage);
    return {
      run_index: runIndex,
      ok: true,
      first_token_ms: firstTokenAt === null ? null : Math.round(firstTokenAt - t0),
      total_ms: Math.round(t1 - t0),
      output_chars: outputChars,
      output_tokens: usage.output_tokens,
      usage,
      cache_read_ratio: ratio,
      cost_usd: computeCostUsd(usage),
      stop_reason: stopReason,
    };
  } catch (err: any) {
    const t1 = performance.now();
    return {
      run_index: runIndex,
      ok: false,
      first_token_ms: null,
      total_ms: Math.round(t1 - t0),
      output_chars: 0,
      output_tokens: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cache_read_ratio: 0,
      cost_usd: 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function runBench(opts?: {
  runs?: number;
  contextChars?: number;
  apiKey?: string;
  onRun?: (r: RunResult) => void;
}): Promise<{ runs: RunResult[]; summary: BenchSummary }> {
  const N = opts?.runs ?? 10;
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing — set env var before running bench.");
  }
  const client = new Anthropic({ apiKey });
  const body = buildRequest({ contextChars: opts?.contextChars });

  const results: RunResult[] = [];
  for (let i = 1; i <= N; i++) {
    const r = await runOne(client, body, i);
    results.push(r);
    opts?.onRun?.(r);
  }

  // Aggregate
  const cold = results[0];
  const warm = results.slice(1);
  const warmFirstTokens = warm
    .filter((r) => r.ok && r.first_token_ms !== null)
    .map((r) => r.first_token_ms as number)
    .sort((a, b) => a - b);
  const warmRatios = warm.filter((r) => r.ok).map((r) => r.cache_read_ratio);
  const warmCosts = warm.filter((r) => r.ok).map((r) => r.cost_usd);

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  const cachedContextTokens =
    (cold.usage.cache_creation_input_tokens ?? 0) +
    (cold.usage.cache_read_input_tokens ?? 0);

  const summary: BenchSummary = {
    runs: N,
    cold_first_token_ms: cold.first_token_ms ?? NaN,
    warm_first_token_ms_avg: Math.round(avg(warmFirstTokens)),
    warm_first_token_ms_p50: Math.round(quantile(warmFirstTokens, 0.5)),
    warm_first_token_ms_p95: Math.round(quantile(warmFirstTokens, 0.95)),
    warm_cache_read_ratio_min: Math.min(...warmRatios),
    warm_cache_read_ratio_avg: avg(warmRatios),
    cached_context_tokens: cachedContextTokens,
    cost_total_usd: results.reduce((a, r) => a + r.cost_usd, 0),
    cost_warm_avg_usd: avg(warmCosts),
    ok: results.every((r) => r.ok),
    ac_results: {},
  };

  // AC evaluation
  const allFirstTokens = results
    .filter((r) => r.ok && r.first_token_ms !== null)
    .map((r) => r.first_token_ms as number);
  const allAvg = avg(allFirstTokens);

  summary.ac_results["AC-1: avg first-token < 2000ms"] = {
    pass: allAvg < 2000,
    measured: `${Math.round(allAvg)} ms`,
    bar: "< 2000 ms",
  };
  summary.ac_results["AC-2: warm p95 < 2500ms (advisory)"] = {
    pass: summary.warm_first_token_ms_p95 < 2500,
    measured: `${summary.warm_first_token_ms_p95} ms`,
    bar: "< 2500 ms",
  };
  summary.ac_results["AC-3: warm cache_read_ratio > 0.9"] = {
    pass: summary.warm_cache_read_ratio_min > 0.9,
    measured: `min=${summary.warm_cache_read_ratio_min.toFixed(3)} avg=${summary.warm_cache_read_ratio_avg.toFixed(3)}`,
    bar: "> 0.9 on every warm call",
  };
  summary.ac_results["AC-4: cached context >= 20000 tokens"] = {
    pass: summary.cached_context_tokens >= 20_000,
    measured: `${summary.cached_context_tokens} tok`,
    bar: ">= 20000 tok",
  };
  summary.ac_results["AC-5: warm cost <= $0.015 (advisory)"] = {
    pass: summary.cost_warm_avg_usd <= 0.015,
    measured: `$${summary.cost_warm_avg_usd.toFixed(5)}`,
    bar: "<= $0.015 (revised — output tokens dominate at $15/MTok)",
  };
  summary.ac_results["AC-6: 0 errors"] = {
    pass: results.every((r) => r.ok),
    measured: `${results.filter((r) => r.ok).length}/${results.length} ok`,
    bar: "all runs ok",
  };

  // Headline GO requires AC-1, AC-3, AC-4, AC-6 (per task plan §3).
  const gating = ["AC-1: avg first-token < 2000ms", "AC-3: warm cache_read_ratio > 0.9",
    "AC-4: cached context >= 20000 tokens", "AC-6: 0 errors"];
  summary.ok = gating.every((k) => summary.ac_results[k].pass);

  return { runs: results, summary };
}
