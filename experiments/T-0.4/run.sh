#!/usr/bin/env bash
# experimental, not for prod — T-0.4 spike orchestrator
# - sets up uv venv (Python 3.12) with mlx-whisper
# - generates 5 × 60s sample WAVs (idempotent)
# - benches each (model × sample) as a fresh subprocess (clean peak RSS)
# - aggregates into results.{md,json}
#
# Env vars:
#   MODELS=tiny,small,medium,large-v3-turbo   models to bench (comma-separated short names)
#   N_SAMPLES=5                                samples per model (1..5)
#   PYTHON_VERSION=3.12                        uv venv interpreter
#
# Exit codes:
#   0  ok
#   20 sample-gen failed
#   21 venv setup failed
#   22 mlx-whisper install failed
#   23 aggregator failed
#   non-zero from a single bench subprocess is captured and recorded; run continues unless --fail-fast.

set -euo pipefail

cd "$(dirname "$0")"

MODELS_DEFAULT="tiny,small,medium,large-v3-turbo"
MODELS="${MODELS:-$MODELS_DEFAULT}"
N_SAMPLES="${N_SAMPLES:-5}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
FAIL_FAST="${FAIL_FAST:-0}"

LOG="out/run.log"
RUNS_DIR="out/runs"
SAMPLES_DIR="out/samples"
mkdir -p "$RUNS_DIR" "$SAMPLES_DIR" "out/raw_text"
: > "$LOG"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"
}

trap 'log "FATAL: aborted"; exit 99' INT TERM

log "host: $(uname -a)"
log "python3: $(python3 --version 2>&1 || true)"
log "uv: $(uv --version 2>&1 || true)"
log "ffmpeg: $(ffmpeg -version 2>&1 | head -1 || true)"
log "MODELS=$MODELS  N_SAMPLES=$N_SAMPLES  PYTHON_VERSION=$PYTHON_VERSION"

# ---------- 1. samples ----------
log "step 1/4 — generate samples"
if ! ./gen_samples.sh 2>&1 | tee -a "$LOG"; then
  log "ERROR: gen_samples.sh failed"
  exit 20
fi

# ---------- 2. venv + install ----------
log "step 2/4 — venv + mlx-whisper install (idempotent)"
if [[ ! -d .venv ]]; then
  if ! uv venv --python "$PYTHON_VERSION" .venv 2>&1 | tee -a "$LOG"; then
    log "ERROR: uv venv failed"
    exit 21
  fi
fi
# shellcheck disable=SC1091
source .venv/bin/activate
if ! python -c "import mlx_whisper" >/dev/null 2>&1; then
  log "installing mlx-whisper into .venv ..."
  if ! uv pip install --quiet "mlx-whisper>=0.4" 2>&1 | tee -a "$LOG"; then
    log "ERROR: mlx-whisper install failed (may need fallback Python; set PYTHON_VERSION=3.11 and re-run)"
    exit 22
  fi
fi
log "mlx_whisper version: $(python -c 'import importlib.metadata as m; print(m.version("mlx-whisper"))')"
log "mlx version: $(python -c 'import importlib.metadata as m; print(m.version("mlx"))')"

# ---------- 3. bench loop ----------
log "step 3/4 — bench loop"
JSONL="$RUNS_DIR/all.jsonl"
: > "$JSONL"

# macOS ships bash 3.2 (no `declare -A`); use a case statement instead.
resolve_repo() {
  case "$1" in
    tiny)            echo "mlx-community/whisper-tiny-mlx" ;;
    base)            echo "mlx-community/whisper-base-mlx" ;;
    small)           echo "mlx-community/whisper-small-mlx" ;;
    medium)          echo "mlx-community/whisper-medium-mlx" ;;
    large-v3)        echo "mlx-community/whisper-large-v3-mlx" ;;
    large-v3-turbo)  echo "mlx-community/whisper-large-v3-turbo" ;;
    *)               echo "" ;;
  esac
}

IFS=',' read -r -a MODEL_LIST <<<"$MODELS"

for short in "${MODEL_LIST[@]}"; do
  short="${short// /}"
  repo="$(resolve_repo "$short")"
  if [[ -z "$repo" ]]; then
    log "WARN: unknown model short name: $short — skipping"
    continue
  fi
  for ((i=1; i<=N_SAMPLES; i++)); do
    sample="$SAMPLES_DIR/$(printf '%02d' "$i").wav"
    if [[ ! -s "$sample" ]]; then
      log "WARN: sample missing: $sample — skipping"
      continue
    fi
    out_json="$RUNS_DIR/${short}-$(printf '%02d' "$i").json"
    log "  bench: model=$short sample=$i ..."
    set +e
    python ./bench.py "$repo" "$sample" "$i" >"$out_json" 2>>"$LOG"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      cat "$out_json" >> "$JSONL"
      summary=$(python -c "import json,sys; d=json.load(open('$out_json')); print(f\"rtf={d['rtf']:.3f} load={d['load_ms']:.0f}ms transcribe={d['transcribe_ms']:.0f}ms peak={d['peak_rss_mb']:.0f}MB\")")
      log "    ok ($summary)"
    else
      err=$(python -c "import json; d=json.load(open('$out_json')); print(d.get('error','?'))" 2>/dev/null || echo "?")
      log "    FAIL (rc=$rc error=$err)"
      cat "$out_json" >> "$JSONL"
      if [[ "$FAIL_FAST" == "1" ]]; then
        log "FAIL_FAST=1 — aborting"
        exit "$rc"
      fi
    fi
  done
done

# ---------- 4. aggregate ----------
log "step 4/4 — aggregate to results.{md,json}"
python ./aggregate.py "$JSONL" "$N_SAMPLES" 2>&1 | tee -a "$LOG"
agg_rc=${PIPESTATUS[0]}
if [[ "$agg_rc" -ne 0 ]]; then
  log "ERROR: aggregator failed rc=$agg_rc"
  exit 23
fi

log "done."
