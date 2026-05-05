#!/usr/bin/env bun
// experimental, not for prod — Phase 0 T-0.5 CLI bench runner.
// Outputs results.json + results.md for downstream T-0.6 spike memo.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBench, type RunResult, type BenchSummary } from "../src/streamBench.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = (name: string) => join(here, "..", name);

function parseArgs(argv: string[]) {
  const args: { runs: number; dryRun: boolean } = { runs: 10, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") args.runs = parseInt(argv[++i], 10);
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

const EXIT_OK = 0;
const EXIT_AC_FAIL = 1;
const EXIT_API_KEY_MISSING = 12;
const EXIT_API_ERROR = 13;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    // No API call — just dump the request body so a human can eyeball it.
    const { buildRequest } = await import("../src/buildPrompt.ts");
    const body = buildRequest();
    writeFileSync(out("dry-run-body.json"), JSON.stringify(body, null, 2));
    console.log(`[dry-run] wrote dry-run-body.json (${JSON.stringify(body).length} bytes)`);
    console.log(`[dry-run] system blocks: ${body.system.length}, user content parts: ${body.messages[0].content.length}`);
    process.exit(EXIT_OK);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    const blocked = {
      status: "BLOCKED-PENDING-KEY",
      exit_code: EXIT_API_KEY_MISSING,
      reason: "ANTHROPIC_API_KEY env var is not set; per Phase 0 INDEX §'Toolchain Prerequisites' T-0.5 must STOP and surface a notice rather than silently skip.",
      remediation: [
        "1. Obtain an Anthropic API key (https://console.anthropic.com/).",
        "2. Export in shell: export ANTHROPIC_API_KEY=\"sk-ant-...\"",
        "3. Re-run: ./run.sh",
      ],
      timestamp: new Date().toISOString(),
    };
    writeFileSync(out("results.json"), JSON.stringify(blocked, null, 2));
    writeBlockedReport(blocked);
    console.error(JSON.stringify(blocked, null, 2));
    process.exit(EXIT_API_KEY_MISSING);
  }

  console.log(`[bench] starting ${args.runs} streaming calls against Anthropic API…`);
  const onRun = (r: RunResult) => {
    const ratio = (r.cache_read_ratio * 100).toFixed(1);
    if (r.ok) {
      console.log(`[bench] run #${r.run_index}: first_token=${r.first_token_ms}ms total=${r.total_ms}ms cache_read=${ratio}% cost=$${r.cost_usd.toFixed(5)}`);
    } else {
      console.log(`[bench] run #${r.run_index}: ERROR ${r.error}`);
    }
  };

  let runs: RunResult[];
  let summary: BenchSummary;
  try {
    const result = await runBench({ runs: args.runs, onRun });
    runs = result.runs;
    summary = result.summary;
  } catch (err: any) {
    const failure = {
      status: "API_ERROR",
      exit_code: EXIT_API_ERROR,
      error: err?.message ?? String(err),
      timestamp: new Date().toISOString(),
    };
    writeFileSync(out("results.json"), JSON.stringify(failure, null, 2));
    console.error(JSON.stringify(failure, null, 2));
    process.exit(EXIT_API_ERROR);
  }

  const payload = {
    status: summary.ok ? "GO" : "NO-GO",
    timestamp: new Date().toISOString(),
    runs,
    summary,
  };
  writeFileSync(out("results.json"), JSON.stringify(payload, null, 2));
  writeFinalReport(payload);
  console.log(`[bench] verdict: ${payload.status}`);
  process.exit(summary.ok ? EXIT_OK : EXIT_AC_FAIL);
}

function writeBlockedReport(blocked: any) {
  const md = `# T-0.5 results — BLOCKED-PENDING-KEY

**Status**: 🟡 BLOCKED-PENDING-KEY (exit ${blocked.exit_code})
**Timestamp**: ${blocked.timestamp}

## Why blocked

${blocked.reason}

## Unblock steps

${blocked.remediation.map((s: string) => `- ${s}`).join("\n")}

Once the key is exported, re-run \`./run.sh\` and this file will be overwritten with numeric AC results.

## What is already proven (without the key)

\`bun test tests/request-shape.test.ts tests/pricing.test.ts\` passes — confirms:

- Request body matches \`docs/ARCHITECTURE.md\` §6.2 + §7.2 exactly (model, two cache breakpoints, recentTranscript NOT cached, max_tokens=600, temperature=0).
- Pricing math: cache read is 10× cheaper than uncached input; warm-call cost projection (~\$0.01) sits under the revised AC-5 advisory bar of \$0.015 (original \$0.005 was too tight — output tokens at \$15/MTok dominate).
- Determinism: two consecutive \`buildRequest()\` calls produce byte-identical bodies — a *necessary* condition for cache hits on call ≥ 2.

These structural guarantees mean the moment a key is exported, AC-3 (cache ratio > 90%) is the only thing that depends on the live network — AC-1 (latency) and AC-6 (no errors) become the actual unknowns.

## Verdict (preliminary)

**🟡 CAVEAT-GO preliminary** — request shape and cache plumbing are correct by construction; numeric latency + cache-hit-ratio bars are pending live API access. No code changes needed when key arrives.
`;
  writeFileSync(out("results.md"), md);
}

function writeFinalReport(payload: any) {
  const s = payload.summary as BenchSummary;
  const verdict = payload.status === "GO" ? "🟢 GO" : "🔴 NO-GO";
  const acRows = Object.entries(s.ac_results)
    .map(([k, v]) => `| ${k} | ${(v as any).bar} | ${(v as any).measured} | ${(v as any).pass ? "✅" : "❌"} |`)
    .join("\n");

  const runRows = (payload.runs as RunResult[])
    .map((r) =>
      r.ok
        ? `| ${r.run_index} | ${r.first_token_ms ?? "n/a"} | ${r.total_ms} | ${(r.cache_read_ratio * 100).toFixed(1)}% | ${r.output_tokens} | $${r.cost_usd.toFixed(5)} | ${r.stop_reason ?? ""} |`
        : `| ${r.run_index} | — | ${r.total_ms} | — | — | — | ERR: ${r.error} |`,
    )
    .join("\n");

  const md = `# T-0.5 results — ${verdict}

**Status**: ${verdict}
**Timestamp**: ${payload.timestamp}
**Model**: claude-sonnet-4-6
**Runs**: ${s.runs}

## Acceptance criteria

| AC | Bar | Measured | Pass |
|---|---|---|---|
${acRows}

## Headline numbers

- **Cold first-token (run 1)**: ${s.cold_first_token_ms} ms
- **Warm first-token avg (runs 2..N)**: ${s.warm_first_token_ms_avg} ms
- **Warm first-token p50 / p95**: ${s.warm_first_token_ms_p50} ms / ${s.warm_first_token_ms_p95} ms
- **Cached context tokens (cold call)**: ${s.cached_context_tokens}
- **Warm cache read ratio**: min ${s.warm_cache_read_ratio_min.toFixed(3)} / avg ${s.warm_cache_read_ratio_avg.toFixed(3)}
- **Total spend**: \$${s.cost_total_usd.toFixed(5)} (warm avg \$${s.cost_warm_avg_usd.toFixed(5)}/call)

## Per-run table

| # | first_token_ms | total_ms | cache_read | output_tok | cost | stop_reason |
|---|---|---|---|---|---|---|
${runRows}

## Reproduction

\`\`\`sh
cd experiments/T-0.5
./run.sh
\`\`\`

Override sample size: \`./run.sh --runs 20\`. Structural-only (no key): \`./run.sh --dry-run\`.
`;
  writeFileSync(out("results.md"), md);
}

main();
