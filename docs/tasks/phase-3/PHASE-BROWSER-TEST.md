# Phase 3 — Browser / Live-Host Manual Test

> Companion to `PHASE-3-COMPLETE.md` (the sandbox-runnable sign-off). This file is the **wall-clock host re-verify** for the Phase 3 surfaces that need real hardware, real cloud APIs (`DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY`), real audio routing, and real wall-clock duration to validate.
>
> **Why a separate doc:** the loop sandbox lacks `cargo` + `tauri-cli` + Apple-Silicon hardware + reliable network to live cloud STT/TTS endpoints; the vitest+cargo-mocked unit tests close the per-task AC gates, the live numbers are a deferred verify per the Phase 1/2 sign-off pattern. Same shape as `phase-2/PHASE-BROWSER-TEST.md`.
>
> **Run cadence:** once at end-of-phase + after any Phase-3.x bug-fix that touches an STT/TTS adapter, the privacy gate, the cost meter, the settings sheet, or the telemetry log writer. ~50 minutes wall-clock for the full pass (the 30-min stress in step 9 dominates). Steps 1–8 + 10 alone are ~20 minutes.
>
> Phase 3 exit criteria pinned by `INDEX.md` and `IMPLEMENTATION-PLAN.md` Phase 3:
>
> - Switch provider runtime without restart.
> - ≥ 2 STT providers stable in a 30-minute stress test.
> - Privacy mode constrains provider list (UI + backend gate).
> - Cost meter accurate per-provider rate (MLX = $0, Deepgram = $0.0043/min, ElevenLabs ≈ $0.40/h).
> - TTS feature flag default OFF; flag-on audio plays < 2 s.
> - Telemetry opt-in default OFF; log rotates at 10 MB; never contains transcript or audio bytes.

---

## Prerequisites

- All Phase 2 prereqs (BlackHole 2-channel + Aggregate Device, `ANTHROPIC_API_KEY`, `cargo` + `rustup` + Tauri 2 CLI, microphone permission for Tauri / claude-bridge in System Settings → Privacy → Microphone).
- `DEEPGRAM_API_KEY` exported in shell (`echo $DEEPGRAM_API_KEY | head -c 4` → non-empty). Sign up at <https://deepgram.com> and grab a Nova-2 key. Free tier $200 credit covers this test plan ~50× over.
- `ELEVENLABS_API_KEY` exported in shell. Sign up at <https://elevenlabs.io>; the Scribe streaming endpoint requires a paid plan tier — confirm the key has Scribe access before starting (free-tier keys will fail step 2c with a typed 403, which is not a test bug).
- For step 8 only: build the Tauri app with TTS turned on. From the repo root:

  ```sh
  VITE_ENABLE_TTS=true bun tauri dev
  # AND in a separate shell, ensure the Rust workspace was compiled with:
  #   cargo build -p stt-mlx --features tts
  ```

  For all other steps, the default `bun tauri dev` (TTS feature flag OFF) is correct — the Speak button must NOT appear in steps 1–7, 9–10.
- A 5–10 minute test conversation script ready (re-use the Phase 2 script: 3 clear questions interleaved with 5–10 s silence). For step 9, 30 minutes of source material is needed — a podcast or recorded meeting played through the system input via BlackHole is the easiest way; alternatively a reading partner.
- Stopwatch on phone or wristwatch for the wall-clock budgets in steps 6, 8, and 9.
- `~/Library/Application Support/com.meeting-copilot.app/` (or whatever the Tauri identifier resolves to on this host) accessible in Finder for step 7's log-file inspect. If telemetry is wired to a different on-disk location for this build, substitute the actual path documented in `docs/ARCHITECTURE.md` §14.

## Layout

Each step has:

- **Action** — what to do.
- **Expected** — what you should see (UI, log, file).
- **Pass criterion** — the bool gate.

