#!/usr/bin/env bash
# experimental, not for prod
# T-0.1 driver — runs mic_capture.swift, captures stdout/stderr to out/run.log,
# pretty-prints metrics, and refreshes the canonical results.json copy.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DURATION="${1:-10}"
OUT_DIR="$SCRIPT_DIR/out"
BIN="$OUT_DIR/mic_capture"
WAV="$OUT_DIR/mic.wav"
METRICS="$OUT_DIR/metrics.json"
LOG="$OUT_DIR/run.log"

mkdir -p "$OUT_DIR"
: > "$LOG"

{
  echo "[run] $(date -u +%FT%TZ)"
  echo "[run] duration=${DURATION}s wav=$WAV metrics=$METRICS"
} | tee -a "$LOG"

# Compile once if source is newer than binary
if [ ! -x "$BIN" ] || [ "$SCRIPT_DIR/mic_capture.swift" -nt "$BIN" ]; then
  echo "[run] swiftc -O $SCRIPT_DIR/mic_capture.swift -o $BIN" | tee -a "$LOG"
  if ! swiftc -O "$SCRIPT_DIR/mic_capture.swift" -o "$BIN" 2>&1 | tee -a "$LOG"; then
    echo "[run] swiftc failed" | tee -a "$LOG"
    exit 1
  fi
fi

echo "[run] $BIN $DURATION $WAV $METRICS" | tee -a "$LOG"
set +e
"$BIN" "$DURATION" "$WAV" "$METRICS" 2>&1 | tee -a "$LOG"
EXIT="${PIPESTATUS[0]}"
set -e

echo "[run] swift exit=$EXIT" | tee -a "$LOG"

if [ -f "$METRICS" ]; then
  echo "--- metrics.json ---" | tee -a "$LOG"
  cat "$METRICS" | tee -a "$LOG"
  cp "$METRICS" "$SCRIPT_DIR/results.json"
fi

if [ -f "$WAV" ]; then
  echo "--- afinfo ---" | tee -a "$LOG"
  afinfo "$WAV" 2>&1 | tee -a "$LOG" || true
fi

exit "$EXIT"
