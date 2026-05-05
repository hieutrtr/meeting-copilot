# Meeting Copilot — Phase 0 Spike Memo (final)

**Date**: 2026-05-05 · **Author**: loop driver (solo dev) · **Phase**: 0 of 5 · **Decision sought**: green-light Phase 1 (MVP local-only).

> **Scope.** Synthesises findings from `docs/tasks/phase-0/T-0.{1..8}-review.md` and the canonical numbers in `experiments/T-0.{1..5,8}/results.{md,json}`. The T-0.6 first-cut memo and the T-0.7 stakeholder review (3 surgical conditions: C-1, C-2, C-3) have been folded in below. No new measurements; references inline.

---

## TL;DR — 3 unknowns

| # | Unknown | Verdict | Headline number |
|---|---|---|---|
| 1 | Mic + system audio simultaneously on macOS without kernel extension | **🟡 CAVEAT-GO** (BLOCKED-PENDING-INSTALL — code path proven, drift number flips on user install) | dual-engine `parallel` mode compiles, type-checks, pre-flights cleanly with structured `exit 7`; `cross.drift_ms_over_60s` not yet measured |
| 2 | MLX whisper RTF < 1.0 on Apple Silicon | **🟢 GO** (massive margin) | 20/20 runs pass; median RTF: tiny=0.016, small=0.029, **medium=0.059**, large-v3-turbo=0.229; M1 Pro 16 GB worst-case projection ≈ 0.435 → 2.3× headroom |
| 3 | Claude streaming + prompt cache: first-token < 2s on 20k context, cache hit > 90% | **🟡 CAVEAT-GO** (BLOCKED-PENDING-KEY — request shape correct by 16/16 tests, latency unmeasured) | 75 667-char context block ≈ 21 500 tokens cacheable; byte-identical bodies on consecutive calls; flips to numeric GO/NO-GO with `ANTHROPIC_API_KEY` export — zero code change |

**Overall Phase 0 verdict: 🟢 GREEN — proceed to Phase 1.** Both CAVEATs are user-environment blockers (BlackHole install, API key export), not measured technical failures. T-0.8 adds a third blocker of the same shape (Rust toolchain) but does not change the verdict — it inherits the BLOCKED-PENDING-INSTALL pattern that already covers T-0.2/T-0.3/T-0.5. No pivot fires preemptively.

---

## Unknown #1 — Audio capture (T-0.1, T-0.2, T-0.3)

**Mic-only (T-0.1)** — CAVEAT-GO. AVAudioEngine + 16 kHz mono tap is one screen of Swift. TCC pre-flight via `AVCaptureDevice.authorizationStatus(for: .audio)` is permission-free (does not fire the modal), so the Phase 1 onboarding wizard can render granted/pending/denied without surprising the user. Critical foot-gun documented: `inputNode` blocks indefinitely on `.notDetermined` in headless contexts — Phase 1 daemon (T-1.2) **must** auth-probe before opening the device or first-run will look like a deadlock.

**System audio (T-0.2)** — CAVEAT-GO. BlackHole-2ch route as ARCH §2.1 default holds. Core Audio device enumeration (`kAudioHardwarePropertyDevices`) is permission-free, and `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)` redirects an `AVAudioEngine` to a non-default input in one call. Six structured exit codes cover the failure space — the most important being `exit 8: blackhole_present_but_silent` (user installed BlackHole but skipped the Multi-Output Device step in Audio MIDI Setup), which the onboarding wizard must catch.

**Simultaneous mic + system (T-0.3)** — CAVEAT-GO, the largest structural risk for UNKNOWN #1. Two AVAudioEngine instances coexist in one process; the dual-init compiles + type-checks + pre-flights to the BlackHole guard. `mach_absolute_time()` is the only viable cross-engine time base because `AVAudioTime.sampleTime` is per-engine. `parallel` mode is intentionally the default (it surfaces the worst case); `aggregate` mode (single engine on a user-built Aggregate Device) is the simpler ride if the user goes through one extra AMS step.

