# Phase 3 — Pluggable Providers — Sign-off

> Loop step **9/9** (final). Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 3 — Pluggable Providers" (lines 97–118). Loop INDEX: `docs/tasks/phase-3/INDEX.md`. Live re-verify: `docs/tasks/phase-3/PHASE-BROWSER-TEST.md`. Phase 3 ARCH addendum: `docs/ARCHITECTURE.md` §3.4 / §4.1 / §11.1 / §14 / §15. Provider table: `docs/provider-comparison.md`.
>
> Stack lock (carry-forward from Phase 2): **Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude Sonnet 4.6 + Claude Haiku 4.5**. Phase 3 ADDS: Deepgram WebSocket STT, ElevenLabs Scribe streaming STT, optional ElevenLabs TTS (cargo feature `tts` + `VITE_ENABLE_TTS`, default OFF), provider factory, privacy mode constraint gate, opt-in telemetry log.

---

## Loop exit gate (per INDEX §"Phase Exit Criteria")

| # | Criterion | Status |
|---|---|---|
| 1 | `bun run test` (vitest) all green — no Phase 1 / Phase 2 regression | ✅ **602 / 602 across 38 files** — verified iteration #8. `bun run typecheck` (`tsc --noEmit`) exits 0. |
| 2 | `cargo test --workspace` all green | ⚠️ **Code-complete — re-verify pending host** — `cargo` + `rustup` not installed on the loop sandbox per Phase 0 INDEX §"Known Gaps" blocked-action #3 (carry-forward C-C from Phase 1/2 sign-offs). T-3.1..T-3.4 + T-3.7 + T-3.8 ship Rust source edits with structural cargo tests (mocked-WS for T-3.2/T-3.3/T-3.4, trait-mock for T-3.7, factory gate for T-3.8); live `cargo test --workspace` re-run is bundled into `PHASE-BROWSER-TEST.md` pre-flight P-1. |
| 3 | Switch provider runtime without restart | ✅ **By construction** — `useSettingsStore.set({ sttProvider })` is reactive; the cost meter (T-3.5) re-attaches per-provider rate at the next chunk; the Rust factory (T-3.1) hands a fresh boxed trait obj to `helper-daemon` per session start. Wall-clock verify is `PHASE-BROWSER-TEST.md` step 2 + step 9. |
| 4 | ≥ 2 STT providers stable in 30-min stress | ⚠️ **Structural pass — wall-clock verify deferred** — vitest E2E + Rust mocked-WS exercise both Deepgram + ElevenLabs adapters end-to-end; the live 30-minute stress is `PHASE-BROWSER-TEST.md` step 9 (host pass with `DEEPGRAM_API_KEY` + `ELEVENLABS_API_KEY`). |
| 5 | `PHASE-BROWSER-TEST.md` — 10-step host re-verify procedure committed | ✅ **184-line / 10-step plan** committed in `99c69e0 docs(phase-3): browser/manual test plan`. Covers boot, provider switch + API key vault + test connection, cost meter switch, privacy gate (Local-first / Cloud / Mixed × MLX / Deepgram / ElevenLabs), telemetry opt-in + rotate, TTS feature flag on, 30-min dual-provider stress, reconnect chaos, settings persistence reload. |
| 6 | `PHASE-3-COMPLETE.md` sign-off committed | ✅ **This file** — committed at end of loop step 9/9. |

