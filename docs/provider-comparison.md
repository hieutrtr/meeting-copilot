# Provider Comparison — Meeting Copilot Phase 3

> Per-provider reference for STT (Speech-to-Text) and TTS (Text-to-Speech) pluggable providers shipped in Phase 3 (T-3.1 … T-3.9).
> Cross-references: `docs/ARCHITECTURE.md` §3 / §4 / §11 / §13 / §14 / §15 (Phase 3 update blocks), `docs/IMPLEMENTATION-PLAN.md` §"Phase 3 — Pluggable Providers", `docs/tasks/phase-3/INDEX.md`.

---

## What this doc is

A side-by-side comparison of the STT and TTS providers Meeting Copilot supports, the privacy / cost / latency posture of each, and the runtime + setup mechanics for picking one. It targets:

- **Contributors** evaluating "which provider should I default to for this hardware / network?".
- **Security reviewers** auditing "what data leaves the machine in each mode?".
- **End-users** reading the Settings sheet help text and wondering what the picker actually does.

## What this doc is not

A tutorial. For end-to-end setup steps (installing BlackHole, granting permissions, signing up for API keys), see the README and `docs/PHASE-BROWSER-TEST.md` (live host re-verify procedure, owned by the Phase 3 sign-off step).

A pricing oracle. The numeric source of truth is `src/llm/sttPricing.ts` (`STT_PROVIDER_RATES`, pinned to ARCH §3.2 lines 113 + 119). This doc reflects the values at the time of the Phase 3 sign-off; if it drifts from the constant, **the code wins**.

---

## STT Provider Comparison

| Provider | Latency (partial / final) | Cost | Privacy posture | Languages | Streaming | API maturity | Auth | Default? |
|---|---|---|---|---|---|---|---|---|
| **MLX local** (`mlx-whisper`) | ~300–500 ms / ~800 ms (M2) | $0 | 100 % local — audio never leaves the machine | 99 (Whisper-large-v3-turbo coverage) | Chunked + Silero VAD | Stable (built on Whisper) | None | ✅ yes (Local-first mode) |
| **Deepgram** (`nova-2`) | ~150 ms / ~250 ms | $0.0043 / minute (≈ $0.258/h) | Audio + transcript leave the machine | 36+ | WebSocket linear16 | Production-grade, public API | `DEEPGRAM_API_KEY` (header) | only when Cloud mode is picked |
| **ElevenLabs Scribe** | ~200 ms (single hypothesis) | ~$0.40 / hour | Audio + transcript leave the machine | 70+ | WebSocket | Newer (2025), pinned endpoint | `xi-api-key` header (`ELEVENLABS_API_KEY`) | only when Cloud mode is picked |

### Latency notes