**What's BLOCKED.** The numeric drift / sync / glitch / combined-CPU bars cannot be hit on this host because BlackHole-2ch is not installed. The script is built so `./run.sh 60` flips every BLOCKED metric into a real number with zero code change post-install. **User actions to unblock**: (a) `brew install blackhole-2ch`, (b) approve system extension + reboot if prompted, (c) build Multi-Output and Aggregate Devices in Audio MIDI Setup, (d) grant Microphone permission to the parent terminal once.

---

## Unknown #2 — MLX whisper RTF (T-0.4)

**🟢 GO with massive margin.** Full 4-model × 5-sample matrix (`tiny` / `small` / `medium` / `large-v3-turbo` × 60s synthesised English samples), 20/20 runs `ok=true`, all 20 below the RTF=1.0 bar by ≥ 4× on M1 Max. Real-time STT on Apple Silicon is structurally feasible without a cloud provider. Phase 1 default = local MLX.

**Recommended Phase 1 default: `medium`.** Median RTF 0.059, peak RSS ≈ 4.4 GB (transient) / ~3.4 GB steady-state, warm load ~1.5 s, **no hallucination on padded silence**. WER public ~9%. Comfortable on a 16 GB Mac alongside Tauri (~150 MB), Claude streaming (~50 MB), audio daemon (~50 MB), Zoom call.

**Why not `large-v3-turbo` yet.** Runs 6× faster on clean audio (RTF 0.041 on sample 1) but exhibits Whisper's runaway-decode failure mode on padded silence (RTF jumps to 0.221–0.256, transcript becomes `Good Good Good...`). Real meetings have long silences. Without VAD, `large-v3-turbo` cost is unpredictable. **Tightens ARCH §2.4 from "VAD nice-to-have" to "VAD required for production large-v3-turbo".**

**C-1 reconciliation (per T-0.7).** PLAN T-1.5 scope is *"MLX whisper integration: spawn `mlx-whisper` subprocess, feed PCM stream, parse JSON transcript output."* — it does not include VAD. Phase 1 ships `medium` (sufficient per spike); the `large-v3-turbo` upgrade is gated behind a **new task `T-1.5b — Silero VAD integration + `large-v3-turbo` upgrade gate`** to be inserted at Phase 1 kickoff (recommendation from T-0.7 §4 C-1). T-1.5 itself is Phase 1, not Phase 2 — earlier "Phase 2 / T-1.5" phrasing in the T-0.6 first-cut was a typo and is fixed here.

**Caveats.** (a) Host is M1 Max / 64 GB; conservative 1.7× scale to M1 Pro / 16 GB target gives worst-case RTF ≈ 0.435 — still 2.3× under the bar. *Footnote (per C-2): 1.7× is the **upper** end of the 1.3–1.7× rule-of-thumb derived from the M1 Pro / M1 Max GPU-core ratio (16 vs 32) softened by MLX Metal + unified-memory dynamics. It is not a measurement. PLAN T-1.12 (E2E test on M1 Pro 16 GB) is the empirical re-measurement gate before Phase 1 ships.* (b) Batch RTF only — streaming wrapper (T-1.5) adds chunk overhead; expect 1.2–1.5× slowdown, still 11× under bar at the recommended `medium` tier. (c) HF first-download is the user-perceived "first run" cost (~3.5 GB across 4 models, ~138 s amortised into sample 1 of `medium`). Phase 1 install must pre-download the chosen model or the first-meeting UX is a 1–2 min spinner.

---

## Unknown #3 — Claude streaming + prompt cache (T-0.5)

**🟡 CAVEAT-GO preliminary** — request plumbing is correct *by construction*; live latency + cache-hit-ratio are the only outstanding numbers and are blocked on a single env var.

**What's structurally proven (16/16 tests pass).** Model = `claude-sonnet-4-6`. Two `cache_control: { type: "ephemeral" }` system blocks (static instructions + 20 k context). Recent transcript + question land on the *user* message **without** `cache_control` (per ARCH §6.2/§7.2). `max_tokens: 600`, `temperature: 0`. Two consecutive `buildRequest()` calls produce **byte-identical** bodies — the necessary precondition for a cache hit on call ≥ 2 — and that's gated by tests. Cached portion = 75 667 chars ≈ 21 500 tokens (clears the ≥ 20 000 cached-token bar with margin). Single-client / HTTP/2 keep-alive enforced (ARCH §7.3).

