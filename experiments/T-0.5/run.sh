#!/usr/bin/env bash
# Phase 0 T-0.5 — Claude streaming + prompt cache bench. EXPERIMENTAL, NOT FOR PROD.
# Reproduction: ./run.sh             (10 live calls)
#               ./run.sh --runs 20   (override sample size)
#               ./run.sh --dry-run   (no key needed; emits dry-run-body.json)
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERR: 'bun' not found in PATH. Install via 'curl -fsSL https://bun.sh/install | bash'." >&2
  exit 2
fi

# Install deps the first time (bun is fast; no-op if up to date).
if [ ! -d node_modules/@anthropic-ai/sdk ]; then
  echo "[run.sh] installing @anthropic-ai/sdk via bun…"
  bun install >/dev/null
fi

# Always run structural tests first — they gate request shape before we spend a cent.
echo "[run.sh] structural tests (no API key needed)…"
bun test tests/request-shape.test.ts tests/pricing.test.ts

# Detect dry-run flag.
DRY_RUN=0
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRY_RUN=1; fi
done

if [ "$DRY_RUN" = "1" ]; then
  echo "[run.sh] dry-run mode — skipping live API calls."
  bun run scripts/run-bench.ts "$@" 2>&1 | tee bench.log
  exit 0
fi

# Live bench (or BLOCKED-PENDING-KEY exit 12 if no env var).
echo "[run.sh] live bench…"
set +e
bun run scripts/run-bench.ts "$@" 2>&1 | tee bench.log
status=${PIPESTATUS[0]}
set -e
exit "$status"
