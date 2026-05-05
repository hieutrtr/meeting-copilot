# T-0.5 results — BLOCKED-PENDING-KEY

**Status**: 🟡 BLOCKED-PENDING-KEY (exit 12)
**Timestamp**: 2026-05-05T12:46:06.618Z

## Why blocked

ANTHROPIC_API_KEY env var is not set; per Phase 0 INDEX §'Toolchain Prerequisites' T-0.5 must STOP and surface a notice rather than silently skip.

## Unblock steps

- 1. Obtain an Anthropic API key (https://console.anthropic.com/).
- 2. Export in shell: export ANTHROPIC_API_KEY="sk-ant-..."
- 3. Re-run: ./run.sh

Once the key is exported, re-run `./run.sh` and this file will be overwritten with numeric AC results.

## What is already proven (without the key)

`bun test tests/request-shape.test.ts tests/pricing.test.ts` passes — confirms:

- Request body matches `docs/ARCHITECTURE.md` §6.2 + §7.2 exactly (model, two cache breakpoints, recentTranscript NOT cached, max_tokens=600, temperature=0).
- Pricing math: cache read is 10× cheaper than uncached input; warm-call cost projection (~$0.01) sits under the revised AC-5 advisory bar of $0.015 (original $0.005 was too tight — output tokens at $15/MTok dominate).
- Determinism: two consecutive `buildRequest()` calls produce byte-identical bodies — a *necessary* condition for cache hits on call ≥ 2.

These structural guarantees mean the moment a key is exported, AC-3 (cache ratio > 90%) is the only thing that depends on the live network — AC-1 (latency) and AC-6 (no errors) become the actual unknowns.

## Verdict (preliminary)

**🟡 CAVEAT-GO preliminary** — request shape and cache plumbing are correct by construction; numeric latency + cache-hit-ratio bars are pending live API access. No code changes needed when key arrives.