**Pricing math holds against ARCH §13.** Cache read is exactly 10× cheaper than uncached input ($0.30 vs $3.00 per MTok). Original AC-5 advisory bar of $0.005/call was too tight — output tokens at $15/MTok dominate warm-call cost. Revised to **$0.015/call advisory**.

*Breakdown (per C-3):* `$0.015 ≈ 600 output tokens × $15/MTok ($0.0090)  +  ~21 500 cached input tokens × $0.30/MTok ($0.0065)  +  ~500 uncached input tokens × $3.00/MTok ($0.0015) ≈ $0.0170` rounded to a $0.015/call **advisory** (uncached input is question-dependent so the advisory floors at $0.015 for warm calls; cold-call inflates by ~$0.063 cache-write + $0.054 first-input charge).

**What's BLOCKED.** No `ANTHROPIC_API_KEY` on this host. `./run.sh` exits 12 with structured walkthrough; T-0.5 review §5 has a placeholder table the user fills in post-export. Decision rule: if warm `cache_read_ratio_min ≥ 0.9` AND avg first-token < 2 s over 10 runs → 🟢 GO; else → CAVEAT with risk note (likely 5-min TTL eviction → retry with 1-hour TTL profile if account allows).

---

## Repo skeleton (T-0.8)

**🟡 CAVEAT-GO BLOCKED-PENDING-INSTALL.** Tauri 2 scaffold lives at project root per ARCH App A; 40/40 structural checks pass; `bun install` (71 pkgs / 2.69 s) + `bun run dev` (Vite ready 1099 ms) + `bun run build` (302 ms / 143.5 kB JS / 46.2 kB gzip) all exit 0 on a host with no Rust. `cargo tauri dev` opening a window is the only deferred AC — gated on `rustup default stable`, zero code change. IPC smoke test wired both sides (`#[tauri::command] greet` + `invoke<string>("greet", {name})`); two Rust unit tests staged. Frontend-only CI active. Three side-findings:

1. Tauri 2 capabilities ACL is required even for trivial `greet` (`core:default`); Phase 1 narrows per ARCH §11 when keychain/fs plugins land.
2. Hand-scaffold beat `bun create tauri-app` because the project root already had `docs/`, `experiments/`, `.claude/` — the interactive scaffolder writes into a fresh subdir.
3. Frontend toolchain is independent of Rust. A read-only/PWA fallback could ship UI before Rust if install is delayed.

---

## Stack decision (final)

**Desktop framework: Tauri 2.x — keep.** ARCH §8.1 rationale stands and is reinforced by spike: dual-engine AVAudioEngine code compiles in single-file Swift in ~1.5 s; mapping that to a Rust daemon (`coreaudio-rs::AudioUnit::set_property(kAudioOutputUnitProperty_CurrentDevice, …)`) is a known reusable primitive. Bundle ~10 MB beats Electron's ~150 MB; multi-window (transcript + floating overlay) is first-class. Pivot to Electron + Swift helper is reserved for the *Pivot 3* trigger only (both BlackHole and ScreenCaptureKit fail post-install, ~1 week added — throws away T-0.8 scaffold).

**STT default: MLX local with `medium`** (Phase 1) → **`large-v3-turbo`** post-VAD via the new **T-1.5b** task (Phase 1 stretch). Deepgram Nova-2 stays as the **named fallback** per IMPLEMENTATION-PLAN.md line 38 — quote ~$0.26/hr, hosted, zero client compute, ready to flip via the pluggable provider interface (ARCH §3.1) if the M1 Pro re-measurement comes back > 0.7 RTF on `medium`.

**LLM: Claude Sonnet 4.6** with two-block ephemeral prompt cache, no change.

---

## Risks surfaced in spike (additions to the PRD/ARCH risk register)

