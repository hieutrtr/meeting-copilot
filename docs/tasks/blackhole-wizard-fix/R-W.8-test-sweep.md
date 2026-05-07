# R-W.8 — full test sweep + carry-forward fixes (Phase 3 runtime)

**Status:** ✅ ALL GREEN
**Date:** 2026-05-07
**Loop step:** 6/8

## Metrics

| Suite             | Passed | Failed | Notes                                  |
|-------------------|-------:|-------:|----------------------------------------|
| `cargo test --workspace` | **231** | 0 | exit code 0                            |
| └─ audio-capture          | 56     | 0      | T-W.5 verify FFI included              |
| └─ helper-daemon          | 87     | 0      | T-4.9 SSE iframe + Phase 3 daemon      |
| └─ meeting-copilot-lib (Tauri) | 16 | 0      | T-W.7 setup commands + Phase 1–4 IPC   |
| └─ stt-mlx                | 72     | 0      | T-3.* providers + backoff              |
| `bun run test` (vitest)   | **952** | 0     | ≥ 934 baseline ✅ (zero regression)    |

> Note on `bun test` vs `bun run test`: the loop prompt's `bun test` invokes
> Bun's native runner which doesn't honour the project's vitest config (no
> JSDOM env), producing spurious `document is not defined` errors. The
> authoritative run is `bun run test` → `vitest run` per `package.json`
> `scripts.test`.

## Commit hashes (R-W.2 … R-W.7)

| Task    | Commit    | Subject                                                                |
|---------|-----------|------------------------------------------------------------------------|
| R-W.1   | `a94f3b1` | docs(plan): R-W.1 blackhole-wizard-fix INDEX + dep graph              |
| R-W.2/3 | `0241167` | fix(rust): R-W.2 derive Debug + R-W.3 WavFileSource::next_chunk       |
| R-W.4   | `d3071f1` | feat(setup): T-W.5 verify capture FFI body + AudioInputProbe seam     |
| R-W.5/6 | `b2cbd96` | feat(ui): R-W.5+R-W.6 settingsStore.setupCompleted + Tauri setup cmds |
| R-W.7   | `4f235b6` | feat(ui): R-W.7 App.tsx wizard mount + onComplete persistence         |
| R-W.8   | _this_    | test(phase): R-W.8 cargo+vitest full sweep green (231+952)            |

## Carry-forward Phase 3 runtime fixes (folded into R-W.8)

R-W.2/R-W.3 unblocked compile but exposed six pre-existing runtime failures
authored in T-3.2/T-3.3/T-3.4/T-4.9 (commits `225fec0`, `8108a15`, `24e404e`,
`b728fdb`) that had been hidden by the Phase 3 compile breakage. Per the loop
rule "fix in same iter if trivial else escalate" all six were trivial and are
fixed inline.

### F1 — backoff timing precision (3 tests)

`crates/stt-mlx/src/providers/backoff.rs`

`Duration::mul_f32` produces sub-microsecond f32 quantisation noise on
otherwise-round inputs (`100ms × 2.0 = 200.000003ms`). Tests assert exact
equality against `Duration::from_millis(_)` literals — and `thread::sleep`
cannot honour sub-millisecond precision in any case.

**Fix:** added private `round_to_ms` helper; `next_delay` and `jittered` now
collapse the `mul_f32` result to whole milliseconds. Behaviour change is
strictly sub-millisecond; `backoff_jittered_zero_jitter_is_identity` (which
short-circuits on `j == 0.0`) still returns the exact input unchanged.

Tests fixed:
- `backoff_next_delay_doubles_until_cap`
- `backoff_next_delay_normalizes_sub_one_multiplier`
- `backoff_jittered_stays_within_bounds`

### F2 — URL-error classification (2 tests)

`crates/stt-mlx/src/providers/deepgram.rs` + `elevenlabs.rs`

Both `connect()` impls mapped every `tungstenite::connect` failure to
`SttError::Io`, which `connect_with_backoff` then retried `max_retries` times.
Bad-URL typos like `"not-a-valid-url"` surface from tungstenite as
`Error::Url(UrlError::UnsupportedUrlScheme)` *after* `into_client_request`
succeeds (the request parser is lax; the connect-side validates) — those are
user-actionable, not transient.

**Fix:** match on `tungstenite::Error::Url(UrlError::*)` and route the typo
variants (`UnsupportedUrlScheme`, `NoHostName`, `EmptyHostName`,
`NoPathOrQuery`, `TlsFeatureNotEnabled`) to `SttError::Config`. Crucially,
`UrlError::UnableToConnect(_)` is a transient transport failure (DNS / refused
/ unreachable) and stays on the `Io` retry path so
`connect_returns_provider_unavailable_after_max_retries` (which uses port 1
to force ECONNREFUSED) still observes `ProviderUnavailable { attempts: 3 }`.

Tests fixed:
- `providers::deepgram::tests::connect_does_not_retry_on_config_error`
- `providers::elevenlabs::tests::connect_does_not_retry_on_config_error`

### F3 — SSE broadcast subscription order (1 test)

`crates/helper-daemon/src/embed_http.rs`

`sse_route_streams_events_in_submitted_order` sent three `EmbedEvent`s into
`tx` *before* issuing the GET request. `tokio::sync::broadcast` has no backlog
replay — subscribers only receive messages sent after they subscribe — so the
SSE handler (which subscribes inside the route) saw an empty stream and
`text.find("transcriptChunk")` panicked.

**Fix:** issue `app.oneshot(req).await` first (handler runs synchronously up
to the response, so the subscription is live by the time await returns), then
`tx.send(...)` the three events, then `deregister_channel` + `drop(tx)` to
close the stream.

Test fixed:
- `embed_http::tests::sse_route_streams_events_in_submitted_order`

## Verification

```
$ cargo test --workspace 2>&1 | grep 'test result:'
test result: ok. 56 passed; …  (audio-capture)
test result: ok. 87 passed; …  (helper-daemon)
test result: ok. 16 passed; …  (meeting-copilot-lib / src-tauri)
test result: ok. 72 passed; …  (stt-mlx)
…
$ echo $?
0

$ bun run test 2>&1 | tail -5
 Test Files  62 passed (62)
      Tests  952 passed (952)
```

Exit gate #2 ("cargo + vitest both green") is satisfied. R-W.9 (PHASE-COMPLETE
verdict bump + re-tag v1.0.1) and R-W.10 (final review files) are unblocked.