- MLX measurements are from the Phase 1+2 sign-off (M2 Pro, 16 GB) running `whisper-large-v3-turbo`. Lower-end Apple Silicon (base M1 8 GB) drops accuracy gracefully via `whisper-small` — see ARCH risk register R-2.
- Deepgram + ElevenLabs latency is RTT-bound. The numbers in the table assume good network conditions (≤ 50 ms RTT to the provider's edge). Behind a captive portal or VPN the partial latency can balloon past 500 ms — the cost-meter will still bill correctly because the meter is timestamp-driven, not RTT-driven.

### Cost notes

- Numbers come from `STT_PROVIDER_RATES` in `src/llm/sttPricing.ts`. The constant is pinned to ARCH §3.2 lines 113 + 119; drift between the doc and the constant is gated by `src/llm/sttPricing.test.ts` ST-S1.
- Worked example for a 60-minute meeting:
  - MLX: $0.00.
  - Deepgram: 60 × $0.0043 = $0.258.
  - ElevenLabs Scribe: $0.40 (flat).
- The cost meter UI surfaces both **session-cumulative** and **projected $/h**; switching providers mid-meeting attributes cost correctly to each segment (see `src/cost/sttCostMeter.test.ts` SCM-S7 — the four-phase ladder).

### Privacy posture

- The 3-mode constraint matrix lives in `src/privacy/privacyMode.ts` (TS — single source of truth) and is mirrored in `crates/stt-mlx/src/providers/privacy.rs` (Rust — backend short-circuit). See the matrix below.
- MLX is the **only** STT provider allowed in Local-first mode. Deepgram is **only** allowed in Cloud mode. ElevenLabs Scribe is **only** allowed in Cloud mode (Scribe streams audio); ElevenLabs TTS, separately, is allowed in Cloud + Mixed.
- "Audio never leaves the machine" means: no PCM frames, no waveform — `<TranscriptView/>` text + `~90 s` recent-transcript window may still be POSTed to Anthropic for answer generation in any mode (ARCH §11 — that paragraph stays the canonical reference).

---

## TTS Provider Comparison

| Provider | Latency (first audio) | Cost | Privacy posture | Voice library | Audio format | Default? |
|---|---|---|---|---|---|---|
| **ElevenLabs** (`eleven_turbo_v2`) | < 400 ms target | $0.40 per ~10 answers (~50 words each) | Text leaves the machine | ElevenLabs voice catalog | PCM 16 kHz mono (`output_format=pcm_16000`) | ❌ feature-flag default OFF |

### TTS gating

TTS ships **behind two feature flags**:

1. **Rust:** cargo feature `tts` (default OFF) — `crates/stt-mlx/Cargo.toml`. The entire `crates/stt-mlx/src/tts/` module is `#[cfg(feature = "tts")]` and adds zero new deps. Default builds dead-strip the module.
2. **TS:** `VITE_ENABLE_TTS` env (default missing → false) read by `src/tts/featureFlag.ts`. The `<AnswerPanel/>` Speak button is rendered iff the `onSpeak` prop is passed; App.tsx passes the prop iff `ENABLE_TTS && isTtsAllowed(privacyMode)`. A dynamic `import()` keeps the TTS modules out of the default Vite bundle.

This double-gate means a default `bun run build` does not download or ship any TTS code. Enabling TTS is an explicit opt-in.

### Privacy gating

Even with TTS turned on, **Local-first mode does not allow TTS** (text would leave the machine to be voiced — text never leaves in Local-first). `isTtsAllowed("local-first") === false` in `src/privacy/privacyMode.ts`; the App-level gate enforces this in addition to the feature flag.

### Audio routing

V1 plays the streamed audio through the system's default output (speakers / headphones). BlackHole virtual-output routing (so Zoom/Meet picks up the synthesized voice as if it were the user's mic) is documented in ARCH §4 and remains a **v2 deliverable** — Phase 3 ships local-speaker output only.

---

## Per-provider notes

### MLX local

- **Module:** `crates/stt-mlx/src/providers/mlx.rs` (T-3.1 relocated this from `crates/stt-mlx/src/mlx.rs`; behavior byte-identical).
- **Engine:** `mlx-whisper` (Apple MLX framework, Apple Silicon only). `whisper.cpp` is the documented CPU/Metal fallback, not yet wired in Phase 3.
- **Model:** `whisper-large-v3-turbo` (~600M params, ~150 ms/chunk on M2). Hard-coded for Phase 3; `whisper-small` fallback is a Phase 3.x candidate per risk R-2.
- **Streaming:** 30 s sliding window with Silero VAD utterance segmentation.
- **Auth:** none.
- **Test coverage:** carry-forward from Phase 1+2 — `cargo test -p stt-mlx` exercises the original `MlxWhisperSubprocess` shape (now at `providers::mlx`). Phase 3 adds 8 factory tests gating the trait + factory wiring.
- **Known limitations:** Apple Silicon only. Intel Mac → must pick a cloud provider. Detection + auto-suggest is a Phase 3.x deliverable (the picker currently does not auto-grey MLX on Intel — the user is left to discover it; risk R-2).

### Deepgram