Mark each step `[ ] PASS` / `[ ] FAIL` as you go. A FAIL on any step blocks the live re-verify; file a Phase-3.x ticket with the failing step + screenshot + the affected `T-3.<N>` reference.

---

## Steps

### Step 1 — Boot + Phase 1/2 carry-forward sanity

- **Action:** `bun tauri dev` from the repo root (default features — TTS OFF). Wait for the Tauri window to open. Repeat the Phase-2 boot sanity: load a context file, confirm the **Past meetings** section renders without errors. Open the Settings sheet (collapsed `<details>` near the top of the app — click to expand).
- **Expected:** "Meeting Copilot" header renders, no console errors in Tauri devtools (Cmd-Opt-I). Settings sheet shows: **Privacy mode** picker (default = `Local-first`), **STT provider** picker (default = `MLX`), per-provider API key field (default empty for Deepgram + ElevenLabs since they're not yet relevant in Local-first mode), **Test connection** button (disabled / greyed when picker is on MLX), **Telemetry** checkbox (default unchecked). NO Speak button on the AnswerPanel for any answer card.
- **Pass criterion:** all four Phase-3 surfaces render in the sheet AND the Speak button is absent on default features (T-3.7 R-3.7-2 gate).

### Step 2 — Provider switch + API key vault + test connection round-trip (T-3.6)

This step has three sub-steps because three things have to be exercised and order matters.

#### 2a — MLX → Deepgram

- **Action:** Settings sheet → Privacy mode picker → set to **Cloud**. The red **Cloud consent banner** must appear above the transcript view (T-3.8 surface). Now the STT provider picker → set to **Deepgram**. The API key field below the picker must show the slot for Deepgram (empty unless you've used it before). Type the value from `$DEEPGRAM_API_KEY` into the field. Click **Test connection**.
- **Expected:** Within 3 seconds, the status pill flips from `idle → pending → success` with a message referencing `Deepgram` (NOT containing the API key value itself). If the key is wrong, the pill shows `fail` with the env-var name (`DEEPGRAM_API_KEY`) referenced in the failure message — no key value echoed. The store updates (`useSettingsStore.getState().sttProvider === "deepgram"`); switching the picker to ElevenLabs and back to Deepgram preserves the typed key.
- **Pass criterion:** pill goes `success` (or `fail` with a typed env-var-only message) within **3 000 ms wall-clock**; the API key value never appears in the rendered status pill, devtools console, or network panel except as the `Authorization` / `xi-api-key` request header. The cloud consent banner is visible above the transcript.

#### 2b — Deepgram → ElevenLabs (live runtime switch, no restart)

- **Action:** With a meeting NOT yet started, switch the STT provider picker from Deepgram to **ElevenLabs** in the same window (no restart). Type the value from `$ELEVENLABS_API_KEY` into the (now-displayed) ElevenLabs key slot. Click **Test connection**.
- **Expected:** Pill flips `idle → pending → success` within 3 seconds. Switching from Deepgram → ElevenLabs in the picker swaps the displayed API key field — the Deepgram key remains stored (verify by switching back — the value reappears in the field) but the ElevenLabs slot starts empty (or shows a previously-saved key if one exists).
- **Pass criterion:** ElevenLabs test connection succeeds within **3 000 ms wall-clock**; per-provider key isolation (T-3.6 SH-U4 gate) holds — switching the picker swaps the key slot, neither value bleeds into the other.

#### 2c — Provider runtime switch DURING an active meeting

- **Action:** Click **Start meeting**. Speak 1–2 sentences while Deepgram is the active provider — observe transcript chunks render (Deepgram model badge / source visible if your build surfaces it; otherwise check the helper-daemon stderr for `provider=deepgram`). WITHOUT stopping the meeting, switch the picker to ElevenLabs. Continue speaking.
- **Expected:** Transcript stream continues; new chunks come from ElevenLabs (helper-daemon stderr should now show `provider=elevenlabs` or equivalent). No transcript drop / error toast. Phase 3 exit criterion: switch provider runtime without restart.
- **Pass criterion:** transcript chunks keep arriving from BOTH providers across the switch; total dropped chunks < 1 second of audio (acceptable swap-over gap). If chunks stop entirely after the switch, that's a Phase-3.x bug (likely T-3.1 factory or T-3.4 adapter handshake).
- **Note:** If you notice `(503) Provider Unavailable` mid-stream from Deepgram, that's the T-3.3 reconnect/chaos guard kicking in — give it < 10 s to retry; if it doesn't recover after 3 attempts (typed `ProviderUnavailable` error in the toast), that's a separate failure to log.

### Step 3 — API key entry without env-var fallback

- **Action:** In a fresh shell, **unset** one of the env vars: `unset DEEPGRAM_API_KEY`. Restart the Tauri app: `bun tauri dev`. In Settings sheet, switch privacy mode to **Cloud**, STT provider to **Deepgram**. Leave the API key field EMPTY. Click **Test connection**.
- **Expected:** The pill flips to `fail` within 3 seconds with a message referencing `DEEPGRAM_API_KEY` (env-var name only — no fabricated key value). Now type a valid key into the field; click **Test connection** again. Pill flips `success`. Re-export the env var in a new shell after the test (`export DEEPGRAM_API_KEY=...`).
- **Pass criterion:** missing-key path returns a typed error referencing the env-var name (T-3.6 + T-3.4 EL-S1b parity); user can recover by typing the key into the UI and re-testing.

### Step 4 — Privacy mode Local-first enforce (T-3.8)

- **Action:** Settings sheet → Privacy mode → set to **Local-first** (the default for new users). Open the STT provider picker.
- **Expected:** The provider picker shows MLX as the only enabled option. Deepgram + ElevenLabs are present in the dropdown but `disabled` with a tooltip — hover each and verify the tooltip wording references the `Local-first` mode (e.g. `"Disabled in Local-first mode — audio never leaves the machine"`). The cloud consent banner is NOT visible. The store auto-reverts: if the picker was on Deepgram before flipping to Local-first, after the flip the picker snaps to MLX in the same setter call. Verify by scripting it — flip picker to Deepgram first under Cloud mode, then flip Privacy mode → Local-first, confirm the picker resets to MLX without a manual user click.
- **Pass criterion:** Deepgram + ElevenLabs are `disabled` with a non-empty tooltip; auto-revert fires; the cloud consent banner is hidden; Speak button (T-3.7) is also hidden even if `VITE_ENABLE_TTS=true` (Local-first disables TTS per T-3.8 tightening — see `App.tsx` `isTtsAllowed(privacyMode)` gate).

### Step 5 — Privacy mode Cloud unlocks all (T-3.8 + backend constraint)

- **Action:** Settings sheet → Privacy mode → **Cloud**. Verify the picker now allows all three STT providers (MLX, Deepgram, ElevenLabs). The red Cloud consent banner appears above the transcript view (verbatim wording from ARCH §11). Pick **Deepgram**, ensure the API key is filled in (from steps 2/3). Start a meeting; speak briefly; stop.
- **Expected:** Deepgram is the active STT throughout. Cloud consent banner has `role="alert"` (verify via devtools accessibility tree). Now flip to Privacy mode → **Mixed**. The picker shows MLX + (Mixed-mode rule per ARCH §11) — verify by hovering the disabled options that the tooltip cites Mixed mode wording. Backend gate test: with Privacy mode = Local-first AND a valid Deepgram key, attempt to construct a Deepgram adapter via the Tauri command surface (or via the dev helper if exposed). The Rust `factory_with_privacy` MUST short-circuit with `PrivacyModeViolation` — proven by the cargo test `factory_with_privacy_short_circuits_before_construction_deepgram`. In the live UI, the picker disable + auto-revert prevent this, but the backend gate is the defense-in-depth.
- **Pass criterion:** Cloud unlocks all three providers (UI); Mixed allows MLX-only STT (UI); the consent banner has `role="alert"` and matches the ARCH §11 wording; backend `factory_with_privacy` rejects disallowed combos (cargo test gate — already green in T-3.8 sign-off, no live re-verify needed beyond `cargo test --workspace` on host).

### Step 6 — Cost meter accuracy on a 5-min sample (T-3.5)

- **Action:** Privacy mode = **Cloud**. STT provider = **Deepgram**. Start a meeting and let it run **5 minutes** of continuous transcription (read aloud, play a podcast through BlackHole, etc.). Observe the cost-meter UI (the session-cumulative cost + projected $/h indicator surfaced in the AnswerPanel or status bar — check `T-3.5-review.md` for the exact mount point). Stop the meeting. Note the displayed cumulative cost.
- **Expected:** For Deepgram at `$0.0043/min`, the 5-minute cumulative should land in the band `[$0.020, $0.024]` (5 × $0.0043 = $0.0215, ± ~10 % for handshake / silence / chunk batching). Repeat with STT provider = **ElevenLabs** for another 5 minutes — at ~$0.40/h, expect cumulative `[$0.030, $0.038]` (~$0.0333 baseline). Repeat again with **MLX** — cumulative MUST stay at exactly `$0.000` (MLX is free; rate constant pinned in `src/llm/sttPricing.ts`). The cost meter must update live (not only on stop) — verify by watching the indicator tick during the run.
- **Pass criterion:** Deepgram 5-min cost in `[$0.020, $0.024]`; ElevenLabs 5-min cost in `[$0.030, $0.038]`; MLX cost = `$0.000`; meter updates live (at least once per 30 seconds).
- **Note:** If the Phase-2 cost guard banner fires during this step (e.g. you've combined STT cost + Sonnet/Haiku cost past the $0.50/h default threshold), that's the T-2.7 surface working correctly — STT cost is wired into the same ledger via T-3.5. Bumping the threshold to $5/h temporarily is acceptable for this step; reset before exiting.

### Step 7 — Telemetry opt-in + log file inspect (T-3.9)

- **Action:** Default state: telemetry checkbox in Settings sheet is **unchecked**. Verify NO telemetry log file exists (or, if a log path was created on a prior run, that the file is empty / unchanged in mtime). Now check the **Telemetry** checkbox. Run a meeting for 2–3 minutes, switch providers MLX → Deepgram once mid-meeting (this fires a `provider_switch` event), trigger an artificial error if your build has a fault-injection hook (otherwise rely on natural latency events). Stop the meeting. Open the telemetry log file in Finder / `less` / `cat`.
- **Expected:** With telemetry OFF, no events written to disk (the noop sink is in use per T-3.9 `createNoopSink`). With telemetry ON, the log file contains JSON-line events for `provider_switch`, `latency_sample`, possibly `provider_error`; each line carries a timestamp. Crucially: **NO line contains** `text`, `transcript`, `pcm`, `audio`, or any visible English/Vietnamese content from the meeting transcript. Run `grep -E '"(text|transcript|pcm|audio)"' <logfile>` — must return **0 matches**. API keys must also be absent: `grep -E 'sk-|DEEPGRAM_API_KEY=|ELEVENLABS_API_KEY=' <logfile>` returns **0 matches**. File rotation is harder to manually exercise (10 MB takes hours of normal events) — the synthetic 10 MB rotation gate is a unit test (`telemetryLog.test.ts` TM-S20); for the live re-verify, it's enough to confirm the file format is line-delimited JSON and not a runaway append.
- **Pass criterion:** OFF → no file growth; ON → JSON-line events present; the four forbidden keys (`text` / `transcript` / `pcm` / `audio`) and any API key substring are absent from every line; uncheck telemetry and confirm new events stop appending (existing file content is preserved — opt-out does not delete prior consented logs).

### Step 8 — TTS feature flag ON → Speak answer (T-3.7)

- **Action:** Quit the default-features Tauri app from earlier steps. Rebuild + run with TTS ENABLED:

  ```sh
  cargo build -p stt-mlx --features tts
  VITE_ENABLE_TTS=true bun tauri dev
  ```

  Privacy mode must allow TTS (Cloud or Mixed — Local-first hides the Speak button per T-3.8 tightening). Start a meeting, ask one question, wait for the Sonnet answer to stream in. Click the **Speak answer** button on the answer card.
- **Expected:** Within **2 000 ms wall-clock** the button label flips to `Speaking…` and audio begins playing through the system output. After the audio finishes, the label changes to `Speak again` (T-3.7 AP-S15..S16 surface). A second click during `Speaking…` is a no-op (debounce). If the ElevenLabs key is invalid or quota is exhausted, the label flips to `Speak failed — retry` without echoing the API key or any error body into the UI. Verify on the default features build (after this step) that the Speak button is GONE — feature flag default OFF must dead-strip the surface.
- **Pass criterion:** click → `Speaking…` within 2 000 ms; audio audible; debounce holds; default-features build (no `VITE_ENABLE_TTS`, no `--features tts`) hides the button entirely.
- **Note:** If audio output routes to BlackHole because BlackHole is set as the default output for the Tauri webview, the audio will be inaudible. Either change system output to your speakers/headphones for this step, or pipe BlackHole's loopback to a monitorable destination via the Aggregate Device.

### Step 9 — 30-minute stress on ≥ 2 STT providers (Phase 3 exit criterion)

This is the Phase-3 exit gate per `INDEX.md` line 18. Two acceptable run shapes — pick one based on your test environment.

#### 9a — Sequential 15 + 15

- **Action:** Privacy mode = **Cloud**. Start a meeting. Stream 15 minutes of source audio (podcast through BlackHole or live talk) while STT provider = **Deepgram**. After 15 minutes (verify with stopwatch), switch the STT picker to **ElevenLabs** (live, no restart — same flow as step 2c). Stream another 15 minutes. Stop the meeting.
- **Expected:** Both 15-minute halves complete without:
  1. A reconnect storm (T-3.3 backoff is bounded; isolated reconnects within < 10 s are acceptable per the AC).
  2. Cost-meter divergence beyond 10 % from the per-rate expected.
  3. Transcript chunks missing for > 5 seconds at the provider switch.
  4. Memory growth in the helper-daemon process beyond +50 MB across 30 minutes (rough sanity — Activity Monitor on the helper PID).
  5. Any forbidden key (`text`/`transcript`/`pcm`/`audio`) in the telemetry log if telemetry is ON.
- **Pass criterion:** meeting completes; final cost ≈ $0.108 ± 10 % ($0.0215 Deepgram half + $0.0833 ElevenLabs half); past-meetings list shows the 30-minute meeting after stop; helper-daemon RSS grows < 50 MB.

#### 9b — Concurrent A/B (advanced — optional)

- **Action:** Run two Tauri instances on the same host, one with STT = MLX (privacy = Local-first), one with STT = Deepgram (privacy = Cloud). Same source audio routed to both via BlackHole. Run for 30 minutes. This isolates per-instance state and is the strongest stress test, but is heavier on the host.
- **Expected:** Both instances stay healthy for the full 30 minutes; no shared-state bugs (each instance has its own helper-daemon — independent settings store, independent cost ledger).
- **Pass criterion:** both instances complete the 30 minutes without crash or transcript stall; comparing transcript length should land within ~10 % (MLX vs Deepgram have different chunking cadences, but total content should be comparable).

### Step 10 — Restart → settings + privacy + telemetry persist

- **Action:** Quit the app (Cmd-Q). Restart with `bun tauri dev`. Open Settings sheet without changing anything else.
- **Expected:** Privacy mode is the value you left it at (likely `Cloud` from step 9 — verify against your last setting). STT provider is the last-active value. The Deepgram + ElevenLabs API key fields show the keys you typed (NOT empty — they were persisted to `localStorage` under `meeting-copilot:settings:v2`). Telemetry checkbox state matches the last setting. The cloud consent banner displays IFF privacy mode is Cloud. Open devtools → Application → Local Storage and verify the key `meeting-copilot:settings:v2` exists with a JSON payload containing `sttProvider`, `apiKeys`, `privacyMode`, `telemetryEnabled`; the legacy `meeting-copilot:settings:v1` key may also be present (T-3.6 leaves it in place for downgrade rollback). Reset to defaults: privacy mode = Local-first, telemetry = unchecked, API key fields cleared (or leave keys; clearing is optional — the env-var fallback covers it for next session).
- **Pass criterion:** every Phase-3 setting field round-trips byte-identically through restart; the v2 storage key is present; v1 key (if it exists) is left intact; the past-meetings list still shows the meeting from step 9.

---

## Live Metric Tally

After step 10, fill in the live numbers and compare to the unit-test ground-truth:

| Metric | Sandbox value | Live value | Note |
|---|---:|---:|---|
| Deepgram 5-min cost (step 6) | $0.0215 (table) | $______ | T-3.5 AC ± 10 % |
| ElevenLabs 5-min cost (step 6) | $0.0333 (table) | $______ | T-3.5 AC ± 10 % |
| MLX 5-min cost (step 6) | $0.0000 (table) | $______ | Must be exactly 0 |
| Test connection latency Deepgram (step 2a) | n/a (mocked) | ____ ms | T-3.6 AC < 3 000 ms |
| Test connection latency ElevenLabs (step 2b) | n/a (mocked) | ____ ms | T-3.6 AC < 3 000 ms |
| Speak click → audio start (step 8) | n/a (mocked) | ____ ms | T-3.7 AC < 2 000 ms |
| 30-min stress completion (step 9) | n/a | PASS / FAIL | Phase 3 exit criterion |
| Telemetry log forbidden-key grep (step 7) | 0 (unit test) | __ matches | Must be 0 |
| Cost-guard fire count (steps 6 + 9) | 0 default | __ | Should be 0 unless threshold lowered |

A live miss on **test connection latency** or **Speak click latency** is a Phase-3.x ticket (file under `docs/tasks/phase-3.x/`). A miss on the **30-minute stress** is a Phase-3 blocker. A miss on the **forbidden-key grep** is an immediate stop-the-line privacy bug.

## Notes

- The mocked-WebSocket cargo tests (T-3.2, T-3.3, T-3.4) and the prop-injected fetch vitest tests (T-3.6, T-3.7) are the per-task AC gates. This live re-verify is the **integration** check across the surfaces — it does not replace the unit gates, it complements them.
- If `transcript:chunk` events do not arrive in step 2c after a provider switch, the most likely cause is a stale handle in the helper-daemon's provider factory — restart the app (acceptable for diagnosis but a Phase-3.x bug, since the AC requires no-restart switch).
- The 30-minute stress in step 9 is the most expensive cell of the test plan. A sample run is sufficient at sign-off; per-bugfix re-runs can scope to a 10-min variant unless the fix touches the reconnect path, the factory, or the cost meter.
- Reset privacy mode to **Local-first** + uncheck telemetry before exiting to leave the host in the privacy-default state for the next session.
- Cross-references for failure triage:
  - Provider switch hangs → `T-3.1-review.md` (factory) + `T-3.3-review.md` (reconnect).
  - Cost meter wrong → `T-3.5-review.md` + `src/llm/sttPricing.ts` constants.
  - Privacy banner missing or wrong wording → `T-3.8-review.md` + `src/components/CloudConsentBanner.tsx`.
  - Telemetry log contains transcript content → `T-3.9-review.md` + `src/telemetry/scrub.ts` `FORBIDDEN_KEYS`. **STOP THE LINE** — privacy regression.
  - Speak button visible on default build → `T-3.7-review.md` AP-S13/S13b + `src/App.tsx` `ENABLE_TTS` gate.
