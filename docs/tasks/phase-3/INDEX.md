# Phase 3 — Pluggable Providers — Task Index

> Reference: `docs/IMPLEMENTATION-PLAN.md` §"Phase 3 — Pluggable Providers" (lines 97–118). Read-only spec.
> Architecture refs: ARCH §3 "STT — Pluggable Provider" (lines 78–122), §4 "TTS — Pluggable Provider" (126–140), §11 "Privacy Modes" (395–408), §13 "Cost Model" (430–447).
> Carry-forward sign-offs: `docs/tasks/phase-1/PHASE-1-COMPLETE.md`, `docs/tasks/phase-2/PHASE-2-COMPLETE.md`.
> Stack lock (carry-forward from Phase 2): **Tauri 2 + React + TypeScript + Rust helper daemon + MLX whisper + Claude Sonnet 4.6 + Claude Haiku 4.5**. Phase 3 ADDS: Deepgram WebSocket, ElevenLabs STT, optional ElevenLabs TTS (feature-flag, default off), provider factory.
> Working dir: `/Users/hieutran/projects/bridge-bot-ts-1/meeting-copilot/`.
> **Layout note (binding):** the plan literal-mentions `daemon/src/stt-mlx/`. Actual Phase 1/2 layout is `crates/stt-mlx/` (a Cargo workspace member). Phase 3 refactor lands as `crates/stt-mlx/src/providers/{mlx,deepgram,elevenlabs}.rs` (or a new sibling crate `crates/stt-providers/` if the refactor warrants it — decided in T-3.1). Plan wording is honored semantically, not literally.

---

## Phase Goal (verbatim from plan)

> Cho phép user switch STT provider (MLX ↔ Deepgram ↔ ElevenLabs) và optional TTS, qua interface clean.

## Phase Exit Criteria (verbatim)

> Switch provider runtime không cần restart, ≥ 2 provider STT hoạt động ổn định trong 30-phút stress test.

This loop's gate (mirrors Phase 1/2 sign-off shape):

1. `bun test` (vitest) + `cargo test --workspace` all green — no Phase 1 / Phase 2 regression.
2. ≥ 2 STT providers exercised in a 30-minute stress test — manual verification steps documented in `PHASE-BROWSER-TEST.md` (live host pass) with structural fallback in vitest where hardware/network is unavailable.
3. `PHASE-3-COMPLETE.md` sign-off committed with provider-comparison table, cost-meter snapshot, and privacy-mode constraint matrix.

---

## Inputs Carried Forward From Phase 1+2

These artifacts are re-used (NOT rewritten); Phase 3 plugs into the same seams:

- **`crates/stt-mlx/src/provider.rs`** (T-1.5) — `SttProvider` trait, `SttSegment`, `SttError`, `FakeStt`. T-3.1 extracts this into a provider-agnostic surface (rename trait module if needed) and the MLX impl moves to `providers/mlx.rs`.
- **`crates/stt-mlx/src/mlx.rs`** (T-1.5) — `MlxWhisperSubprocess`. Refactor target for T-3.1 — moves under `providers/mlx.rs` with no behavior change.
- **`src/llm/pricing.ts`** (T-1.10 + T-2.3) — Sonnet + Haiku pricing constants. T-3.5 extends with Deepgram (`$0.0043/min` per ARCH §3.2) and ElevenLabs Scribe (`~$0.40/h` per ARCH §3.2) per-second/per-minute rates.
- **`src/cost/costGuard.ts`** (T-2.7) — meeting-wide cost ledger. T-3.5 adds STT cost as a new line item; threshold-alert plumbing reused.
- **`src/store/settingsStore.ts`** (T-2.9) — versioned `localStorage` key `meeting-copilot:settings:v1`. T-3.6 + T-3.8 add provider-picker fields; bump key to `v2` with first-read migration.
- **`shared/types.ts`** — `Question.confidence`, `TranscriptChunk` types stable; T-3.4 may extend `TranscriptChunk` with provider-supplied `speaker` / `confidence` if Deepgram/ElevenLabs surfaces them.

Three Phase-0 blocked user-actions stay open (documented in Phase 1+2 sign-offs):

