#!/usr/bin/env bash
# experimental, not for prod
# T-0.3 driver: compile + run the simul-capture spike, mirror metrics into results.json,
# tail run.log to stdout. See docs/tasks/phase-0/T-0.3-mic-system-simultaneous.md.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DURATION="${1:-60}"
MODE="${2:-parallel}"        # parallel | aggregate
AGG_NAME="${3:-MeetingCopilot Input}"

OUT_DIR="$HERE/out"
BIN="$OUT_DIR/simul_capture"
SRC="$HERE/simul_capture.swift"
LOG="$OUT_DIR/run.log"
METRICS="$OUT_DIR/metrics.json"
TS="$OUT_DIR/timeseries.jsonl"
RESULTS_JSON="$HERE/results.json"

mkdir -p "$OUT_DIR"

# Cached compile (rebuild only if source newer than binary)
if [[ ! -x "$BIN" || "$SRC" -nt "$BIN" ]]; then
  echo "[run.sh] compiling $SRC -> $BIN"
  if ! swiftc -O "$SRC" -o "$BIN" 2>&1 | tee "$LOG"; then
    echo "[run.sh] compile failed; see $LOG" >&2
    exit 1
  fi
else
  echo "[run.sh] using cached binary $BIN"
fi

echo "[run.sh] running mode=$MODE duration=${DURATION}s agg=\"$AGG_NAME\""
# Pre-create empty timeseries (truncate) so the file always exists post-run
: > "$TS"

# Argv: <mode> <duration> <agg-name>
"$BIN" "$MODE" "$DURATION" "$AGG_NAME" 2>&1 | tee -a "$LOG"
RC="${PIPESTATUS[0]}"

# Mirror metrics.json -> results.json (canonical sibling copy)
if [[ -f "$METRICS" ]]; then
  cp "$METRICS" "$RESULTS_JSON"
  echo "[run.sh] metrics mirrored: $RESULTS_JSON"
else
  echo "[run.sh] warning: $METRICS not produced" >&2
fi

# Verify WAV files if produced
for w in "$OUT_DIR/mic.wav" "$OUT_DIR/system.wav"; do
  if [[ -f "$w" ]]; then
    echo "[run.sh] afinfo $w:"
    afinfo "$w" 2>&1 | head -8 || true
  fi
done

echo "[run.sh] exit=$RC log=$LOG"
exit "$RC"
