# experiments/T-0.8/

Verification harness for **T-0.8 — Tauri scaffold**.

> ⚠️ Throwaway: code in this folder is the verifier, NOT the scaffold itself.
> The scaffold lives at the project root (`../../package.json`, `../../src/`,
> `../../src-tauri/`) per `docs/ARCHITECTURE.md` Appendix A. After Phase 0,
> this folder can be archived; the scaffold persists.

## Files

| File | Role |
|---|---|
| `run.sh` | Single-command repro. Probes toolchain, runs structural verifier, boots Vite, attempts `cargo tauri dev` if cargo present. |
| `verify.ts` | Bun-runnable structural assertions for ACs 1..5. 40 checks. |
| `results.md` | Per-AC verdict table + measured numbers. |
| `bench.log` | Captured stdout from the most recent `run.sh` invocation. |
| `vite.log` | Captured stdout from `bun run dev` during the AC-8 smoke. |
| `tauri-dev.log` | Captured stdout from `cargo tauri dev` (only after Rust install). |
| `exit_code` | Last `run.sh` exit code (0/1/13/14/15/16). |

## Reproduction

```sh
cd meeting-copilot
./experiments/T-0.8/run.sh
```

Exit-code legend:

| Code | Meaning |
|---|---|
| 0 | Full GO — all ACs (incl. AC-7 cargo tauri dev) green |
| 1 | Structural check failed |
| 13 | bun missing |
| 14 | cargo missing — AC-7 deferred (CAVEAT-GO BLOCKED-PENDING-INSTALL) |
| 15 | bun run dev failed |
| 16 | cargo tauri dev did not surface ready-marker within 90s |

## Current status (2026-05-05)

Exit 14 — `cargo` not on `$PATH`. Run

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
```

then re-run `./experiments/T-0.8/run.sh` — it auto-flips to the live cargo branch.