- **Module:** `crates/stt-mlx/src/providers/deepgram.rs` (T-3.2). Reconnect/backoff is `crates/stt-mlx/src/providers/backoff.rs` (T-3.3, reused by ElevenLabs in T-3.4).
- **Endpoint:** `wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&interim_results=true`. The endpoint string is the literal constant in the adapter — drift is gated by the unit tests in `providers::deepgram::tests`.
- **Framing:** raw `linear16` PCM frames pushed as binary WebSocket messages; interim + final JSON results parsed into `SttSegment`. See T-3.2-deepgram-adapter.md for the schema.
- **Auth:** `Authorization: Token <DEEPGRAM_API_KEY>` (HTTP-style header on the WebSocket handshake).
- **Env var:** `DEEPGRAM_API_KEY`.
- **Reconnect (T-3.3):** exponential backoff with jitter; max 3 retries within 10 s; `BackoffConfig` default schedule bounded ~750 ms worst-case (well under the 10 s AC). After 3 failures the adapter emits `SttError::ProviderUnavailable { attempts, last_error }` to the caller and the UI surfaces a typed error toast (recommend dropping back to MLX).
- **Test coverage:** 19 tests across `providers::deepgram::tests` (T-3.2 + T-3.3 combined). Mocked-WebSocket structural test asserts request frame schema + golden response → segments mapping; chaos test (`mock_ws_reconnects_after_mid_stream_drop`) covers the reconnect path.
- **Known limitations:** Phase 3 ships `tungstenite = 0.21` handshake + plain `ws://` — TLS adoption + a production-grade reconnect storm guard are Phase 3.x. Cargo re-verify on a host with `cargo` installed is the carry-forward AC (loop sandbox blocked-action #3).

### ElevenLabs Scribe (STT)

- **Module:** `crates/stt-mlx/src/providers/elevenlabs.rs` (T-3.4).
- **Endpoint:** `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream`.
- **Framing:** parallel to Deepgram — raw PCM frames over WebSocket; JSON result schema parsed in the same adapter shape.
- **Auth:** `xi-api-key: <ELEVENLABS_API_KEY>` (handshake header).
- **Env var:** `ELEVENLABS_API_KEY`.
- **Reconnect:** reuses `providers::backoff::BackoffConfig` (relocated from `providers::deepgram` in T-3.4 and back-compat re-exported).
- **Test coverage:** 15 tests in `providers::elevenlabs::tests` (3 ctor + 6 parser + 1 encoder + 3 mock-WS + 2 reconnect operational reuse) + 3 factory regressions.
- **Known limitations:** Newer endpoint than Deepgram (2025 GA). The endpoint string is pinned in the adapter; drift triggers the unit tests.

### ElevenLabs (TTS)

- **Module:** `crates/stt-mlx/src/tts/elevenlabs.rs` (Rust, T-3.7) + `src/tts/elevenLabsTts.ts` (TS, T-3.7).
- **Endpoint:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000`.
- **Auth:** `xi-api-key` header (same env var as Scribe; the same key works for both — there is one key per ElevenLabs account).
- **Default voice:** voice ID is constructor-supplied; UI surfaces a single "Speak answer" button per Q&A card without a voice picker (model knobs deferred to Phase 3.x per the spec scope-cap).
- **Test coverage:** 6 tests on the AnswerPanel button (AP-S13..S16b) + 13 TS adapter tests (`elevenLabsTts.test.ts`) + 14 Rust adapter tests (`tts::elevenlabs::tests`).
- **Known limitations:** `eleven_turbo_v2` deprecation drift is the highest-probability risk (R-3.7-5); the model ID lives at `ELEVENLABS_DEFAULT_MODEL_ID` in both TS + Rust and is gated by tests. The HTTP non-2xx error path does not echo body text into thrown errors (privacy audit, T-3.7-review §"Privacy audit").

### Future / out-of-scope

- **`whisper.cpp` CPU fallback.** Documented in ARCH §3.2 as the alternative to MLX on non-Apple-Silicon hardware. Phase 3 does not ship the wire-up; ARCH stays the canonical pointer.
- **Intel-Mac auto-detect → suggest Deepgram.** Risk R-2 mitigation; Phase 3.x candidate.
- **Provider model knobs** (Deepgram `tier`, ElevenLabs `voice_id` / `stability` / `similarity_boost`). Phase 3 ships provider-picker only — see T-3.6 spec §"Out of scope".
- **TTS voice library + preview.** Phase 3 ships a single hard-coded default voice path. v2.

### Selecting a provider — decision tree

```
Apple Silicon Mac, privacy-sensitive meeting (legal, medical, finance) ?
  → Local-first mode + MLX. Default. Audio never leaves the machine.

Captive-portal / VPN / no internet ?
  → Local-first mode + MLX. Cloud providers will fail handshake.

Need < 200 ms partial transcript (live captioning, presenter Q&A) ?
  → Cloud mode + Deepgram. Cheapest cloud option.

Multilingual meeting (≥ 4 languages) ?
  → Cloud mode + ElevenLabs Scribe (70+ languages, single endpoint).

Intel Mac ?
  → Cloud mode (MLX is Apple Silicon only; auto-detect TBD in Phase 3.x).
```

---

## Privacy posture matrix

Verbatim from ARCH §11 (Phase 1/2 wording preserved); cross-referenced to the runtime sources of truth.

| Mode | STT | LLM | TTS | Audio rời máy? |
|---|---|---|---|---|
| **Local-first** (default) | MLX local | Claude API (text only, prompt cached) | MLX local hoặc off | ❌ Audio không rời máy. Chỉ text question + recent transcript ≤ 90s gửi Claude. |
| **Cloud** | Deepgram | Claude API | ElevenLabs | ✅ Full audio stream gửi Deepgram. |
| **Mixed** | MLX local | Claude API | ElevenLabs | ❌ Audio local. Text + ElevenLabs cho TTS. |

Constraint enforcement:

- **TS (frontend):** `src/privacy/privacyMode.ts` — `availableSttProviders(mode)` is a pure function, used to compute the picker's `disabled` attribute + tooltip; tested in `privacyMode.test.ts` PM-S1..S23 (29 cases).
- **Rust (backend):** `crates/stt-mlx/src/providers/privacy.rs` — `factory_with_privacy(mode, kind, cfg)` short-circuits **before** construction with `FactoryError::PrivacyModeViolation`; tested in `providers::privacy::tests` (10 cases). UI bypass via dev tools cannot reach a disallowed provider.
- **Cloud-mode banner:** `<CloudConsentBanner/>` (red, `role="alert"`) mounts above `<TranscriptView/>` iff `privacyMode === "cloud"`; verbatim ARCH §11 wording. Local-first / Mixed render none.
- **TTS:** `isTtsAllowed(mode)` returns `false` for Local-first; the App-level gate combines this with the cargo + Vite feature flags (3 layers).

The "off the record" 30-s drop window described in ARCH §11 is a **v2 deliverable** — not in Phase 3 scope.

---

## Cost reference

Source of truth: `src/llm/sttPricing.ts`. Re-quoted here for convenience; if these numbers drift from the file, the file wins.

```
STT_PROVIDER_RATES = {
  mlx:        { kind: "free" }                      // $0
  fake:       { kind: "free" }                      // $0 — test stub
  deepgram:   { kind: "per-minute", rate: 0.0043 }  // $0.0043 / min
  elevenlabs: { kind: "per-hour",   rate: 0.40   }  // $0.40 / hour
}
```

Worked examples (60-minute meeting, default privacy = Local-first → would never invoke Deepgram/ElevenLabs; numbers below are for the Cloud mode the user opted into):

| Mode | STT cost | TTS cost (10 answers × ~50 words) | Question filter (Haiku) | Answer LLM (Sonnet, prompt-cached) | Total |
|---|---|---|---|---|---|
| **Local-first** | $0 | $0 (off) | ~$0.005 | ~$0.30 | **~$0.31 / h** |
| **Cloud** | $0.258 (Deepgram) or $0.40 (ElevenLabs) | $0.40 | ~$0.005 | ~$0.30 | **~$0.97 / h** |
| **Mixed** | $0 (MLX) | $0.40 | ~$0.005 | ~$0.30 | **~$0.71 / h** |

The cost-guard threshold (T-2.7, Phase 2 carry-forward) defaults to $0.50 / h soft warning, $5 hard cap per meeting. Phase 3 reuses the same threshold logic — no new cost guard.

---

## Setup steps (cloud providers)

### Deepgram

1. Sign up at https://deepgram.com (free tier includes credits enough for ≥ 30 hours of streaming on `nova-2`).
2. Create an API key in the dashboard.
3. Either set `DEEPGRAM_API_KEY` in your shell env *or* paste the key into Settings → "STT provider" → "Deepgram" → "API key" field. The store persists per-provider keys at `apiKeys.deepgram` in `localStorage` (`meeting-copilot:settings:v2`).
4. Click "Test connection" — the picker fires a 1-second silent PCM frame at the provider and asserts a 200 / valid handshake within 3 s. Success → green pill. Failure → red pill with a typed error message (env-var name only — never the key value).

### ElevenLabs (STT + TTS share one key)

1. Sign up at https://elevenlabs.io.
2. Create an API key in `Settings → API Keys`.
3. Same flow as Deepgram: env var `ELEVENLABS_API_KEY` or Settings paste. Persisted at `apiKeys.elevenlabs`.
4. "Test connection" works the same way. The same key is used for Scribe (STT) and Turbo (TTS).

### "Test connection" implementation seam

The Settings sheet uses a prop-injectable `TestConnectionFn` (`src/settings/testConnection.ts`). Phase 3 ships a deterministic stub (`defaultTestSttConnection`) that reads the env var + composed status messages — never the key value itself. The live Tauri-wired round-trip (call into the Rust adapter to verify a real WebSocket handshake) is **deferred to Phase 3.x** per the T-3.6 spec scope-cap; the seam is in place.

---

## API maturity caveats

| Provider | Endpoint pin | Drift mitigation |
|---|---|---|
| MLX | `whisper-large-v3-turbo` | Carry-forward Phase 1+2 cargo tests assert behavior on the existing model. |
| Deepgram | `nova-2` (URL constant in `providers::deepgram`) | Mocked-WS structural tests fail closed if the URL is rewritten. |
| ElevenLabs Scribe | `scribe-v1` (URL constant in `providers::elevenlabs`) | Mocked-WS structural tests + 3 factory regressions. |
| ElevenLabs TTS | `eleven_turbo_v2` model ID (`ELEVENLABS_DEFAULT_MODEL_ID` in TS + Rust) | Two parallel tests (TS + Rust) gate drift; a deprecation triggers both. |

If a provider deprecates an endpoint mid-flight, the failure mode is "the adapter throws, the UI surfaces the typed error, the user is asked to switch provider" — the cost meter is not billed for failed handshakes.

---

## References

### Internal

- `docs/ARCHITECTURE.md` §3 (STT — Pluggable Provider), §4 (TTS — Pluggable Provider), §11 (Privacy modes), §13 (Cost Model). Phase 3 update blocks at §3.4, §4.x, §11.x, §14, §15.
- `docs/IMPLEMENTATION-PLAN.md` §"Phase 3 — Pluggable Providers" (T-3.1 … T-3.10 spec table).
- `docs/PRD.md` §3.5 (UI wireframe — relevant for the picker layout).
- `docs/tasks/phase-3/INDEX.md` — task plan + dependency graph.
- Per-task review docs:
  - `docs/tasks/phase-3/T-3.1-review.md` (trait + factory)
  - `docs/tasks/phase-3/T-3.2-review.md` (Deepgram adapter)
  - `docs/tasks/phase-3/T-3.3-review.md` (reconnect / chaos)
  - `docs/tasks/phase-3/T-3.4-review.md` (ElevenLabs Scribe)
  - `docs/tasks/phase-3/T-3.5-review.md` (cost meter)
  - `docs/tasks/phase-3/T-3.6-review.md` (Settings UI)
  - `docs/tasks/phase-3/T-3.7-review.md` (TTS feature flag)
  - `docs/tasks/phase-3/T-3.8-review.md` (privacy mode picker)
  - `docs/tasks/phase-3/T-3.9-review.md` (telemetry)

### Implementation files (canonical sources of truth)

- **Provider trait + factory:** `crates/stt-mlx/src/providers/mod.rs`.
- **MLX:** `crates/stt-mlx/src/providers/mlx.rs`.
- **Deepgram:** `crates/stt-mlx/src/providers/deepgram.rs`.
- **ElevenLabs Scribe:** `crates/stt-mlx/src/providers/elevenlabs.rs`.
- **Backoff (shared):** `crates/stt-mlx/src/providers/backoff.rs`.
- **Privacy (Rust):** `crates/stt-mlx/src/providers/privacy.rs`.
- **Privacy (TS):** `src/privacy/privacyMode.ts`.
- **TTS (Rust, feature-gated):** `crates/stt-mlx/src/tts/elevenlabs.rs`.
- **TTS (TS):** `src/tts/elevenLabsTts.ts`.
- **Feature flag (TS):** `src/tts/featureFlag.ts`.
- **Cost meter:** `src/cost/sttCostMeter.ts` + `src/cost/attachSttCostMeter.ts`.
- **Pricing constants:** `src/llm/sttPricing.ts`.
- **Settings store (v2 schema):** `src/store/settingsStore.ts`.
- **Settings UI:** `src/components/SettingsSheet.tsx`.
- **Cloud consent banner:** `src/components/CloudConsentBanner.tsx`.
- **Telemetry:** `src/telemetry/scrub.ts` + `src/telemetry/sinks.ts` + `src/telemetry/telemetryLog.ts`.

### Upstream (third-party docs)

- Deepgram WebSocket API: https://developers.deepgram.com/reference/streaming
- ElevenLabs Speech-to-Text (Scribe): https://elevenlabs.io/docs/api-reference/speech-to-text
- ElevenLabs Text-to-Speech: https://elevenlabs.io/docs/api-reference/text-to-speech
- Apple MLX framework: https://github.com/ml-explore/mlx
- Whisper-large-v3-turbo: https://huggingface.co/openai/whisper-large-v3-turbo
