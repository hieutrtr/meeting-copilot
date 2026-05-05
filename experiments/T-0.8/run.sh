#!/usr/bin/env bash
# experimental, not for prod — Phase 0 T-0.8 reproduction harness.
# One command verifies as many ACs as the host toolchain supports.
#
# Exit codes (also echoed to stdout for CI parsing):
#   0   all ACs green (structural + bun + cargo if present)
#   1   structural check failed (missing file, broken JSON, IPC mismatch)
#   13  bun missing
#   14  cargo missing — AC-7 deferred (BLOCKED-PENDING-INSTALL)
#   15  bun run dev failed to boot Vite within timeout
#   16  cargo tauri dev did not surface a "running on" log within timeout

set -u
cd "$(dirname "$0")/../.." || exit 2
ROOT="$(pwd)"
EXPDIR="$ROOT/experiments/T-0.8"
LOG="$EXPDIR/bench.log"
: > "$LOG"

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
fail() { local code=$1; shift; log "[FAIL] $*"; printf '%s\n' "$code" > "$EXPDIR/exit_code"; exit "$code"; }

log "[T-0.8] starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "[T-0.8] root=$ROOT"

# ─── Toolchain probe ──────────────────────────────────────────────────────────
have_bun=0;   command -v bun   >/dev/null 2>&1 && have_bun=1
have_cargo=0; command -v cargo >/dev/null 2>&1 && have_cargo=1
have_rustc=0; command -v rustc >/dev/null 2>&1 && have_rustc=1

bun_v="(missing)";   [ $have_bun   -eq 1 ] && bun_v=$(bun --version 2>&1 || echo err)
cargo_v="(missing)"; [ $have_cargo -eq 1 ] && cargo_v=$(cargo --version 2>&1 || echo err)
rustc_v="(missing)"; [ $have_rustc -eq 1 ] && rustc_v=$(rustc --version 2>&1 || echo err)

log "[probe] bun:   $bun_v"
log "[probe] cargo: $cargo_v"
log "[probe] rustc: $rustc_v"

if [ $have_bun -eq 0 ]; then
  log ""
  log "[BLOCKED] bun is required for the structural verifier and Vite dev boot."
  log "Install: curl -fsSL https://bun.sh/install | bash"
  fail 13 "bun missing"
fi

# ─── AC-1..AC-5: structural verifier ──────────────────────────────────────────
log ""
log "[step 1/4] structural verifier (verify.ts)"
if ! bun run "$EXPDIR/verify.ts" 2>&1 | tee -a "$LOG"; then
  fail 1 "structural verification failed — see bench.log"
fi
log "[step 1/4] OK"

# ─── AC-2 / AC-8: bun install + Vite dev boot ────────────────────────────────
log ""
log "[step 2/4] bun install (ACs 2)"
if ! bun install 2>&1 | tee -a "$LOG"; then
  fail 13 "bun install failed"
fi
log "[step 2/4] OK"

log ""
log "[step 3/4] bun run dev — boot Vite, expect 'Local:' log line within 10s (AC-8)"
VITE_LOG="$EXPDIR/vite.log"
: > "$VITE_LOG"
( bun run dev >>"$VITE_LOG" 2>&1 ) &
VITE_PID=$!

# wait up to 10s for Vite "Local:" marker
booted=0
for _ in $(seq 1 50); do
  if grep -q "Local:" "$VITE_LOG" 2>/dev/null; then booted=1; break; fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then break; fi
  sleep 0.2
done

if [ $booted -eq 1 ]; then
  log "[step 3/4] Vite booted — pid=$VITE_PID"
  grep -E "Local:|VITE" "$VITE_LOG" | head -5 | tee -a "$LOG" || true
else
  log "[step 3/4] Vite did NOT surface 'Local:' within 10s. Tail of vite.log:"
  tail -40 "$VITE_LOG" | tee -a "$LOG" || true
fi
kill "$VITE_PID" 2>/dev/null || true
wait "$VITE_PID" 2>/dev/null || true
[ $booted -eq 0 ] && fail 15 "Vite did not boot — see experiments/T-0.8/vite.log"

# ─── AC-7: cargo tauri dev (BLOCKED-PENDING-INSTALL if cargo missing) ────────
log ""
log "[step 4/4] cargo tauri dev — AC-7"
if [ $have_cargo -eq 0 ]; then
  log ""
  log "[BLOCKED] cargo / rustc not installed."
  log ""
  log "  AC-7 (cargo tauri dev opens window) is the only AC remaining."
  log "  Structural ACs 1..5 + AC-2 bun deps + AC-8 Vite boot all PASSED."
  log ""
  log "  To unblock AC-7 numerically:"
  log "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
  log "    source \"\$HOME/.cargo/env\""
  log "    rustup default stable"
  log "    cargo install tauri-cli --version \"^2\""
  log ""
  log "  Then re-run: ./experiments/T-0.8/run.sh"
  log ""
  log "  Result: CAVEAT-GO BLOCKED-PENDING-INSTALL (mirrors T-0.2 BlackHole + T-0.5 API key patterns)."
  printf '14\n' > "$EXPDIR/exit_code"
  exit 14
fi

# Cargo present — try the actual smoke. tauri-cli may need install.
if ! cargo tauri --version >/dev/null 2>&1; then
  log "[step 4/4] tauri-cli not installed; running 'cargo install tauri-cli --version ^2'"
  cargo install tauri-cli --version "^2" 2>&1 | tee -a "$LOG" || fail 16 "cargo install tauri-cli failed"
fi

TAURI_LOG="$EXPDIR/tauri-dev.log"
: > "$TAURI_LOG"
log "[step 4/4] running 'cargo tauri dev' for up to 90s, looking for 'running on' / 'finished' marker"
( cargo tauri dev >>"$TAURI_LOG" 2>&1 ) &
TAURI_PID=$!

opened=0
for _ in $(seq 1 180); do
  if grep -qE "App listening|running on|finished `dev`|App started" "$TAURI_LOG" 2>/dev/null; then opened=1; break; fi
  if ! kill -0 "$TAURI_PID" 2>/dev/null; then break; fi
  sleep 0.5
done

# Always clean up the tauri dev process and its bun dev child
kill "$TAURI_PID" 2>/dev/null || true
pkill -f "bun run dev" 2>/dev/null || true
wait "$TAURI_PID" 2>/dev/null || true

if [ $opened -eq 1 ]; then
  log "[step 4/4] OK — Tauri dev surfaced ready-marker"
  grep -E "App listening|running on|finished|App started|Compiling" "$TAURI_LOG" | head -10 | tee -a "$LOG" || true
  printf '0\n' > "$EXPDIR/exit_code"
  log ""
  log "[T-0.8] ALL ACs GREEN — full GO."
  exit 0
else
  log "[step 4/4] no ready-marker in 90s. Tail of tauri-dev.log:"
  tail -50 "$TAURI_LOG" | tee -a "$LOG" || true
  fail 16 "cargo tauri dev did not surface ready-marker"
fi