1. BlackHole 2ch + Aggregate Device — does NOT block Phase 3 (provider switch operates over the same transcript stream).
2. `ANTHROPIC_API_KEY` — already-noted; Phase 3 adds two **new** API keys: `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY`. Missing keys MUST fail gracefully — provider greys out in picker with tooltip; live "test connection" returns a typed error.
3. `cargo` + `rustup` + `tauri-cli` not installed on loop sandbox — same shape; Rust-side T-3.1..T-3.4 ship as code-complete with structural Rust tests + mocked-WebSocket harness.

---

## Task Checklist (10 tasks)

- [x] **T-3.1** — Refactor: extract `SttProvider` trait + factory pattern; move MLX impl to `providers/mlx.rs`. Phase 1+2 tests stay green (no regression). **AC:** existing `cargo test --workspace` passes byte-identically; new `providers/mod.rs` exposes `pub fn factory(provider: ProviderKind, cfg: ProviderConfig) -> Box<dyn SttProvider>`. Dep: T-2.10. Risk: refactor break — covered by carry-forward test pass. **Outcome:** 8 new factory tests, 0 public-surface removals, helper-daemon imports byte-identical; cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.2** — Deepgram WebSocket adapter (`providers/deepgram.rs`). Sends 16 kHz linear16 PCM frames over `wss://api.deepgram.com/v1/listen?model=nova-2&...`; parses interim + final results into `SttSegment`. **AC:** mocked-WebSocket structural test asserts request frame schema + golden response → segments map; live demo (manual) — switch provider in UI, latency < 800 ms. Dep: T-3.1. Risk: API key mgmt + framing bugs. **Outcome:** 12 new tests in `providers::deepgram::tests` + 1 factory regression for the missing-key path; `tungstenite = 0.21` (handshake-only, plain `ws://`); TLS + reconnect intentionally deferred to T-3.3. Cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.3** — Reconnect / chaos handling for Deepgram. Exponential backoff (≤ 3 retries within 10 s), surface user prompt on persistent failure. **AC:** chaos test — kill connection mid-stream, adapter reconnects in < 10 s; after 3 failures, returns typed error and emits `SttError::ProviderUnavailable` to caller. Dep: T-3.2. Risk: reconnect storm — bounded retry + jittered backoff. **Outcome:** 7 new tests in `providers::deepgram::tests` (4 backoff units + `connect_returns_provider_unavailable_after_max_retries` + `connect_does_not_retry_on_config_error` + chaos `mock_ws_reconnects_after_mid_stream_drop`); `BackoffConfig` reusable by T-3.4 ElevenLabs; `SttError::ProviderUnavailable { attempts, last_error }` additive variant; default schedule bounded at ~750 ms worst-case (well under 10 s AC). Cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.4** — ElevenLabs STT adapter (`providers/elevenlabs.rs`). Streaming Scribe endpoint (`xi-api-key` auth header, `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream`). **AC:** same mocked-WebSocket structural test shape as T-3.2; live demo parity. Dep: T-3.1. Risk: API maturity — pin SDK version + document expected request/response in `provider-comparison.md`. **Outcome:** 15 new tests in `providers::elevenlabs::tests` (3 ctor + 6 parser + 1 encoder + 3 mock-WS + 2 reconnect operational reuse) + 3 new factory regressions (`factory_elevenlabs_propagates_config_error_when_key_missing`, `factory_elevenlabs_distinct_name_from_deepgram`, extended `factory_kind_as_str_stable`). `BackoffConfig` relocated from `providers::deepgram` to feature-ungated `providers::backoff` (back-compat re-export from `deepgram` preserved); `tungstenite = 0.21` reused (no new deps); `ELEVENLABS_API_KEY` env var with graceful fail (`SttError::Config` at construction). Bun/vitest carry-forward green: 408/408 TS tests pass. Cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.5** — Cost meter calculator + UI realtime $/h indicator. Per-provider rate table (`MLX = $0`, `Deepgram = $0.0043/min`, `ElevenLabs ≈ $0.40/h`). UI shows **session-cumulative cost** + **projected $/h**. **AC:** unit test on calculator (each provider's pricing produces correct $/h after N seconds streaming); switch MLX → Deepgram → cumulative cost increases at expected rate. Dep: T-3.2, T-3.4. Risk: pricing drift — pin constants + cross-link to provider docs in `provider-comparison.md`. **Outcome:** 51 new vitest cases (22 in `src/llm/sttPricing.test.ts` rate-table + 24 in `src/cost/sttCostMeter.test.ts` calculator + 5 in `src/cost/attachSttCostMeter.test.ts` stream wiring); 459/459 vitest green (Phase 1+2 carry-forward 408 stays byte-identical, +51 net). Pure TS — no Rust touched. T-3.6 Settings sheet $/h indicator deferred per scope split — meter exposes the snapshot the picker UI will read. Constants pinned to ARCH §3.2 lines 113 + 119; provider IDs match `ProviderKind::as_str()` (parity gate ST-S9). `onUpdate` event sink + `attachSttCostMeter` plain seam wire the meter into the existing `transcript:chunk` Tauri stream without modifying Phase 1 T-1.6.
- [x] **T-3.6** — Settings UI: STT provider picker, per-provider API key field (read from env by default; UI override via Tauri keychain plugin), "Test connection" button (POST a 1-second silent PCM frame and assert 200/handshake). **AC:** RTL component test — render Settings sheet, click picker, verify `useSettingsStore.providerKey` updates; click "Test connection" → success/fail toast within 3 s (mock fetch). Dep: T-3.2, T-3.4. Risk: scope creep — Phase 3 ships provider picker only; advanced model knobs (e.g. Deepgram `tier`, ElevenLabs `voice_id`) deferred to Phase 3.x. **Outcome:** 21 new vitest cases (7 store SS-S29..S35 covering v1→v2 migration + provider/key setters; 8 RTL SH-U1..U8 covering picker, per-key isolation, test-connection state machine, debounce); settings store schema bumped to `:v2` with non-destructive v1 fallback (legacy key left in place for downgrade rollback); `<SettingsSheet/>` mounted in `App.tsx` under collapsed `<details>` so Phase 1/2 layout is undisturbed; `defaultTestSttConnection` is a deterministic stub (env-aware fail message when key missing) + prop-injection seam for tests; live Tauri-wired round-trip deferred to T-3.10. 459 → 480 vitest, no Rust touched.
- [x] **T-3.7** — TTS interface (`TTSProvider` trait, behind cargo feature `tts` + TS feature flag default OFF) + ElevenLabs TTS implementation. UI exposes "Speak answer" button on each Q&A card. **AC:** feature flag default OFF — code path is dead-stripped on default build; flag-on test exercises mocked audio output; with `feature = "tts"` enabled, button → mocked audio chunk plays in < 2 s. Dep: T-3.1. Risk: audio device routing on macOS — document BlackHole virtual-output routing in `provider-comparison.md`. **Outcome:** 26 new vitest cases (7 TF feature-flag + 13 EL adapter + 6 AP Speak button) on top of 480 carry-forward → **506 / 506 green**. Rust side: new `crates/stt-mlx/src/tts/` module behind `tts` cargo feature (default OFF, zero new deps) — `provider.rs` (trait + 6 tests) + `elevenlabs.rs` (adapter + 14 tests, transport-injected so `reqwest` stays out of the default dep graph). `<AnswerPanel/>` adds an optional `onSpeak?` prop — when undefined the Speak button has no DOM presence; App.tsx gates the prop on `ENABLE_TTS` (reads `VITE_ENABLE_TTS`, default false) so the default Vite build tree-shakes the TTS modules out of the initial bundle via dynamic import. Click → speaking pill flips < 2 000 ms wall-clock (AP-S15). No key-leak path introduced (privacy audit in `T-3.7-review.md`). Cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.8** — Privacy mode picker. Three modes per ARCH §11: Local-first / Cloud / Mixed. Mode constrains provider list (Local-first → only MLX selectable; Cloud → Deepgram + ElevenLabs unlocked; Mixed → MLX + ElevenLabs TTS). **AC:** constraint test — pick Local-first → Deepgram option shows `disabled` attr + tooltip; pick Cloud → red consent banner appears at top of transcript view. Dep: T-3.6. Risk: UX confusion — tooltip + ARCH §11 banner wording verbatim. **Outcome:** 46 new vitest cases (29 PM-S1..S23 matrix + 7 SS-S36..S40 store + 6 SH-U9..U14 RTL + 3 CB-U1..U3 banner) on top of 506 carry-forward → **552 / 552 green**. New `src/privacy/privacyMode.ts` (single TS source of truth) + new `crates/stt-mlx/src/providers/privacy.rs` (Rust mirror with `factory_with_privacy` short-circuit gate) + 10 cargo tests. Default mode is `"local-first"` (audio never leaves machine); auto-revert on mode change snaps disallowed STT provider back to MLX in the same `set()` call. Cloud mode mounts a red consent banner above `<TranscriptView/>`; Local-first + Mixed render none. TTS gating tightened: Speak button now requires `ENABLE_TTS && isTtsAllowed(privacyMode)`. New `FactoryError::PrivacyModeViolation { mode, kind }` variant — additive (existing match arms in tests stay green). No API-key leak surface introduced (privacy audit + 0-hit grep gate). Cargo re-verify pending host (sandbox blocked-action #3 carry-forward).
- [x] **T-3.9** — Local telemetry log (opt-in). Records provider switches, errors, latencies; rotates at 10 MB; **never** writes audio bytes or transcript content. **AC:** unit test — feed 100 events, log file rotates at 10 MB (synthetic large-event), no entry contains transcript field; opt-in flag default OFF. Dep: T-3.5. Risk: privacy review — explicit grep in test assert ensures `text` / `pcm` keys absent from log lines. **Outcome:** 50 net new vitest cases (43 in `src/telemetry/{scrub,sinks,telemetryLog}.test.ts` covering TM-S1..S20 incl. the 100-event PII-scrub gate + the synthetic 10 MB rotation cadence; +5 SS-S41..S43 for the opt-in store toggle; +2 SH-U15..U16 for the SettingsSheet checkbox) on top of 552 carry-forward → **602 / 602 green**. New `src/telemetry/` module: pure scrubber (`FORBIDDEN_KEYS` + `scrubEvent` + `containsForbiddenKey` allow-list), rotating in-memory `TelemetrySink` with UTF-8 byte counting, factory `createTelemetryLog` with sync `appendEvent` returning `{written, rotated, reason?}`. Settings store gains `telemetryEnabled` field (default `false`, persisted in v2 slot via existing `coerceLoaded` zero-fill — no schema bump). `<SettingsSheet/>` adds a checkbox row + hint. No Rust touched (Tauri-fs sink + live wire-up deferred to Phase 3.x — telemetry calculator is the unit gate).
- [ ] **T-3.10** — Docs: update `docs/ARCHITECTURE.md` with a Phase 3 addendum (DO NOT delete existing content — append a §3.4 / §4.x / §11.x subsection or a clearly-marked "Phase 3 update" block); write `docs/provider-comparison.md` (per-provider table: latency, cost, privacy, API maturity, setup steps). **AC:** docs reflect Phase 3 reality — provider-comparison table has 3 STT rows + 1 TTS row; ARCH addendum cross-references implementation files. Dep: T-3.7. Risk: doc drift — review against actual code paths after T-3.7 lands.

---

## Dependency Graph (ASCII)

```
        ┌───────────────────────────────────────────────────────────────┐
        │  Phase 1+2 carry-forward (NOT re-implemented):                │
        │   crates/stt-mlx (trait + MlxWhisperSubprocess)               │
        │   src/cost/costGuard, src/store/settingsStore, pricing.ts     │
        └──────┬────────────────────────────────────────────────────────┘
               ▼
         ┌──────────┐
         │  T-3.1   │   refactor: extract trait + factory; MLX → providers/mlx.rs
         └────┬─────┘
              ├──────────────┬───────────────┬─────────────┐
              ▼              ▼               ▼             ▼
         ┌──────────┐  ┌──────────┐    ┌──────────┐  ┌──────────┐
         │  T-3.2   │  │  T-3.4   │    │  T-3.7   │  │ (parallel
         │ Deepgram │  │ElevenLabs│    │   TTS    │  │   any-time
         │   STT    │  │   STT    │    │ (flag)   │  │   after T-3.1)
         └────┬─────┘  └────┬─────┘    └────┬─────┘
              ▼             │               │
         ┌──────────┐       │               │
         │  T-3.3   │       │               │
         │reconnect │       │               │
         │  chaos   │       │               │
         └────┬─────┘       │               │
              └───┬─────────┘               │
                  ▼                         │
            ┌──────────┐                    │
            │  T-3.5   │   cost meter (per-provider rate table)
            └────┬─────┘                    │
                 ▼                          │
            ┌──────────┐                    │
            │  T-3.6   │   Settings: picker + API key + test conn
            └────┬─────┘                    │
                 ▼                          │
            ┌──────────┐                    │
            │  T-3.8   │   Privacy mode picker (constrains T-3.6 list)
            └────┬─────┘                    │
                 ▼                          │
            ┌──────────┐                    │
            │  T-3.9   │   Telemetry (opt-in, no PII)
            └────┬─────┘                    │
                 ▼                          ▼
                 └──────────────┬───────────┘
                                ▼
                          ┌──────────┐
                          │  T-3.10  │  Docs (ARCH addendum + provider-comparison.md)
                          └──────────┘
```

Critical path: T-3.1 → T-3.2 → T-3.3 → T-3.5 → T-3.6 → T-3.8 → T-3.9 → T-3.10. T-3.4 parallel after T-3.1 (joins T-3.5 input). T-3.7 fully parallel after T-3.1 (independent feature flag).

---

## TDD per task

| Task | Harness | Notes |
|---|---|---|
| T-3.1 | `cargo test --workspace` (carry-forward green) + 1 new structural test asserting factory returns boxed trait obj | Refactor risk — Phase 1/2 cargo tests must remain byte-identical pass |
| T-3.2 | `cargo test --features mock-ws` + golden response fixture | Mocked WebSocket; structural request schema + segment mapping |
| T-3.3 | `cargo test` chaos test — kill connection mid-stream, assert reconnect within 10 s | Bounded retry + jitter |
| T-3.4 | Same shape as T-3.2 (mocked-WS + golden response) | ElevenLabs Scribe API — pin SDK version |
| T-3.5 | Vitest unit (TS calculator) + cargo unit (Rust if calc lives in Rust) | Per-provider rate × duration math |
| T-3.6 | RTL component test on Settings sheet | Picker + API key field + "Test connection" mock fetch |
| T-3.7 | `cargo test --features tts` + Vitest unit on UI button | Default-OFF feature flag — no code path on default build |
| T-3.8 | Vitest unit (constraint matrix) + RTL component test (disabled attr + tooltip) | 3 privacy modes × 3 STT providers × 2 TTS = constraint table |
| T-3.9 | Vitest unit on log writer + 10 MB rotation synthetic | Privacy assert — explicit grep `text` / `pcm` keys absent |
| T-3.10 | Docs review only — `bun run typecheck` + manual diff against ARCH/PRD | No code; AC = docs reflect reality |

---

## Acceptance Criteria Summary

| Task | Numeric AC |
|---|---|
| T-3.1 | Phase 1+2 cargo tests pass byte-identically; new factory test green |
| T-3.2 | Mocked-WS structural test green; live demo latency < 800 ms (manual) |
| T-3.3 | Reconnect within 10 s; 3-strike rule emits typed error |
| T-3.4 | Same shape as T-3.2 — mocked-WS green; live demo parity |
| T-3.5 | Calculator unit test green; switch MLX → Deepgram → cumulative cost increases at expected rate |
| T-3.6 | Picker updates store; test conn toast within 3 s |
| T-3.7 | Feature flag default OFF; flag-on mocked audio plays < 2 s |
| T-3.8 | Local-first → Deepgram disabled with tooltip; Cloud mode → red consent banner |
| T-3.9 | 10 MB rotation; no audio/transcript content in log |
| T-3.10 | provider-comparison.md present + ARCH addendum landed |

---

## Risk Register (Phase 3 specific — top 5)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Refactor breaks Phase 1/2 cargo tests.** Trait extraction or module rename ripples into `audio-capture`, `helper-daemon`, `meeting-copilot` (Tauri shell). | Medium | High | T-3.1 ships with `cargo test --workspace` as the verify gate — byte-identical pass required before commit. Refactor scope = relocation only (no signature changes). |
| R-2 | **Deepgram / ElevenLabs API instability.** Provider may change WebSocket framing, deprecate endpoints, or rate-limit aggressively. | Medium | Medium | Pin SDK / endpoint to documented stable version in `provider-comparison.md`; mocked-WS tests are the unit gate; live demo verified manually in `PHASE-BROWSER-TEST.md`. Fail gracefully = drop back to MLX with toast. |
| R-3 | **Cost overrun under provider switch.** User toggles to Deepgram mid-meeting, leaves it on; meeting runs 8 h → unexpected $5+. | Medium | High | T-3.5 cost meter UI live-updates per-provider; T-2.7 cost guard catches threshold; T-3.8 default privacy mode = Local-first (MLX, $0). |
| R-4 | **Privacy mode bypass.** UX bug allows user to pick Cloud provider while still seeing Local-first badge. | Low | High | T-3.8 constraint matrix is the unit gate (mode → available-provider list is a pure function); UI binds disabled state directly to constraint output. |
| R-5 | **Telemetry leaks PII.** Provider switch event accidentally logs transcript chunk text or PCM bytes. | Low | High | T-3.9 unit test explicit-grep asserts forbidden keys (`text`, `transcript`, `pcm`, `audio`) absent from every log line; opt-in flag default OFF. |

---

## Outputs Per Task

Every task creates:

- `docs/tasks/phase-3/T-3.<N>-<slug>.md` — plan + ARCH ref + AC + TDD plan + risk + mitigation
- Code under `src/`, `crates/`, `src-tauri/`, or `shared/` per Phase 1/2 layout
- Tests alongside the code (Vitest / `cargo test`)
- `docs/tasks/phase-3/T-3.<N>-review.md` — self-review (file changed, test count, metrics measured numerically, no Phase-1/2 regression, cost tracking on, no API key leak, no `git push`)

Final phase outputs:

- `docs/provider-comparison.md` — per-provider table (latency, cost, privacy, API maturity, setup steps)
- `docs/ARCHITECTURE.md` — Phase 3 addendum block (NOT a rewrite — append-only)
- `docs/tasks/phase-3/PHASE-BROWSER-TEST.md` — live-host re-verify procedure (boot → switch provider → 30-min stress → verify cost meter + privacy badge)
- `docs/tasks/phase-3/PHASE-3-COMPLETE.md` — sign-off with provider-comparison table, cost-meter snapshot, privacy-mode matrix

---

## Process Rules (loop-binding)

Per the loop driver instructions:

1. **Task file per task** — `docs/tasks/phase-3/T-3.<N>-*.md`. One spec doc + one review doc per task.
2. **TDD strict** — refactor must keep Phase 1/2 tests green; adapters need mocked-WS + golden response; reconnect needs chaos test; cost meter needs unit test; settings + UI need component tests; TTS feature-flag default OFF; privacy needs constraint test; telemetry needs rotation + no-PII test.
3. **Code review per task** — `T-3.<N>-review.md` with file-change + test-count + AC verdict.
4. **Per-task commit** — type `refactor` / `feat` / `test` / `docs`. **No `git push`.**
5. **Phase test + sign-off** — `bun test` + `cargo test` (no regression); 30-min stress test on ≥ 2 STT providers (manual verify); `PHASE-3-COMPLETE.md` + `PHASE-BROWSER-TEST.md`.

Every commit includes co-author footer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Sign-Off Trail

This INDEX is updated as each task completes — checkbox flips and the task's headline outcome (test count + AC verdict) appears next to the title. Final state must show all 10 boxes ticked before `PHASE-3-COMPLETE.md` is written.