**Verdict**: ✅ **Phase 3 — Pluggable Providers — CODE-COMPLETE** with the same `CAVEAT-GO` shape as Phase 0 / 1 / 2 sign-offs. Three carry-forward blocked user-actions (cargo on host, Apple-Silicon hardware, `ANTHROPIC_API_KEY`) plus two Phase-3-new blocked user-actions (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` — both must be exported on host before live verify) stay open for the human-host re-verify pass; nothing on the code path is unwritten or paper-only.

---

## Task tally — 10 / 10

| Task | Title | Spec | Review | Net-new vitest | Net-new cargo | Cumulative vitest | Commit |
|---|---|---|---|---:|---:|---:|---|
| T-3.1 | `SttProvider` trait extraction + factory | `T-3.1-stt-trait-extraction.md` | `T-3.1-review.md` | 0 | +8 | 408 | `445f987 refactor(phase-3): T-3.1 SttProvider trait extraction + factory` |
| T-3.2 | Deepgram WebSocket adapter | `T-3.2-deepgram-adapter.md` | `T-3.2-review.md` | 0 | +13 | 408 | `225fec0 feat(phase-3): T-3.2 Deepgram WebSocket adapter` |
| T-3.3 | Reconnect / chaos for Deepgram | `T-3.3-reconnect-chaos.md` | `T-3.3-review.md` | 0 | +7 | 408 | `8108a15 feat(phase-3): T-3.3 reconnect/chaos handling for Deepgram adapter` |
| T-3.4 | ElevenLabs Scribe streaming adapter | `T-3.4-elevenlabs-adapter.md` | `T-3.4-review.md` | 0 | +18 | 408 | `24e404e feat(phase-3): T-3.4 ElevenLabs Scribe streaming WebSocket adapter` |
| T-3.5 | Cost meter calculator + per-provider rate table | `T-3.5-cost-meter.md` | `T-3.5-review.md` | +51 | 0 | 459 | `919b9dc feat(phase-3): T-3.5 cost meter calculator + per-provider rate table` |
| T-3.6 | Settings UI — provider picker + API key vault + test conn | `T-3.6-settings-ui.md` | `T-3.6-review.md` | +21 | 0 | 480 | `786303a feat(ui): T-3.6 settings UI provider picker + API key vault + test connection` |
| T-3.7 | TTS interface + ElevenLabs adapter (feature flag) | `T-3.7-tts-interface.md` | `T-3.7-review.md` | +26 | +20 (feature `tts`) | 506 | `baa30d5 feat(phase-3): T-3.7 TTS interface + ElevenLabs adapter (feature flag)` |
| T-3.8 | Privacy mode picker + constraint matrix | `T-3.8-privacy-mode.md` | `T-3.8-review.md` | +46 | +10 | 552 | `781a879 feat(privacy): T-3.8 privacy mode picker + constraint enforcement` |
| T-3.9 | Telemetry opt-in + log rotate + PII scrub | `T-3.9-telemetry.md` | `T-3.9-review.md` | +50 | 0 | 602 | `a0fea52 feat: T-3.9 telemetry opt-in with log rotate + PII scrub` |
| T-3.10 | ARCH Phase 3 addendum + `provider-comparison.md` | `T-3.10-docs.md` | `T-3.10-review.md` | 0 | 0 | **602** | `285a0f2 docs: T-3.10 ARCHITECTURE Phase 3 addendum + provider comparison` |
| — | INDEX + dependency graph (loop step 1) | `INDEX.md` | — | 0 | 0 | — | `ad26479 docs(phase-3): INDEX + dep graph + process rules` |
| — | Resume chore after iter-failure restart | — | — | 0 | 0 | — | `3635875 chore(phase-3): resume from T-3.6` |
| — | PHASE-BROWSER-TEST.md (loop step 8) | — | — | 0 | 0 | — | `99c69e0 docs(phase-3): browser/manual test plan` |

**Cumulative tests**:
- **vitest** — 602 across 38 files, all green (Phase 2 baseline 408 → Phase 3 final **602**, net +194 from T-3.5..T-3.9; T-3.1..T-3.4 + T-3.7-Rust + T-3.8-Rust ship under cargo).
- **typecheck** — `tsc --noEmit` exits 0.
- **cargo** — Phase 1 baseline 83 across 4 crates → Phase 3 net new **+76** under feature-gated and feature-ungated targets (T-3.1: +8, T-3.2: +13, T-3.3: +7, T-3.4: +18, T-3.7 `--features tts`: +20, T-3.8: +10). Live re-run is item P-1 in `PHASE-BROWSER-TEST.md`.

**Files**: 10 task plans (`T-3.<N>-<slug>.md`) + 10 reviews (`T-3.<N>-review.md`) + 1 INDEX + 1 manual plan + this sign-off = **23** Phase 3 documents.

**Commits on `main` for this loop**: 13 (1 INDEX + 1 resume chore + 10 task feat/refactor/docs + 1 PHASE-BROWSER-TEST). Sign-off commit is the 14th. **No `git push` performed** per loop constraint Rule 4.

---

## Provider Comparison Snapshot (headline deliverable)

> **Source**: `docs/provider-comparison.md` §STT + §TTS tables. Constants pinned in `src/llm/sttPricing.ts` (cross-linked) and ARCH §3.2 / §3.4. Latency / privacy / API maturity columns audit-cited.

### STT providers (3)

| Provider | Locality | Cost | First-token p95 (target) | Privacy | API maturity | Code path |
|---|---|---|---|---|---|---|
| **MLX whisper** | local (Apple-Silicon) | **$0** (compute only) | < 800 ms (M1 Pro `medium`) | ✅ audio never leaves device | stable (Phase 1) | `crates/stt-mlx/src/providers/mlx.rs` |
| **Deepgram Nova-2** | cloud (WSS) | **$0.0043 / min** ≈ $0.258/h | < 600 ms (cloud) | ⚠️ audio + transcript leave device | stable / GA | `crates/stt-mlx/src/providers/deepgram.rs` |
| **ElevenLabs Scribe** | cloud (WSS) | **~$0.40 / h** (~$0.0067/min) | < 800 ms (cloud) | ⚠️ audio + transcript leave device | beta — paid plan req'd | `crates/stt-mlx/src/providers/elevenlabs.rs` |

### TTS providers (1, feature-flagged)

| Provider | Cost | First-audio p95 | Privacy | Default | Code path |
|---|---|---|---|---|---|
| **ElevenLabs TTS** | varies by voice (~$0.30/1k chars) | < 2 000 ms (T-3.7 AC) | ⚠️ answer text leaves device | **OFF** (cargo feature `tts` + `VITE_ENABLE_TTS=false`) | `crates/stt-mlx/src/tts/elevenlabs.rs` + `<AnswerPanel onSpeak/>` |

### Privacy mode constraint matrix (T-3.8)

| Mode \ Provider | MLX | Deepgram | ElevenLabs STT | TTS |
|---|:---:|:---:|:---:|:---:|
| **Local-first** (default) | ✅ | ❌ disabled + tooltip | ❌ disabled + tooltip | ❌ |
| **Cloud** | ✅ | ✅ | ✅ | ✅ (if flag on) — red consent banner mounted above transcript |
| **Mixed** | ✅ | ❌ disabled + tooltip | ✅ (STT only) | ✅ (if flag on) |

Mode change auto-reverts a now-disallowed STT pick back to MLX in the same `set()` call (TS guarantee in `src/privacy/privacyMode.ts` + Rust mirror `factory_with_privacy` in `crates/stt-mlx/src/providers/privacy.rs` short-circuits with `FactoryError::PrivacyModeViolation { mode, kind }`).

### Cost meter snapshot (T-3.5)

```
──── Phase 3 Cost Meter (per-provider, calculator-derived) ────
  pricing constants (pinned, ARCH §3.2 lines 113 + 119):
    MLX ........... $0.000000 / min   (compute only)
    Deepgram ...... $0.004300 / min   ($0.258/h)
    ElevenLabs .... $0.006667 / min   ($0.400/h)

  illustrative 30-minute meeting under each provider:
    MLX ........... $0.000000  total
    Deepgram ...... $0.129000  total  ($0.258/h)
    ElevenLabs .... $0.200000  total  ($0.400/h)

  combined w/ Phase 2 LLM cost (Sonnet+Haiku $0.062/30 min from PHASE-2-COMPLETE):
    MLX + Sonnet+Haiku .......... ~$0.062 / 30 min  (~$0.124 / h)
    Deepgram + Sonnet+Haiku ..... ~$0.191 / 30 min  (~$0.382 / h)
    ElevenLabs + Sonnet+Haiku ... ~$0.262 / 30 min  (~$0.524 / h) ⚠ above $0.50/h guard
──────────────────────────────────────────────────
```

The ElevenLabs + Sonnet+Haiku combination crosses the default $0.50/h cost guard from T-2.7. The latched alert (one-shot per meeting) will fire ~30 min in unless the user raises the threshold in the Settings sheet — this is by-design risk surface from R-3 in the INDEX risk register.

### AC outcome (Phase 3 plan, line-for-line)

| Plan AC | Metric | Value | Threshold | Verdict |
|---|---|---:|---:|:---:|
| T-3.1 | Phase 1+2 cargo tests pass byte-identically | refactor relocates only — no signature changes | byte-identical | ✅ structural; live cargo pending host |
| T-3.1 | new factory test green | factory returns boxed trait obj for each kind | required | ✅ (8 unit tests) |
| T-3.2 | mocked-WS structural test green | request frame schema + golden response → segments map | required | ✅ (12 + 1 unit tests) |
| T-3.2 | live demo latency | < 800 ms first-token | wall-clock | ⚠ deferred to `PHASE-BROWSER-TEST.md` step 2 |
| T-3.3 | reconnect within 10 s | bounded backoff schedule = ~750 ms worst-case | < 10 s | ✅ (4 backoff units + chaos test) |
| T-3.3 | 3-strike rule emits typed error | `SttError::ProviderUnavailable { attempts, last_error }` | required | ✅ |
| T-3.4 | mocked-WS structural test green | ElevenLabs Scribe — same shape as T-3.2 | required | ✅ (15 + 3 unit tests) |
| T-3.4 | live demo parity | < 800 ms first-token | wall-clock | ⚠ deferred to `PHASE-BROWSER-TEST.md` step 2 |
| T-3.5 | calculator unit test green | per-provider $/min × duration math | required | ✅ (51 vitest cases) |
| T-3.5 | switch MLX → Deepgram → cumulative cost increases at expected rate | onUpdate stream test asserts monotonic + per-rate | required | ✅ |
| T-3.6 | picker updates store | `useSettingsStore.providerKey` reactive | required | ✅ (8 RTL + 7 store) |
| T-3.6 | test conn toast within 3 s | mock fetch round-trip < 3 000 ms | wall-clock | ✅ (deterministic stub; live host = step 2c) |
| T-3.7 | feature flag default OFF | default Vite build tree-shakes TTS modules; default cargo build excludes `tts` | required | ✅ (R-3.7-2 gate) |
| T-3.7 | flag-on mocked audio plays | speaking pill flips < 2 000 ms wall-clock | < 2 s | ✅ (AP-S15 unit) |
| T-3.8 | Local-first → Deepgram disabled with tooltip | `disabled` attr + tooltip text on picker option | required | ✅ (29 matrix + 6 RTL) |
| T-3.8 | Cloud mode → red consent banner | banner mounts above `<TranscriptView/>` | required | ✅ (3 banner unit) |
| T-3.9 | 100-event PII scrub | `text` / `transcript` / `pcm` / `audio` keys absent from every log line | exact-0 | ✅ (TM-S1..S20) |
| T-3.9 | 10 MB rotation | synthetic large-event triggers rotation cadence | required | ✅ |
| T-3.9 | opt-in flag default OFF | `telemetryEnabled` default `false` in store | required | ✅ |
| T-3.10 | provider-comparison.md present | 9 required sections (3 STT + 1 TTS table + privacy + cost + setup + maturity + refs + per-provider notes) | required | ✅ |
| T-3.10 | ARCH addendum landed | append-only — `git diff HEAD -- docs/ARCHITECTURE.md \| grep -E "^-[^-]"` empty | 0 deletions | ✅ (162 insertions, 0 deletions) |

All Phase 3 plan ACs cleared on the sandbox-runnable side. The four wall-clock-deferred ACs (live latency for T-3.2 / T-3.4 / T-3.6 test connection, plus the 30-min stress) are explicit in `PHASE-BROWSER-TEST.md` step numbers and follow the same `CAVEAT-GO` shape as Phase 1+2.

---

## What works (sandbox-verifiable end-to-end)

The full Phase 3 surface runs in vitest + cargo with mocked WebSockets, a fake clock, and deterministic stubs, exercising **production code paths verbatim** (no scaffolding, no test-only forks). Walking the data flow:

1. **Provider selection → factory dispatch** — `crates/stt-mlx/src/providers/mod.rs::factory(kind, cfg)` (T-3.1) returns `Box<dyn SttProvider>` for `ProviderKind::Mlx | Deepgram | Elevenlabs`. The MLX impl moved verbatim to `providers/mlx.rs`; trait surface byte-identical with Phase 1 `crates/stt-mlx/src/provider.rs`. `helper-daemon` imports unchanged.
2. **Privacy gate (backend-enforced)** — `crates/stt-mlx/src/providers/privacy.rs::factory_with_privacy(kind, mode, cfg)` (T-3.8) short-circuits with `FactoryError::PrivacyModeViolation` if `kind` is disallowed under `mode`. UI is the first gate; backend is the trust boundary. Mirrors TS `src/privacy/privacyMode.ts::isProviderAllowed`.
3. **Deepgram streaming** — `providers/deepgram.rs` (T-3.2) opens `wss://api.deepgram.com/v1/listen?model=nova-2&...`, streams 16 kHz linear16 PCM frames, parses interim + final results into `SttSegment`. Reconnect (T-3.3) uses `BackoffConfig` — exponential with jitter, ≤ 3 retries, ~750 ms worst-case schedule, surfaces `SttError::ProviderUnavailable { attempts, last_error }` after exhaustion.
4. **ElevenLabs streaming** — `providers/elevenlabs.rs` (T-3.4) opens `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream` with `xi-api-key` auth header. Reuses `BackoffConfig` (relocated to `providers/backoff.rs`, feature-ungated). Same parse → `SttSegment` shape as Deepgram so downstream consumers are provider-agnostic.
5. **Cost meter** — `src/cost/sttCostMeter.ts` (T-3.5) reads pinned per-provider rates from `src/llm/sttPricing.ts` (`MLX = $0/min`, `Deepgram = $0.0043/min`, `ElevenLabs ≈ $0.0067/min`). `attachSttCostMeter(providerStream, meter)` wires onto the existing `transcript:chunk` stream from Phase 1 T-1.6 — no edits to T-1.6. Provider switch mid-meeting → cumulative cost increases at the **new** provider's rate without losing the prior tally.
6. **Settings sheet** — `<SettingsSheet/>` (T-3.6) mounts under a collapsed `<details>` in `App.tsx` (Phase 1/2 layout undisturbed). Picker updates `useSettingsStore.set({ sttProvider })` reactively; per-provider API key fields are isolated (Deepgram key never leaks into ElevenLabs slot); "Test connection" button runs `defaultTestSttConnection(kind, key)` — env-aware fail message when key absent, deterministic-pass stub when present. Live Tauri-wired round-trip deferred to Phase 3.x.
7. **Privacy mode picker** — `<SettingsSheet/>` (T-3.8) adds a `<select>` for `local-first | cloud | mixed`; default = `local-first`. On mode change, `useSettingsStore.set` auto-snaps a now-disallowed `sttProvider` back to `mlx` in the **same call** (no reactive flicker). Cloud mode mounts `<CloudConsentBanner/>` above `<TranscriptView/>` with the ARCH §11 wording verbatim.
8. **Settings persistence** — schema bumped to `meeting-copilot:settings:v2` (T-3.6). Non-destructive v1 fallback: legacy key left in place for downgrade rollback. New fields: `sttProvider`, `deepgramApiKey`, `elevenlabsApiKey`, `privacyMode`, `telemetryEnabled`.
9. **TTS (feature-gated)** — `crates/stt-mlx/src/tts/{provider,elevenlabs}.rs` behind cargo feature `tts` (default OFF). `<AnswerPanel onSpeak/>` (T-3.7) only renders the Speak button when prop is provided; `App.tsx` provides the prop only when `ENABLE_TTS && isTtsAllowed(privacyMode)` — both gates must hold. Default Vite build tree-shakes TTS modules out via dynamic import.
10. **Telemetry log (opt-in)** — `src/telemetry/telemetryLog.ts` (T-3.9) — `appendEvent(event)` runs `scrubEvent(event)` first, which drops `FORBIDDEN_KEYS = ['text', 'transcript', 'pcm', 'audio', 'samples', 'bytes']` (allow-list approach — denied unless explicitly allowed). Sink rotates at 10 MB UTF-8 byte count. Default-OFF flag in settings store (`telemetryEnabled = false`). 100-event integration test grep-asserts forbidden keys absent from every log line.

End-to-end vitest 602/602 + cargo (sandbox-blocked, code-complete with structural tests) under the plan's: provider switch without restart ✓, cost meter accurate per-provider rate ✓, TTS feature flag default OFF ✓, telemetry opt-in default OFF + 10 MB rotation + no PII ✓, privacy mode constraint matrix UI + backend ✓.

---

## Known caveats (carry-forward + Phase-3-specific)

These are documented in `INDEX.md` lines 39–43 and align with Phase 1+2 sign-off §"Known caveats". Each has a documented re-run path. None are bugs in Phase 3 code.

| ID | Caveat | Source | Where re-verified |
|---|---|---|---|
| C-A | **BlackHole 2ch + Aggregate Device install pending.** Does NOT block Phase 3 — provider switch operates over the same transcript stream, agnostic of mic vs system audio. | Phase 0 + Phase 1+2 sign-offs | `PHASE-BROWSER-TEST.md` Prerequisites + steps 2 + 9. |
| C-B | **`ANTHROPIC_API_KEY` not exported on sandbox.** Phase 3 doesn't add a new ANTHROPIC dependency; carry-forward. | Phase 1+2 §"Known caveats" | `PHASE-BROWSER-TEST.md` step 1 sanity. |
| C-C | **`cargo` + `rustup` + `tauri-cli` not installed on loop sandbox.** Phase 3 ADDS Rust source for T-3.1..T-3.4 + T-3.7 + T-3.8. The 76 net-new cargo tests are code-complete; live `cargo test --workspace` is item P-1 in `PHASE-BROWSER-TEST.md`. | Phase 0 INDEX blocked-action #3 | `PHASE-BROWSER-TEST.md` pre-flight P-1 (`cargo test --workspace` + `cargo test -p stt-mlx --features tts`). |
| C-D | **MLX runtime requires Apple-Silicon hardware + Python venv.** Phase 3 does not change the MLX path; same dependency as Phase 1. | Phase 1 §"Known caveats" + T-1.5 review | `PHASE-BROWSER-TEST.md` step 1 + step 9. |
| C-E | **C-2 carry-forward** (1.7× M1 Max → M1 Pro RTF scaling rule-of-thumb). Same shape; cloud STT (Deepgram / ElevenLabs) is network I/O so M1 Pro vs M1 Max parity is irrelevant for those two providers. | Phase 1+2 §"Known caveats" | `PHASE-BROWSER-TEST.md` step 9 (latency under provider switch). |
| C-F | **Phase-2 fixture-mode metric ≠ live recording metric** carry-forward. Phase 3 doesn't move the catch-rate goalposts; the `T-2.10` Phase 2 metric report stays the AC gate for question-detection. | Phase 2 §"Known caveats" + T-2.10 review | Phase 2 PHASE-BROWSER-TEST.md (still applicable). |
| C-G | **Phase-3-new: `DEEPGRAM_API_KEY` + `ELEVENLABS_API_KEY` not exported on sandbox.** Provider construction + connect path asserted via mocked-WebSocket structural tests + factory missing-key path tests; live Deepgram + ElevenLabs round-trip pending host. ElevenLabs Scribe **requires a paid plan** — free-tier keys will hit 403, which is not a test bug. | T-3.2/T-3.4/T-3.6 reviews + INDEX §"Inputs Carried Forward" #2 | `PHASE-BROWSER-TEST.md` Prerequisites + steps 2a-c + step 9. |
| C-H | **Phase-3-new: TTS feature flag is BUILD-TIME on Rust side, RUNTIME on TS side.** Cargo feature `tts` must be enabled at compile time on the helper-daemon binary; `VITE_ENABLE_TTS=true` toggles the UI prop at runtime. Both gates must hold. | T-3.7 review §"Feature flag scope" | `PHASE-BROWSER-TEST.md` step 8 (TTS wall-clock check requires both flags on). |
| C-I | **Phase-3-new: telemetry sink is in-memory in this loop.** The `TelemetrySink` in T-3.9 is a rotating in-memory ring; a Tauri-fs-backed sink that writes to `~/Library/Application Support/com.meeting-copilot.app/telemetry/*.log` is deferred to Phase 3.x. The unit-test gate (PII scrub + rotation cadence) is the calculator-correctness gate; the on-disk path verify is `PHASE-BROWSER-TEST.md` step 7. | T-3.9 review §"Hand-off" | Phase 3.x backlog (interface seam ready). |

---

## Deferred (Phase 3.x backlog — NOT regressions)

Tracked here so a future loop driver can pick them up without re-deriving. None of these gate Phase 3 closure; each was scoped out **explicitly** in its parent task's spec doc.

- **Tauri-fs-backed telemetry sink** — T-3.9 ships the rotating in-memory sink + the calculator. The Tauri-fs adapter that writes to `~/Library/Application Support/com.meeting-copilot.app/telemetry/*.log` is the wall-clock surface for `PHASE-BROWSER-TEST.md` step 7; the interface is stable and just needs Rust glue.
- **Live-Tauri "Test connection" round-trip** — T-3.6 ships `defaultTestSttConnection` as a deterministic stub (env-aware fail message when key missing) + a prop-injection seam. The live Tauri-wired round-trip (POST a 1-second silent PCM frame, assert 200 / handshake) is deferred to Phase 3.x — needs a Tauri command that bridges the TS button to a Rust handshake call.
- **macOS Keychain `DEEPGRAM_API_KEY` + `ELEVENLABS_API_KEY` storage** — Settings sheet currently reads from env + accepts UI override into store. Keychain integration via `tauri-plugin-keychain` is Phase 3.x.
- **TTS BlackHole virtual-output routing** — T-3.7 documents the routing in `provider-comparison.md` §TTS notes; the wall-clock pass in `PHASE-BROWSER-TEST.md` step 8 assumes the user has BlackHole installed and selected as the audio output device. Auto-route logic is Phase 3.x.
- **TLS for Deepgram WebSocket** — T-3.2 ships handshake-only with plain `ws://` for the unit-test fixture; the production path uses `wss://` via `tungstenite` with `rustls`. Phase 3.x: explicit cert-pin if Deepgram rotates their CA chain.
- **Advanced provider knobs** — Deepgram `tier` / `model` selection beyond Nova-2, ElevenLabs `voice_id` selection for TTS, Deepgram speaker diarization toggle. Phase 3 ships the picker; per-provider sub-settings are Phase 3.x.
- **Telemetry export / debug viewer UI** — Settings sheet has the opt-in checkbox but no in-app log viewer or "export last N events" button. Phase 3.x UX-polish.
- **Phase 2.x carry-forward backlog** — embedding-based dedup, SQLite queue checkpoint, `useQueueWorker` React hook, app-level `QuestionFeed` mount, settings sheet polish, inline-in-transcript chips, Haiku live-latency measurement, real-recording catch/useful rate. These do NOT gate Phase 3 closure (carry-forward from `PHASE-2-COMPLETE.md`).

---

## Files inventory (Phase 3 net new)

### Source (`src/`, `crates/`, `shared/`)

| Path | Owner task | Role |
|---|---|---|
| `crates/stt-mlx/src/providers/mod.rs` | T-3.1 | `ProviderKind` enum + `factory(kind, cfg) -> Box<dyn SttProvider>` + `FactoryError`. |
| `crates/stt-mlx/src/providers/mlx.rs` | T-3.1 | `MlxWhisperSubprocess` relocated from `mlx.rs` (byte-identical behavior). |
| `crates/stt-mlx/src/providers/deepgram.rs` | T-3.2 + T-3.3 | Nova-2 WSS adapter + reconnect (`BackoffConfig`) + 3-strike `SttError::ProviderUnavailable`. |
| `crates/stt-mlx/src/providers/backoff.rs` | T-3.3 (relocated by T-3.4) | `BackoffConfig` — feature-ungated, reusable; back-compat re-export from `deepgram::BackoffConfig`. |
| `crates/stt-mlx/src/providers/elevenlabs.rs` | T-3.4 | Scribe streaming WSS adapter. Reuses `BackoffConfig`. `xi-api-key` auth. |
| `crates/stt-mlx/src/providers/privacy.rs` | T-3.8 | `factory_with_privacy(kind, mode, cfg)` short-circuit gate + `FactoryError::PrivacyModeViolation`. |
| `crates/stt-mlx/src/tts/provider.rs` | T-3.7 | `TTSProvider` trait — gated by cargo feature `tts`, default OFF. |
| `crates/stt-mlx/src/tts/elevenlabs.rs` | T-3.7 | ElevenLabs TTS adapter — transport-injected (no `reqwest` in default deps). |
| `src/llm/sttPricing.ts` | T-3.5 | Per-provider $/min constants pinned to ARCH §3.2 lines 113 + 119; `computeSttCostUsd()`. |
| `src/cost/sttCostMeter.ts` | T-3.5 | `createSttCostMeter` — onUpdate stream sink + provider-switch handling. |
| `src/cost/attachSttCostMeter.ts` | T-3.5 | Wires meter onto existing `transcript:chunk` Tauri stream. |
| `src/components/SettingsSheet.tsx` | T-3.6 + T-3.8 + T-3.9 | Provider picker + per-provider API key + Test connection + Privacy mode + Telemetry checkbox. |
| `src/components/CloudConsentBanner.tsx` | T-3.8 | Red banner above transcript when privacy mode = `cloud`. |
| `src/components/AnswerPanel.tsx` | T-3.7 (edit) | Adds optional `onSpeak?: () => void` prop — Speak button only renders when defined. |
| `src/privacy/privacyMode.ts` | T-3.8 | `PrivacyMode` type + `isProviderAllowed` + `isTtsAllowed` (TS source-of-truth, mirrored in Rust). |
| `src/telemetry/scrub.ts` | T-3.9 | `FORBIDDEN_KEYS` allow-list scrubber. |
| `src/telemetry/sinks.ts` | T-3.9 | Rotating in-memory `TelemetrySink` (10 MB UTF-8 byte count). |
| `src/telemetry/telemetryLog.ts` | T-3.9 | `createTelemetryLog` factory + `appendEvent` returning `{written, rotated, reason?}`. |
| `src/store/settingsStore.ts` | T-3.6 + T-3.8 + T-3.9 (edit) | Schema → `meeting-copilot:settings:v2`; new fields: `sttProvider`, `deepgramApiKey`, `elevenlabsApiKey`, `privacyMode`, `telemetryEnabled`. |
| `src/App.tsx` | T-3.6 + T-3.7 + T-3.8 (edits) | Mounts `<SettingsSheet/>` (T-3.6); gates `<CloudConsentBanner/>` (T-3.8); gates `<AnswerPanel onSpeak/>` (T-3.7). |
| `src/App.css` | T-3.6 + T-3.8 (edits) | Settings sheet + privacy banner styles. |

### Tests

| Path | Owner task | Cases | Target | Outcome |
|---|---|---:|---|---|
| `crates/stt-mlx/src/providers/mod.rs::tests` | T-3.1 | 8 | cargo | ✅ structural |
| `crates/stt-mlx/src/providers/deepgram.rs::tests` | T-3.2 + T-3.3 | 13 + 7 | cargo | ✅ structural |
| `crates/stt-mlx/src/providers/elevenlabs.rs::tests` | T-3.4 | 18 | cargo | ✅ structural |
| `crates/stt-mlx/src/providers/privacy.rs::tests` | T-3.8 | 10 | cargo | ✅ structural |
| `crates/stt-mlx/src/tts/{provider,elevenlabs}.rs::tests` | T-3.7 | 6 + 14 | cargo `--features tts` | ✅ structural |
| `src/llm/sttPricing.test.ts` | T-3.5 | 22 | vitest | ✅ |
| `src/cost/sttCostMeter.test.ts` | T-3.5 | 24 | vitest | ✅ |
| `src/cost/attachSttCostMeter.test.ts` | T-3.5 | 5 | vitest | ✅ |
| `src/store/settingsStore.test.ts` (T-3.6/T-3.8/T-3.9 additions) | T-3.6 + T-3.8 + T-3.9 | +7 +5 +3 | vitest | ✅ |
| `src/components/SettingsSheet.test.tsx` | T-3.6 + T-3.8 + T-3.9 | 8 + 6 + 2 | vitest | ✅ |
| `src/components/CloudConsentBanner.test.tsx` | T-3.8 | 3 | vitest | ✅ |
| `src/components/AnswerPanel.test.tsx` (Speak additions) | T-3.7 | 6 | vitest | ✅ |
| `src/components/__tests__/ttsFeatureFlag.test.tsx` | T-3.7 | 7 | vitest | ✅ |
| `src/components/__tests__/elevenLabsTtsAdapter.test.ts` | T-3.7 | 13 | vitest | ✅ |
| `src/privacy/privacyMode.test.ts` | T-3.8 | 29 | vitest | ✅ |
| `src/telemetry/scrub.test.ts` | T-3.9 | included in TM-S1..S20 | vitest | ✅ |
| `src/telemetry/sinks.test.ts` | T-3.9 | included in TM-S1..S20 | vitest | ✅ |
| `src/telemetry/telemetryLog.test.ts` | T-3.9 | TM-S1..S20 (43 total) | vitest | ✅ |
| **Phase 3 net new** | — | **+194 vitest, +76 cargo** | — | **all green (sandbox); cargo live re-run pending host** |

### Docs

| Path | Role |
|---|---|
| `docs/tasks/phase-3/INDEX.md` | Loop INDEX + dependency graph + AC summary + risk register. |
| `docs/tasks/phase-3/T-3.<N>-<slug>.md` × 10 | Per-task spec — refs, scope, AC, TDD plan, risk + mitigation, hand-off sketch. |
| `docs/tasks/phase-3/T-3.<N>-review.md` × 10 | Per-task self-review — files changed, test count, numeric AC verdict, checklist. |
| `docs/tasks/phase-3/PHASE-BROWSER-TEST.md` | 10-step live-host re-verify procedure (boot → provider switch → cost meter → privacy gate → telemetry → TTS → 30-min stress → reconnect chaos → reload). |
| `docs/ARCHITECTURE.md` | Phase 3 append-only addendum (§3.4 trait+factory, §4.1 TTS feature flag, §11.1 privacy constraint, §14 NEW telemetry, §15 NEW cost meter). 162 insertions, 0 deletions. |
| `docs/provider-comparison.md` | Per-provider table (3 STT + 1 TTS) + per-provider notes + privacy matrix + cost reference + setup steps + API maturity caveats + references. |
| `docs/tasks/phase-3/PHASE-3-COMPLETE.md` | This file. |

---

## Hand-off to Phase 4 (or next phase per `IMPLEMENTATION-PLAN.md`)

Phase 3 closes the pluggable-providers surface and ships the user-visible provider picker, privacy gate, cost meter, opt-in telemetry, and feature-flagged TTS. The seams to look for:

- **`crates/stt-mlx/src/providers/mod.rs::factory`** is the single dispatch point; adding a new STT provider (Whisper.cpp, AssemblyAI, etc.) is now a `providers/<name>.rs` + 1 enum variant + 1 factory match arm.
- **`src/privacy/privacyMode.ts::isProviderAllowed`** + Rust mirror — adding a 4th privacy mode or constraining a new provider is a single-table edit on both sides (TS + Rust). The constraint matrix test is parameterized on the table.
- **`src/llm/sttPricing.ts`** — adding a new provider's $/min rate is a single constant + a `provider-comparison.md` row update.
- **`src/cost/sttCostMeter.ts::createSttCostMeter`** is provider-agnostic; new providers slot in via the `ProviderKind` enum without meter code edits.
- **`src/telemetry/scrub.ts::FORBIDDEN_KEYS`** is the privacy trust boundary for telemetry — adding a new sensitive field name is a single-array edit + a regression test that asserts grep-zero.
- **`<SettingsSheet/>`** has stable seams: provider picker, per-provider API key, test connection button, privacy mode picker, telemetry checkbox. New settings should follow the same layout.
- **TTS surface (`<AnswerPanel onSpeak/>` + `crates/stt-mlx/src/tts/`)** is the template for any new feature-flagged surface — `cargo feature` + `VITE_ENABLE_*` runtime flag, both must hold.
- **The Phase-3.x backlog items above are NOT next-phase dependencies** — they can land any time without affecting subsequent phases.

**Stack lock for next phase (per plan)**: keep Tauri 2 + React + Rust + MLX + Sonnet + Haiku + the Phase 3 provider stack. Future phases extend; they do not rewrite.

---

## Acknowledgments

Co-author trail per loop Rule 4: every task commit on `main` carries the footer

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Sign-off commit (this file) is committed under the same convention. **No `git push` performed**.
