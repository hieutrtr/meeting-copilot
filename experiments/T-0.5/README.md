# T-0.5 — Claude streaming + prompt cache @ 20k context

> **EXPERIMENTAL — NOT FOR PROD.** Phase 0 spike code under `experiments/`.
> Throwaway by design; real Claude integration code lands in Phase 1 (`apps/`).

Owns **UNKNOWN #3**: *Claude streaming + prompt cache: first-token < 2s on 20k context, cache hit > 90%.*

## Layout

```
package.json                       # bun + @anthropic-ai/sdk pin
src/
  buildPrompt.ts                   # deterministic 20k-token context + ARCH §7.2 request shape
  streamBench.ts                   # single-client harness, first-token timer, AC eval
  pricing.ts                       # Sonnet 4.6 price constants + cost calc
tests/
  request-shape.test.ts            # NO KEY: gates ARCH §6.2 / §7.2 request body
  pricing.test.ts                  # NO KEY: gates pricing math
  live-bench.test.ts               # 10 live streaming calls; SKIPS without key
scripts/
  run-bench.ts                     # CLI entry; writes results.json + results.md
run.sh                             # one-command repro: structural tests → live bench
results.md / results.json          # populated by run.sh (verdict + per-run rows)
bench.log                          # raw stdout of last run
```

## Reproduce

```sh
# Full bench (10 streaming calls, requires ANTHROPIC_API_KEY)
./run.sh

# Override sample size
./run.sh --runs 20

# Structural only — request shape + pricing math; no key, no spend
./run.sh --dry-run
```

Exit codes: `0` GO, `1` AC fail, `2` `bun` missing, `12` `ANTHROPIC_API_KEY` missing (BLOCKED-PENDING-KEY), `13` API error mid-bench.

## Acceptance criteria

| AC | Bar | Source |
|---|---|---|
| AC-1 | avg first-token < 2000 ms (10 runs) | `IMPLEMENTATION-PLAN.md` T-0.5 + ARCH §12 |
| AC-2 | warm p95 < 2500 ms | inferred (advisory) |
| AC-3 | warm cache_read_ratio > 0.9 (every call ≥ 2) | T-0.5 + ARCH §7.3 |
| AC-4 | cached context ≥ 20 000 tokens | T-0.5 phrasing |
| AC-5 | warm cost ≤ $0.005 / call | ARCH §13 (advisory) |
| AC-6 | 0 errors over 10 runs | implicit |

Headline GO requires AC-1, AC-3, AC-4, AC-6 (gating). AC-2 / AC-5 are recorded but not gated.

## Why structural tests run *before* live calls

The cache breakpoint hash is byte-sensitive. If `buildRequest()` is non-deterministic, every call writes a fresh cache and AC-3 fails not because the API misbehaved but because we mis-built the request. Structural tests rule that out before we spend a cent.

## Known caveats

- Sonnet 4.6 pricing in `pricing.ts` is a snapshot from 2026-05. AC-5 is advisory — verify against the public price page if the dollar number matters.
- Ephemeral cache TTL = 5 min. Bench runs back-to-back in ~60 s, so all calls ≥ 2 should hit warm cache. If a run takes > 4 min between consecutive calls, AC-3 measurement may be invalidated; the harness records inter-call timestamps so this is auditable.
- Network jitter affects AC-1. Run on stable broadband (≥ 50 Mbps).
- Single client / HTTP/2 keep-alive (ARCH §7.3) — `runBench()` constructs one `Anthropic` client and reuses it across all 10 calls.