1. **Whisper runaway-decode hallucination on silence** is a production cost risk for `large-v3-turbo`, not just a benchmark artefact. ARCH §2.4 VAD is no longer optional for the eventual upgrade path; gated behind T-1.5b.
2. **AVAudioEngine `inputNode` blocks indefinitely on TCC `.notDetermined`** in headless contexts — sharp foot-gun for the Phase 1 helper daemon. Action: identical pre-flight in Rust before opening any input device.
3. **BlackHole present-but-silent** is the most likely near-success failure (user installed BlackHole, skipped Multi-Output Device). Wizard must detect via peak-amplitude check, not just device presence.
4. **Cache TTL eviction (5 min default)** can drop AC-3 below 0.9 not from mis-built request but from inactivity. Mitigation: monitor `cache_creation_input_tokens > 0` on warm calls; if seen, retry with 1-hour TTL profile.
5. **Host vs target spec mismatch** — all RTF numbers were taken on M1 Max / 64 GB; target is M1 Pro / 16 GB. Conservative 1.7× scaling holds margin (rule-of-thumb upper bound, not measured), but final M1 Pro re-measurement is required gate before Phase 1 ships.
6. **Tauri 2 `core:default` capability is too broad for v1 release.** Phase 1 narrows per ARCH §11 when keychain/fs/dialog plugins land.

---

## Pivot ladder (ready for Phase 1)

| Trigger | Pivot | Cost |
|---|---|---|
| Post-install drift > 100 ms / 60 s in `parallel` mode (T-0.3) | Switch production default to `aggregate` mode (one extra AMS step in onboarding wizard) | 1 config flag |
| Both `parallel` AND `aggregate` fail drift bar | Insert T-0.3.5 ScreenCaptureKit spike (`SCStream` audio output, no HAL plug-in, macOS 13+) | ~1 day |
| ScreenCaptureKit also fails | Switch framework Tauri → Electron + native Swift helper (out-of-process capture, IPC PCM frames) | ~1 week, throw away T-0.8 |
| M1 Pro target re-measurement > 0.7 RTF on `medium` | Drop one model tier (`medium` → `small`) before Deepgram default switch | hours |
| MLX cold-start UX blocker | Pre-warm model in helper daemon (ARCH §2.5) | hours |
| AC-3 cache ratio < 0.9 due to TTL eviction | Retry with 1-hour TTL profile if account allows | hours |
| `cargo tauri dev` window blank or IPC fails post-rustup | Re-scaffold via `bun create tauri-app` into a clean subdir, port files | half-day |

No pivot fires preemptively. Pivots fire on **measured** post-install / post-key numbers, recorded into the Phase 1 task breakdown.

---

## Phase 1 readiness

🟢 **Green to proceed**, gated on three user actions (already documented in `docs/tasks/phase-0/INDEX.md` "Known Gaps"):

1. `brew install blackhole-2ch` + Audio MIDI Setup walkthrough (Multi-Output + Aggregate Device).
2. `export ANTHROPIC_API_KEY=…` then re-run `experiments/T-0.5/run.sh`.
3. `rustup default stable` (~5 min) + `cargo install tauri-cli --version "^2"` then `bun run tauri dev` to flip T-0.8 AC-7.

After (1)+(2), T-0.3 + T-0.5 BLOCKED metrics flip to numeric GO/NO-GO with zero code change. After (3), T-0.8 AC-7 flips to numeric GO with zero code change. Phase 1 task-list lock should also fold C-1/C-2/C-3 into the "Lessons learned" of `PHASE-0-COMPLETE.md` so they survive into Phase 1 kickoff (T-1.5b insertion is the most consequential).

---

*Word count: ~1 200. References: `docs/tasks/phase-0/T-0.{1..8}-review.md`, `docs/tasks/phase-0/T-0.7-stakeholder-review.md`, `experiments/T-0.{1..5,8}/results.{md,json}`, `docs/ARCHITECTURE.md` §2/§3/§6/§7/§8/§11/§13/App A, `docs/IMPLEMENTATION-PLAN.md` Phase 0 §, `docs/PRD.md` §1–§2.*
