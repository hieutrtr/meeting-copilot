# Phase 0 — Spike & Feasibility — Task Index

> Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 0 — Spike & Feasibility" (lines 14–38). Read-only spec.
> Goal: prove the 3 biggest unknowns + decision memo (go/no-go) + repo skeleton.
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.

## 3 Unknowns Being Proved

| # | Unknown | Owning task(s) | Pass bar |
|---|---|---|---|
| 1 | mic + system audio simultaneously on macOS without kernel extension | T-0.1, T-0.2, **T-0.3** | 60s recording, 2 WAV files, no glitch, drift < 100ms / 60s, CPU < 10% avg |
| 2 | MLX whisper streaming RTF < 1.0 on Apple Silicon | **T-0.4**, T-0.5(*) | RTF < 1.0 on ≥3/5 samples; first chunk < 2s. (*) loop renumbering — see note below |
| 3 | Claude streaming + prompt cache: first-token < 2s on 20k context, cache hit > 90% | T-0.5 | avg < 2s over 10 runs; cache_read_input_tokens > 90% on call ≥2 |

---

## Task Checklist (8 tasks)

- [x] **T-0.1** — Spike: BlackHole 2ch install + AVAudioEngine Swift script capturing mic + system audio into 2 WAV files. *(mic-only slice complete, **CAVEAT-GO**: Swift CLI compiles + runs; full recording BLOCKED on Microphone TCC `notDetermined` — needs one-time user grant, see `experiments/T-0.1/results.md`. System-audio half deferred to T-0.2 / T-0.3.)*
- [x] **T-0.2** — Spike: BlackHole-2ch loopback capture (rescoped from ScreenCaptureKit per ARCH §2.1 default). *(**BLOCKED-PENDING-INSTALL → preliminary CAVEAT-GO**: Swift CLI compiles + runs, Core Audio enumeration succeeds, BlackHole-2ch absent on host → structured `exit 7 / blackhole_not_installed` with full unblock walkthrough; flips to numeric pass on `brew install blackhole-2ch` + Multi-Output Device. ScreenCaptureKit alternative remains v2 fallback per ARCH §2.2.)*
- [x] **T-0.3** — Spike: simultaneous mic + system audio capture (UNKNOWN #1 prove). 2 modes — `parallel` (2x AVAudioEngine, default) + `aggregate` (single engine on user-built Aggregate Device). *(loop renumbered: was originally MLX RTF in `IMPLEMENTATION-PLAN.md`; loop driver inserts simultaneous-capture as the third evidence task for UNKNOWN #1. **CAVEAT-GO**: dual-engine code path proven structurally; numeric drift / sync / CPU bars BLOCKED-PENDING-INSTALL on BlackHole + AMS setup; flips with zero code change post-install. Pivot path named in review: Aggregate Device → ScreenCaptureKit → Electron+helper.)*
- [x] **T-0.4** — Spike: run `mlx-whisper` on 5 × 60s sample audio clips; measure Real-Time Factor across 4 models (was T-0.3 in raw plan, shifted by loop renumbering). *(**🟢 GO** — UNKNOWN #2 closed: 20/20 runs pass RTF<1.0 on M1 Max. Median RTF: tiny=0.016, small=0.029, medium=0.059, large-v3-turbo=0.229. Worst-case scaled to M1 Pro target ≈ 0.435 (still 2.3× under bar). Recommended Phase 1 default: `medium` (no hallucination on silence, ~3.4 GB RSS, ~1.5s warm-load); upgrade to `large-v3-turbo` once VAD lands per ARCH §2.4. See `experiments/T-0.4/results.md`.)*
- [x] **T-0.5** — Spike: Claude Sonnet 4.6 streaming + prompt cache @ 20k context; first-token latency over 10 runs (UNKNOWN #3). Code-heavy TDD per loop rule 2. *(**🟡 CAVEAT-GO preliminary**: 16/16 structural tests pass — ARCH §6.2/§7.2 request shape correct by construction (2 cache breakpoints, 75.7k-char context block ≈ 21.5k tokens, recent transcript NOT cached, byte-identical body across calls); pricing math gates cache-read at 10× cheaper. Live latency + cache-hit-ratio bars BLOCKED-PENDING-KEY on `ANTHROPIC_API_KEY` — `./run.sh` exits 12 with full unblock walkthrough; flips numeric on key export with zero code change. AC-5 cost bar revised $0.005 → $0.015 to match ARCH §13 reality.)*
- [x] **T-0.6** — Write `docs/spike-memo.md` (1–2 pages): 3 verdicts, recommended stack, risks. *(**🟢 GO** — `docs/spike-memo.md` authored, ~1100 words. TL;DR table: U#1 🟡 CAVEAT-GO BLOCKED-PENDING-INSTALL (BlackHole), U#2 🟢 GO (RTF medians 0.016 / 0.029 / 0.059 / 0.229; M1 Pro worst-case ≈ 0.435), U#3 🟡 CAVEAT-GO BLOCKED-PENDING-KEY (16/16 structural tests pass, 21 500-tok cached block). Stack: Tauri kept, MLX `medium` Phase 1 default, `large-v3-turbo` post-VAD, Deepgram Nova-2 named fallback. 5 spike-surfaced risks + 6-row pivot ladder. Both CAVEATs flip to numeric GO/NO-GO with zero code change post-unblock. Overall Phase 0: 🟢 GREEN to proceed.)*
- [x] **T-0.7** — Stakeholder review of memo (self-review acceptable for solo dev); list pivots if any. *(**🟢 APPROVED-WITH-CONDITIONS** — memo passes stakeholder review without rewrite; all 3 unknowns' verdicts + headline numbers cross-checked against `experiments/T-0.{1..5}/results.{md,json}` and per-task reviews. 3 surgical conditions raised: **C-1** reconcile "T-1.5 wires Silero VAD" claim with PLAN T-1.5 scope (suggest insert `T-1.5b` for VAD + `large-v3-turbo` upgrade gate; the "Phase 2 / T-1.5" phrasing also has a phase-confusion typo since T-1.5 is Phase 1); **C-2** make the 1.7× M1 Max → M1 Pro scaling factor's basis explicit (rule-of-thumb upper bound, not measurement); **C-3** publish the cost-AC revision math ($0.009 output + $0.0065 cached input ≈ $0.015). None blocks T-0.8. Conditions carry into PHASE-0-COMPLETE.md "Lessons learned." See `docs/tasks/phase-0/T-0.7-stakeholder-review.md`.)*
- [x] **T-0.8** — Repo skeleton: Tauri scaffold, monorepo layout, CI placeholder. `cargo tauri dev` opens empty window. *(**🟡 CAVEAT-GO BLOCKED-PENDING-INSTALL** — Tauri 2 scaffold landed at project root per ARCH App A; 40/40 structural checks pass; `bun install` (71 pkgs / 2.69 s) + `bun run dev` (Vite ready 1099 ms) + `bun run build` (302 ms / 143.5 kB JS / 46.2 kB gzip) all exit 0. AC-7 (`cargo tauri dev` opens window) deferred — no `cargo`/`rustc` on host; `experiments/T-0.8/run.sh` exits 14 with full `rustup` unblock walkthrough. Flips to numeric GO with zero code change post-install. IPC smoke test wired (`greet` Rust command + `invoke<string>("greet", {name})` in `App.tsx`) + 2 Rust unit tests staged. Frontend-only CI active.)*

Each task gets its own file: `T-0.<N>-<slug>.md` (planning) + `T-0.<N>-review.md` (post-task self-review).

---

## Loop renumbering vs raw plan

The loop driver re-sequences `IMPLEMENTATION-PLAN.md`'s 8 tasks to give UNKNOWN #1 three evidence tasks (T-0.1 mic, T-0.2 system, T-0.3 simultaneous) and to fit Phase 0 inside an 8-task budget. Mapping:

| Loop task | Raw-plan task | Notes |
|---|---|---|
| T-0.1 | raw T-0.1 (partial) | rescoped to mic-only |
| T-0.2 | raw T-0.1 (partial) + ARCH §2.1 BlackHole | rescoped: BlackHole loopback (ScreenCaptureKit deferred to v2) |
| **T-0.3** | *(loop-inserted)* | mic + system simultaneous (UNKNOWN #1 closer) |
| T-0.4 | raw T-0.3 | mlx-whisper RTF bench |
| T-0.5 | raw T-0.5 | Claude + prompt cache (UNKNOWN #3) |
| T-0.6 | raw T-0.6 | spike-memo.md |
| T-0.7 | raw T-0.7 | review |
| T-0.8 | raw T-0.8 | Tauri scaffold |

Dropped: raw T-0.2 (ScreenCaptureKit alt — keep as v2 / Pivot 2 if T-0.3 NO-GOs) and raw T-0.4 (MLX streaming wrapper — pushed to Phase 1 T-1.5; the *RTF* bench in T-0.4 is sufficient for UNKNOWN #2 prove).

## Dependency Graph (ASCII)

```
   ┌──────────────┐    ┌──────────────┐
   │     T-0.1    │    │     T-0.2    │
   │  mic-only    │    │  BlackHole   │
   │ AVAudioEng   │    │   loopback   │
   └──────┬───────┘    └──────┬───────┘
          │                   │
          └─────────┬─────────┘
                    ▼
            ┌──────────────┐
            │     T-0.3    │  mic + sys simultaneous
            │   parallel   │  (UNKNOWN #1 closer)
            │  + aggregate │
            └──────┬───────┘
                   │
   ┌──────────────┐│┌──────────────┐
   │     T-0.4    │││     T-0.5    │
   │  mlx-whisper │││   Claude +   │
   │   RTF bench  │││ prompt cache │
   │ (UNKNOWN #2) │││ (UNKNOWN #3) │
   └──────┬───────┘│└──────┬───────┘
          │        │       │
          └────────┼───────┘
                   ▼
            ┌──────────────┐
            │     T-0.6    │  spike-memo.md
            │  write memo  │  (synthesize 3 verdicts)
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │     T-0.7    │  stakeholder review
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │     T-0.8    │  Tauri scaffold
            │ repo skeleton│  cargo tauri dev
            └──────────────┘
```

Critical path: T-0.1 ∥ T-0.2 → T-0.3 → T-0.4 ∥ T-0.5 → T-0.6 → T-0.7 → T-0.8. T-0.4 and T-0.5 can run in either order (independent UNKNOWNS); T-0.3 unblocks both because it's the audio-source the streaming bench (raw T-0.4, deferred) would have consumed.

---

## Toolchain Prerequisites

Verified on host: **Apple M1 Max, macOS 26.2, 64 GB RAM** (host is stronger than the M1 Pro 16 GB target spec — RTF numbers will be optimistic; flag in memo).

| Tool | Installed? | Version | Needed for | Fallback / Action |
|---|---|---|---|---|
| `swift` | ✅ | 6.2.3 (arm64) | T-0.1, T-0.2 (Swift CLI for AVAudioEngine + ScreenCaptureKit) | — |
| `xcrun` | ✅ | 72 | T-0.1, T-0.2 (Swift compile / build) | — |
| `ffmpeg` | ✅ | 8.0.1 | T-0.3, T-0.4 (resample / generate sample audio) | — |
| `python3` | ✅ | 3.13.7 | T-0.3, T-0.4, T-0.5 (mlx-whisper + Anthropic SDK) | — |
| `uv` | ✅ | 0.10.0 | T-0.3, T-0.4 (isolated Python env for MLX) | `python3 -m venv` if missing |
| `bun` | ✅ | 1.3.11 | T-0.5 (TS Anthropic SDK harness), T-0.8 (Tauri frontend) | — |
| `cargo` / `rustc` | ❌ | — | T-0.8 (Tauri scaffold), T-0.4 fallback (Rust-side IPC) | **User action**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` then `rustup default stable` |
| `node` | ❌ | — | None strictly — `bun` covers TS runtime | Skip; if any tool requires npm shim, `bun x` works |
| `mlx-whisper` (pip) | ❌ | — | T-0.3, T-0.4 (UNKNOWN #2) | Install via `uv pip install mlx-whisper` in T-0.3 task setup |
| `mlx` (pip) | ❌ | — | T-0.3, T-0.4 (transitive of mlx-whisper) | Same as above |
| `BlackHole-2ch` (HAL plugin) | ❌ | — | T-0.1, T-0.3 (system audio loopback) | **User action**: `brew install blackhole-2ch` then create Multi-Output + Aggregate devices in Audio MIDI Setup. Document expected output. |
| `ANTHROPIC_API_KEY` env | ❌ | — | T-0.5 (UNKNOWN #3) | **STOP T-0.5 and notify user.** No fallback — cannot bench cache without real API. |
| `tauri-cli` | ❌ (depends on cargo) | — | T-0.8 | Install via `cargo install tauri-cli --version "^2"` after rust setup |
| Apple Silicon | ✅ | M1 Max | T-0.3, T-0.4 (MLX requires Apple Silicon) | — |

---

## Known Gaps the User Must Fix Manually

Listed in the order they block downstream tasks:

1. **Install Rust toolchain** — blocks T-0.8 (Tauri scaffold). Run:
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   source "$HOME/.cargo/env"
   rustup default stable
   ```
   Verify with `rustc --version && cargo --version`.

2. **Install BlackHole-2ch** — blocks T-0.1, T-0.3 (system-audio capture). Run:
   ```sh
   brew install blackhole-2ch
   ```
   Then in **Audio MIDI Setup.app**:
   - Create a *Multi-Output Device*: built-in speakers + BlackHole-2ch (set as system output during meeting).
   - Create an *Aggregate Device*: built-in mic + BlackHole-2ch (used as input by capture script).
   Restart the app after install. Verify BlackHole appears in `system_profiler SPAudioDataType`.

3. **Set `ANTHROPIC_API_KEY`** — blocks T-0.5. Export in shell or add to `~/.zshrc`:
   ```sh
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```
   T-0.5 will halt and surface a notice in the task file if this is missing.

4. **Microphone + Screen Recording permissions** — runtime prompt during T-0.1 / T-0.2. User must grant in **System Settings → Privacy & Security**. Document expected prompt screenshots in T-0.1 task file for the wizard step in Phase 1.

5. **(Optional) `tauri-cli`** — installed via cargo in T-0.8 once Rust is available. Not a separate user step if cargo present.

---

## Spike vs TDD Per Task

Per loop rule 2 (spike-appropriate testing):

| Task | Approach | Why |
|---|---|---|
| T-0.1 | Spike + measurement script | Hardware/permission-bound; output = WAV files + glitch count |
| T-0.2 | Spike + comparison note | Exploratory API survey |
| T-0.3 | Spike + benchmark harness | Pure measurement — RTF JSON log |
| T-0.4 | Spike + benchmark harness | Latency measurement |
| T-0.5 | **Code-heavy / TDD** (Vitest or Bun test) | Pure code, deterministic test against real API |
| T-0.6 | Doc | n/a |
| T-0.7 | Doc | n/a |
| T-0.8 | **Code-heavy / TDD** (Rust test + smoke run) | Real scaffold; verify `cargo tauri dev` exits 0 on init |

---

## Outputs Per Task

Every task creates:
- `docs/tasks/phase-0/T-0.<N>-<slug>.md` (plan + AC + reproduction steps)
- `experiments/T-0.<N>-<slug>/` (throwaway code + `results.{md,json,log}` for hardware tasks)
- `docs/tasks/phase-0/T-0.<N>-review.md` (self-review + findings)

Final phase outputs:
- `docs/spike-memo.md`
- `docs/tasks/phase-0/PHASE-0-COMPLETE.md` (sign-off)

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's measured headline number gets appended next to the task title. Final state must show all 8 boxes ticked before the spike memo is written.
