// ElevenLabs Scribe streaming STT adapter — Phase 3 T-3.4.
//
// Streams 16 kHz linear16 PCM frames over a WebSocket to ElevenLabs's Scribe streaming
// endpoint (`/v1/speech-to-text/scribe-v1/stream` per ARCH §3.2 documented-at-runtime
// shape) and decodes JSON `transcription` envelopes into `SttSegment`s. Plugs into the
// `SttProvider` trait extracted by T-3.1 (`crate::provider::SttProvider`) — same surface
// helper-daemon (T-1.6) and the meeting state machine (T-1.9) already consume.
//
// ## Why this looks like Deepgram with two header letters changed
//
// Both Deepgram and ElevenLabs Scribe ship streaming-only WebSocket APIs that take
// linear16 PCM in and emit per-utterance JSON `is_final` envelopes out. The on-the-wire
// shapes differ in three places:
//
//   1. **Auth header**: Deepgram = `Authorization: Token <key>`; ElevenLabs = `xi-api-key:
//      <key>` (the standard header for every other ElevenLabs API). The mock-WS test
//      (`mock_ws_handshake_carries_xi_api_key_header`) is the contract under test.
//   2. **Envelope shape**: Deepgram = `{type: "Results", channel.alternatives[].transcript}`;
//      ElevenLabs = `{type: "transcription", transcript, is_final, start_time, end_time}`.
//      `parse_transcription` is the Scribe-side parser (analogue of Deepgram's
//      `parse_results`).
//   3. **Endpoint defaults**: Deepgram bakes most params into the URL query
//      (`encoding=linear16&sample_rate=16000`); Scribe streaming exposes the same as
//      query params (`sample_rate=16000` + optional `language_code=en`). Defaults match
//      ARCH §3.2 cost row ("~$0.40/hour"); UI overrides via T-3.6 settings picker.
//
// Everything else — bounded reconnect policy, mid-stream drop semantics, lazy connect on
// first chunk, session-base timestamp anchoring, send-side socket-drop on I/O failure —
// is identical to the Deepgram adapter (T-3.2 + T-3.3). The shared
// `crate::providers::backoff::BackoffConfig` is the reuse seam; tests in this module
// stay scoped to the ElevenLabs-specific contract (header name, envelope parsing,
// per-adapter behavior) rather than re-covering the schedule math.
//
// ## TLS / production
//
// T-3.4 ships **plain WebSocket only** (`tungstenite` with `default-features = false,
// features = ["handshake"]` — same flag set as the Deepgram adapter). Production
// `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream` requires TLS; the rustls
// feature flag lands in T-3.6 (settings test-connection button) where both cloud
// adapters get wired together — keeps the no-TLS surface symmetric for now.
// `ElevenLabsConfig::default().url` still names the production `wss://` URL so
// configuration doesn't quietly point at the wrong endpoint; production-mode connect
// surfaces a typed `SttError::Io` from tungstenite's TLS-unsupported error so the
// failure mode is loud, not silent.
//
// ## Documented-at-runtime caveat
//
// The ElevenLabs streaming Scribe API is newer (2025) than the Deepgram one and may
// continue to iterate. The adapter pins the *shape* it expects — see the field
// definitions on `EsEnvelope` and the "envelope shape" notes above — so when the live
// API drifts, this file is the single point that needs updating. The mock-WS golden
// fixtures live alongside and document the expected on-the-wire JSON for the version
// targeted by T-3.4 (`provider-comparison.md`, T-3.10, will reference this file as the
// canonical record).

use std::env;
use std::net::TcpStream;
use std::time::Duration;

use audio_capture::PcmChunk;
use serde::Deserialize;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::provider::{SttError, SttProvider, SttSegment};
use crate::providers::backoff::{clock_jitter_sample, BackoffConfig};

/// Configuration for the ElevenLabs Scribe streaming adapter.
///
/// `api_key` — when `None` or empty, `ElevenLabsAdapter::new()` returns
/// `SttError::Config("ELEVENLABS_API_KEY missing or empty")`. `Default::default()`
/// reads the `ELEVENLABS_API_KEY` env var (matches the convention from the Phase 3
/// INDEX risk register: missing keys MUST fail gracefully — provider greys out in
/// picker with tooltip).
///
/// `url` — full WebSocket URL including query parameters. Default points at production
/// `wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream?sample_rate=16000`;
/// tests override with `ws://127.0.0.1:PORT/...`.
///
/// `read_drain_timeout` — how long to wait on the socket per drain iteration before
/// giving up and returning what we've collected. 50 ms matches the Deepgram default —
/// localhost RTT is sub-ms; on production paths a slightly longer drain absorbs Scribe's
/// per-utterance batching without stalling real-time chunks.
///
/// `backoff` — bounded reconnect policy (shared shape with Deepgram via
/// `crate::providers::backoff::BackoffConfig`). Defaults keep the worst-case wall-clock
/// under the 10 s AC budget.
#[derive(Debug, Clone)]
pub struct ElevenLabsConfig {
    pub api_key: Option<String>,
    pub url: String,
    pub read_drain_timeout: Duration,
    pub backoff: BackoffConfig,
}

impl Default for ElevenLabsConfig {
    fn default() -> Self {
        Self {
            api_key: env::var("ELEVENLABS_API_KEY").ok().filter(|s| !s.is_empty()),
            // ARCH §3.2 — ElevenLabs Scribe streaming. `sample_rate=16000` matches
            // the Chunker output (T-1.4); `model_id=scribe_v1` pins the Scribe v1
            // streaming model (the "mới, 2025" model called out in ARCH).
            url: "wss://api.elevenlabs.io/v1/speech-to-text/scribe-v1/stream?sample_rate=16000&model_id=scribe_v1"
                .into(),
            read_drain_timeout: Duration::from_millis(50),
            backoff: BackoffConfig::default(),
        }
    }
}

/// Concrete provider type alias. Without TLS features compiled in, the only `MaybeTlsStream`
/// variant `tungstenite::connect` can construct is `Plain(TcpStream)` — but the type itself
/// always has the same shape so callers don't need to special-case TLS-on vs TLS-off
/// (mirrors the Deepgram adapter's `Sock` alias).
type Sock = WebSocket<MaybeTlsStream<TcpStream>>;

/// `SttProvider` impl for ElevenLabs Scribe. Holds at most one live WebSocket. On any
/// read error, drops the socket so the next `transcribe_chunk` triggers a fresh
/// `connect_with_backoff`. Mirrors the Deepgram adapter's lazy-connect / drop-on-error
/// pattern — semantic shape carried over verbatim from T-3.2/T-3.3.
pub struct ElevenLabsAdapter {
    config: ElevenLabsConfig,
    socket: Option<Sock>,
    /// Set on the first chunk send. Used to offset Scribe's session-relative `start_time`
    /// field against the meeting timeline. Reset on every successful reconnect so segments
    /// arriving on a fresh socket re-anchor against the new chunk's `ts_ms` (Scribe's
    /// clock resets per-connection — same as Deepgram).
    session_base_ts_ms: Option<u64>,
}

// Manual `Debug` — `Sock` (`tungstenite::WebSocket<MaybeTlsStream<TcpStream>>`) is a
// foreign type without a `Debug` impl. Elide the live socket; report only its presence.
impl std::fmt::Debug for ElevenLabsAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ElevenLabsAdapter")
            .field("config", &self.config)
            .field("socket", &self.socket.as_ref().map(|_| "<connected>"))
            .field("session_base_ts_ms", &self.session_base_ts_ms)
            .finish()
    }
}

impl ElevenLabsAdapter {
    /// Construct an adapter. Validates the API key but does NOT connect — the socket
    /// is opened lazily on the first `transcribe_chunk` call. Matches the Deepgram
    /// adapter's construction contract so the meeting state machine (T-1.9) can build
    /// the provider in `idle` and only pay the network handshake when transitioning to
    /// `active`.
    pub fn new(config: ElevenLabsConfig) -> Result<Self, SttError> {
        match config.api_key.as_deref() {
            Some(s) if !s.is_empty() => {}
            _ => {
                return Err(SttError::Config(
                    "ELEVENLABS_API_KEY missing or empty".into(),
                ));
            }
        }
        Ok(Self {
            config,
            socket: None,
            session_base_ts_ms: None,
        })
    }

    fn connect(&self) -> Result<Sock, SttError> {
        // `new()` already validated `api_key` — this unwrap-via-Result is defensive.
        let api_key = self
            .config
            .api_key
            .as_deref()
            .ok_or_else(|| SttError::Config("ELEVENLABS_API_KEY missing".into()))?;

        let mut req = self
            .config
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| SttError::Config(format!("invalid url {}: {e}", self.config.url)))?;

        // ElevenLabs auth header is `xi-api-key: <key>` (the standard ElevenLabs
        // header) — distinct from Deepgram's `Authorization: Token <key>`. The header
        // value is the raw API key with no prefix.
        let value = HeaderValue::from_str(api_key)
            .map_err(|e| SttError::Config(format!("xi-api-key header value: {e}")))?;
        req.headers_mut().insert("xi-api-key", value);

        let (sock, _resp) = tungstenite::connect(req).map_err(|e| match &e {
            // Typo / shape errors (bad scheme, no host, …) surface from
            // tungstenite *after* `into_client_request` succeeds — the
            // request parser is lax and the connect-side validates. Route
            // those to `Config` so `connect_with_backoff` doesn't burn the
            // retry budget on a user-actionable typo. `UnableToConnect`
            // is a transient transport failure (DNS / refused / unreachable)
            // and stays on the `Io` retry path.
            tungstenite::Error::Url(url_err) => match url_err {
                tungstenite::error::UrlError::UnableToConnect(_) => {
                    SttError::Io(format!("ws connect: {e}"))
                }
                _ => SttError::Config(format!("invalid url {}: {e}", self.config.url)),
            },
            _ => SttError::Io(format!("ws connect: {e}")),
        })?;
        Ok(sock)
    }

    /// Bounded reconnect: try `connect()` up to `backoff.max_retries` times with
    /// exponential, jittered sleeps between attempts. Shape identical to the Deepgram
    /// adapter's `connect_with_backoff` (T-3.3). Returns:
    /// - `Ok(sock)` on first successful handshake (no sleep before attempt 1).
    /// - `Err(SttError::Config(_))` immediately on configuration errors (bad URL, bad
    ///   header value, missing key) — these are user-actionable, not transient, so
    ///   retrying would only delay the surfacing of a typo or stale config.
    /// - `Err(SttError::ProviderUnavailable { attempts, last_error })` after the
    ///   `max_retries` budget is exhausted on transient `Io` errors.
    ///
    /// Total wall-clock with default config is ~600 ms + jitter — well under the 10 s
    /// AC. Tests inject 0 ms initial / 0 jitter to assert the failure surface in
    /// microseconds.
    fn connect_with_backoff(&self) -> Result<Sock, SttError> {
        let max = self.config.backoff.max_retries.max(1);
        let mut delay = self.config.backoff.initial_delay;
        let mut last_error = String::from("(no attempt made)");

        for attempt in 1..=max {
            match self.connect() {
                Ok(sock) => return Ok(sock),
                // Config errors are not transient — surface immediately.
                Err(e @ SttError::Config(_)) => return Err(e),
                Err(e) => {
                    last_error = format!("{e}");
                    if attempt < max {
                        let jittered = self
                            .config
                            .backoff
                            .jittered(delay, clock_jitter_sample());
                        std::thread::sleep(jittered);
                        delay = self.config.backoff.next_delay(delay);
                    }
                }
            }
        }

        Err(SttError::ProviderUnavailable {
            attempts: max,
            last_error,
        })
    }
}

impl SttProvider for ElevenLabsAdapter {
    fn name(&self) -> &'static str {
        "elevenlabs"
    }

    fn transcribe_chunk(&mut self, chunk: &PcmChunk) -> Result<Vec<SttSegment>, SttError> {
        if self.socket.is_none() {
            // Lazy-connect on first chunk + on every reconnect after a drop. Matches
            // the Deepgram adapter — see comments there for the rationale.
            self.socket = Some(self.connect_with_backoff()?);
            self.session_base_ts_ms = Some(chunk.ts_ms);
        }
        let session_base = self.session_base_ts_ms.unwrap_or(chunk.ts_ms);

        let payload = encode_linear16(&chunk.samples);
        let drain_timeout = self.config.read_drain_timeout;

        let socket = self.socket.as_mut().expect("socket connected above");
        if let Err(e) = socket.send(Message::Binary(payload)) {
            // Send failed — drop the socket so the next chunk re-triggers backoff.
            // Same semantic as the Deepgram adapter; see T-3.3 review §"Mid-stream drop
            // semantics".
            self.socket = None;
            self.session_base_ts_ms = None;
            return Err(SttError::Io(format!("ws send: {e}")));
        }

        set_read_timeout(socket, Some(drain_timeout));

        let mut out = Vec::new();
        let mut closed = false;
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if let Some(seg) = parse_transcription(&text, session_base)? {
                        out.push(seg);
                    }
                }
                Ok(Message::Binary(_))
                | Ok(Message::Ping(_))
                | Ok(Message::Pong(_))
                | Ok(Message::Frame(_)) => continue,
                Ok(Message::Close(_)) => {
                    closed = true;
                    break;
                }
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    // No more frames buffered — done draining.
                    break;
                }
                Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => {
                    closed = true;
                    break;
                }
                Err(e) => {
                    // Drop the socket so the next call forces a fresh connect.
                    self.socket = None;
                    self.session_base_ts_ms = None;
                    return Err(SttError::Io(format!("ws read: {e}")));
                }
            }
        }

        if closed {
            self.socket = None;
            self.session_base_ts_ms = None;
        }
        Ok(out)
    }
}

/// Set the underlying TcpStream's read timeout so `WebSocket::read()` returns promptly when
/// no frame is buffered. T-3.4 ships plain-TCP only (matches T-3.2/T-3.3 — TLS deferred
/// to T-3.6); the catch-all keeps us forward-compatible if tungstenite adds variants.
fn set_read_timeout(socket: &mut Sock, dur: Option<Duration>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(dur);
        }
        _ => {}
    }
}

/// Encode `[-1.0, 1.0]`-clamped f32 PCM samples to little-endian i16 bytes. Scribe's
/// `sample_rate=16000` query expects exactly this on the wire (linear16 mono). Same
/// implementation as `crate::providers::deepgram::encode_linear16`; duplicated rather
/// than shared because (a) it's tiny, (b) the providers are independently feature-gated,
/// and (c) the encoders may legitimately diverge if Scribe ever supports a different
/// wire format (e.g. mu-law). YAGNI applies on the abstraction front for now.
pub(crate) fn encode_linear16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let scaled = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&scaled.to_le_bytes());
    }
    bytes
}

/// Scribe streaming envelope. The expected on-the-wire shape (documented at the time of
/// writing — see module header for the API drift policy):
///
/// ```json
/// {
///   "type": "transcription",
///   "is_final": true,
///   "transcript": "What time is the meeting?",
///   "start_time": 1.5,
///   "end_time": 3.8,
///   "language_probability": 0.987
/// }
/// ```
///
/// Non-`transcription` envelopes (e.g. `metadata`, `ping`, `error`) are silently dropped.
/// Interim hypotheses (`is_final = false`) are filtered — Phase 2's question detector
/// reads only finalized strings (`shared/types.ts:TranscriptChunk.text` with
/// `isFinal: true`), and surfacing partials would spam the dedup window (T-2.4).
#[derive(Debug, Deserialize)]
struct EsEnvelope {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    is_final: Option<bool>,
    transcript: Option<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    language_probability: Option<f32>,
}

/// Parse one ElevenLabs Scribe WS text frame.
///
/// Returns:
/// - `Ok(Some(seg))` — finalized `transcription` envelope with non-empty transcript.
/// - `Ok(None)` — interim hypothesis, non-`transcription` envelope (metadata / ping /
///   error / etc.), or empty / whitespace-only transcript.
/// - `Err(SttError::Decode(_))` — JSON parse failure.
pub(crate) fn parse_transcription(
    text: &str,
    base_ts_ms: u64,
) -> Result<Option<SttSegment>, SttError> {
    let env: EsEnvelope = serde_json::from_str(text)
        .map_err(|e| SttError::Decode(format!("elevenlabs json: {e} — line={text:?}")))?;

    if env.msg_type.as_deref() != Some("transcription") {
        return Ok(None);
    }
    if !env.is_final.unwrap_or(false) {
        return Ok(None);
    }

    let transcript = match env.transcript {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Ok(None),
    };

    let start_ms = (env.start_time.unwrap_or(0.0) * 1000.0) as u64;
    let end_ms = (env.end_time.unwrap_or(env.start_time.unwrap_or(0.0)) * 1000.0) as u64;

    Ok(Some(SttSegment {
        text: transcript,
        start_ts_ms: base_ts_ms.saturating_add(start_ms),
        end_ts_ms: base_ts_ms.saturating_add(end_ms),
        is_final: true,
        // Scribe surfaces `language_probability` as a per-utterance proxy for confidence
        // (the API doesn't currently emit a separate `confidence` field; ARCH §3.2 lists
        // Scribe latency at ~200 ms but doesn't pin a confidence schema). Threading
        // through here lets the question-detector dedup window (T-2.4) and cost-meter
        // bucketing (T-3.5) read a uniform `confidence` shape across both cloud
        // providers.
        confidence: env.language_probability,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use audio_capture::PcmChunk;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;
    use tungstenite::handshake::server::{Request as ServerRequest, Response as ServerResponse};

    fn fake_chunk(n: usize, rate: u32, ts: u64) -> PcmChunk {
        PcmChunk {
            samples: vec![0.0; n],
            sample_rate: rate,
            ts_ms: ts,
        }
    }

    /// Test-default backoff: ~zero wait so failure paths surface in microseconds rather
    /// than the production 200 ms / 3-attempt budget. Mirrors the Deepgram test helper.
    fn fast_backoff() -> BackoffConfig {
        BackoffConfig {
            initial_delay: Duration::from_millis(0),
            multiplier: 1.0,
            max_delay: Duration::from_millis(1),
            max_retries: 3,
            jitter: 0.0,
        }
    }

    // -----------------------------------------------------------------------
    // Construction-time validation
    // -----------------------------------------------------------------------

    #[test]
    fn new_returns_config_error_when_key_missing() {
        let cfg = ElevenLabsConfig {
            api_key: None,
            url: "ws://127.0.0.1:1/v1/speech-to-text/scribe-v1/stream".into(),
            read_drain_timeout: Duration::from_millis(10),
            backoff: fast_backoff(),
        };
        let err = ElevenLabsAdapter::new(cfg).expect_err("missing key must error");
        match err {
            SttError::Config(msg) => {
                assert!(
                    msg.contains("ELEVENLABS_API_KEY"),
                    "msg should mention ELEVENLABS_API_KEY, got {msg:?}"
                );
            }
            other => panic!("expected SttError::Config, got {other:?}"),
        }
    }

    #[test]
    fn new_returns_config_error_when_key_empty() {
        let cfg = ElevenLabsConfig {
            api_key: Some(String::new()),
            url: "ws://127.0.0.1:1/v1/speech-to-text/scribe-v1/stream".into(),
            read_drain_timeout: Duration::from_millis(10),
            backoff: fast_backoff(),
        };
        let err = ElevenLabsAdapter::new(cfg).expect_err("empty key must error");
        assert!(matches!(err, SttError::Config(_)));
    }

    #[test]
    fn name_is_stable_for_settings_serialization() {
        let cfg = ElevenLabsConfig {
            api_key: Some("nope".into()),
            url: "ws://127.0.0.1:1/v1/speech-to-text/scribe-v1/stream".into(),
            read_drain_timeout: Duration::from_millis(10),
            backoff: fast_backoff(),
        };
        let adapter = ElevenLabsAdapter::new(cfg).expect("new");
        // Stable string ID — settings persistence (T-3.6) + telemetry (T-3.9) read this.
        // Distinct from "deepgram" so the audit log can differentiate switches between
        // the two cloud providers.
        assert_eq!(adapter.name(), "elevenlabs");
    }

    // -----------------------------------------------------------------------
    // Pure JSON parser tests — golden Scribe envelopes
    // -----------------------------------------------------------------------

    const GOLDEN_FINAL: &str = r#"{"type":"transcription","is_final":true,"transcript":"What time is the meeting?","start_time":1.5,"end_time":3.8,"language_probability":0.987}"#;
    const GOLDEN_INTERIM: &str = r#"{"type":"transcription","is_final":false,"transcript":"What time","start_time":0.5,"end_time":1.0,"language_probability":0.5}"#;
    const GOLDEN_METADATA: &str = r#"{"type":"metadata","request_id":"abc-123","model_id":"scribe_v1"}"#;
    const GOLDEN_PING: &str = r#"{"type":"ping","ts":1234}"#;
    const GOLDEN_EMPTY_TRANSCRIPT: &str = r#"{"type":"transcription","is_final":true,"transcript":"","start_time":3.0,"end_time":4.0,"language_probability":0.1}"#;
    const GOLDEN_WHITESPACE_TRANSCRIPT: &str = r#"{"type":"transcription","is_final":true,"transcript":"   ","start_time":3.0,"end_time":4.0,"language_probability":0.1}"#;

    #[test]
    fn parse_transcription_extracts_finalized_segment_with_offset() {
        let seg = parse_transcription(GOLDEN_FINAL, 10_000)
            .expect("parse ok")
            .expect("segment present");
        assert_eq!(seg.text, "What time is the meeting?");
        // base 10_000 ms + Scribe start_time 1.5 s = 11_500 ms.
        assert_eq!(seg.start_ts_ms, 11_500);
        // base 10_000 ms + Scribe end_time 3.8 s = 13_800 ms (Scribe emits absolute
        // session-relative end_time, not start+duration like Deepgram).
        assert_eq!(seg.end_ts_ms, 13_800);
        assert!(seg.is_final);
        assert!(
            (seg.confidence.expect("confidence") - 0.987).abs() < 1e-3,
            "language_probability threaded through to confidence"
        );
    }

    #[test]
    fn parse_transcription_ignores_interim() {
        // Phase 2 question detector reads only finalized strings — interim hypotheses
        // would spam the queue with duplicates. Same contract as Deepgram parser.
        let r = parse_transcription(GOLDEN_INTERIM, 0).expect("parse ok");
        assert!(r.is_none(), "interim envelope must be filtered");
    }

    #[test]
    fn parse_transcription_ignores_non_transcription_envelope() {
        let r = parse_transcription(GOLDEN_METADATA, 0).expect("parse ok");
        assert!(r.is_none(), "metadata envelope must be filtered");
        let r = parse_transcription(GOLDEN_PING, 0).expect("parse ok");
        assert!(r.is_none(), "ping envelope must be filtered");
    }

    #[test]
    fn parse_transcription_ignores_empty_transcript() {
        let r = parse_transcription(GOLDEN_EMPTY_TRANSCRIPT, 0).expect("parse ok");
        assert!(r.is_none(), "empty transcript must be filtered");
        let r = parse_transcription(GOLDEN_WHITESPACE_TRANSCRIPT, 0).expect("parse ok");
        assert!(r.is_none(), "whitespace-only transcript must be filtered");
    }

    #[test]
    fn parse_transcription_returns_decode_error_on_invalid_json() {
        let err = parse_transcription("not json at all", 0).expect_err("must error");
        assert!(matches!(err, SttError::Decode(_)));
    }

    #[test]
    fn parse_transcription_handles_missing_end_time_gracefully() {
        // Defensive: Scribe API may omit `end_time` on edge cases (zero-duration
        // utterance). Adapter should fall back to `start_time` rather than computing
        // 0 - 1.5 = wrap-around.
        let body = r#"{"type":"transcription","is_final":true,"transcript":"hi","start_time":2.0}"#;
        let seg = parse_transcription(body, 1_000)
            .expect("parse ok")
            .expect("segment present");
        // base 1_000 + start 2.0 s = 3_000; end falls back to start_time → 3_000.
        assert_eq!(seg.start_ts_ms, 3_000);
        assert_eq!(seg.end_ts_ms, 3_000);
    }

    // -----------------------------------------------------------------------
    // Encoder
    // -----------------------------------------------------------------------

    #[test]
    fn encode_linear16_scales_and_clamps() {
        // Same wire format as Deepgram (linear16 LE i16 mono) — the test mirrors
        // `crate::providers::deepgram::tests::encode_linear16_scales_and_clamps` so
        // wire-format drift on either side is caught locally.
        let samples = vec![0.0, 1.0, -1.0, 0.5, 2.0, -2.0];
        let bytes = encode_linear16(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 0);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 32767);
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), -32767);
        let half = i16::from_le_bytes([bytes[6], bytes[7]]);
        assert!(
            (16380..=16384).contains(&half),
            "expected ~16384 for 0.5, got {half}"
        );
        assert_eq!(i16::from_le_bytes([bytes[8], bytes[9]]), 32767);
        assert_eq!(i16::from_le_bytes([bytes[10], bytes[11]]), -32767);
    }

    // -----------------------------------------------------------------------
    // Mock WebSocket harness
    //
    // Spawns an in-process tungstenite server on 127.0.0.1:0. The server captures the
    // upgrade request's `xi-api-key` header, sends the supplied responses as text frames
    // immediately after handshake, then drains incoming frames (with a bounded timeout)
    // until the client closes or the read times out. The handle joins to yield the
    // captured `xi-api-key` header.
    //
    // Mirrors the Deepgram test harness `spawn_mock_server` shape — the only
    // adapter-specific bit is which header gets captured.
    // -----------------------------------------------------------------------

    fn spawn_mock_server(
        responses: Vec<&'static str>,
    ) -> (u16, thread::JoinHandle<Option<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || -> Option<String> {
            let (stream, _addr) = listener.accept().ok()?;
            let mut xi_key: Option<String> = None;
            let mut sock = match tungstenite::accept_hdr(
                stream,
                |req: &ServerRequest, resp: ServerResponse| {
                    xi_key = req
                        .headers()
                        .get("xi-api-key")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);
                    Ok(resp)
                },
            ) {
                Ok(s) => s,
                Err(_) => return xi_key,
            };

            for body in responses {
                let _ = sock.send(Message::Text(body.to_string()));
            }

            // Bound the server-side wait so a test never hangs if the adapter closes
            // before flushing its drain loop. 400 ms × 5 iterations = 2 s ceiling.
            let _ = sock
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(400)));
            for _ in 0..5 {
                match sock.read() {
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            let _ = sock.close(None);
            xi_key
        });
        (port, handle)
    }

    #[test]
    fn mock_ws_handshake_carries_xi_api_key_header() {
        // Contract under test: ElevenLabs auth header is `xi-api-key: <raw key>` —
        // distinct from Deepgram's `Authorization: Token <key>`. The header value
        // must be the raw API key with no prefix; if anyone ever changes this to
        // `Token <key>` or `Bearer <key>` the live API will reject the handshake.
        let (port, server) = spawn_mock_server(vec![]);
        let cfg = ElevenLabsConfig {
            api_key: Some("xi-test-secret-abc-xyz".into()),
            url: format!("ws://127.0.0.1:{port}/v1/speech-to-text/scribe-v1/stream"),
            read_drain_timeout: Duration::from_millis(150),
            backoff: fast_backoff(),
        };
        let mut adapter = ElevenLabsAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);

        // First call connects + sends PCM. The header is the only contract under test
        // in this case — segments may or may not be drained depending on timing.
        let _ = adapter.transcribe_chunk(&chunk);

        let xi_key = server.join().expect("server thread");
        assert_eq!(
            xi_key.as_deref(),
            Some("xi-test-secret-abc-xyz"),
            "ElevenLabs auth contract: `xi-api-key: <raw key>` (no prefix)"
        );
    }

    #[test]
    fn mock_ws_round_trip_emits_golden_segment() {
        // Server sends 4 envelopes: interim (filtered), metadata (filtered), ping
        // (filtered), final (emitted). The adapter must drain all four on the same
        // pass and return exactly one `SttSegment` with the meeting-relative
        // timestamps (chunk.ts_ms = 5_000 → session_base = 5_000).
        let (port, server) = spawn_mock_server(vec![
            GOLDEN_INTERIM,
            GOLDEN_METADATA,
            GOLDEN_PING,
            GOLDEN_FINAL,
        ]);
        let cfg = ElevenLabsConfig {
            api_key: Some("xi-abc".into()),
            url: format!("ws://127.0.0.1:{port}/v1/speech-to-text/scribe-v1/stream"),
            // Generous drain timeout — localhost RTT is sub-millisecond, but the server
            // sends 4 frames and we want the read loop to find them all before timing out.
            read_drain_timeout: Duration::from_millis(300),
            backoff: fast_backoff(),
        };
        let mut adapter = ElevenLabsAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(32_000, 16_000, 5_000);

        let segs = adapter.transcribe_chunk(&chunk).expect("transcribe");
        let _ = server.join();

        assert_eq!(
            segs.len(),
            1,
            "interim + metadata + ping filtered, only finalized envelope emitted; got {segs:?}"
        );
        let seg = &segs[0];
        assert_eq!(seg.text, "What time is the meeting?");
        // base 5_000 + Scribe start_time 1.5 s = 6_500.
        assert_eq!(seg.start_ts_ms, 6_500);
        // base 5_000 + Scribe end_time 3.8 s = 8_800.
        assert_eq!(seg.end_ts_ms, 8_800);
        assert!(seg.is_final);
        assert!(seg.confidence.is_some(), "language_probability surfaced");
    }

    #[test]
    fn mock_ws_drains_zero_segments_when_server_silent() {
        // Server accepts the handshake but sends no frames — adapter should send PCM,
        // drain to a clean empty Vec, and not error. This is the steady-state path
        // between Scribe utterance batching boundaries.
        let (port, server) = spawn_mock_server(vec![]);
        let cfg = ElevenLabsConfig {
            api_key: Some("xi-abc".into()),
            url: format!("ws://127.0.0.1:{port}/v1/speech-to-text/scribe-v1/stream"),
            read_drain_timeout: Duration::from_millis(50),
            backoff: fast_backoff(),
        };
        let mut adapter = ElevenLabsAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = adapter.transcribe_chunk(&chunk).expect("transcribe");
        let _ = server.join();
        assert!(segs.is_empty(), "no responses → no segments");
    }

    // -----------------------------------------------------------------------
    // Connect-with-backoff smoke (operational reuse of T-3.3 schedule math)
    //
    // Schedule unit tests already cover the math (`backoff_*` in the deepgram tests
    // module); these tests exercise the operational shape on the ElevenLabs adapter
    // so a future change to one adapter's connect path doesn't silently degrade the
    // other.
    // -----------------------------------------------------------------------

    #[test]
    fn connect_returns_provider_unavailable_after_max_retries() {
        // Port 1 — never listening, instant ECONNREFUSED. Sub-ms backoff completes
        // in microseconds.
        let cfg = ElevenLabsConfig {
            api_key: Some("xi-abc".into()),
            url: "ws://127.0.0.1:1/v1/speech-to-text/scribe-v1/stream".into(),
            read_drain_timeout: Duration::from_millis(10),
            backoff: BackoffConfig {
                initial_delay: Duration::from_millis(0),
                multiplier: 1.0,
                max_delay: Duration::from_millis(1),
                max_retries: 3,
                jitter: 0.0,
            },
        };
        let mut adapter = ElevenLabsAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);
        let err = adapter
            .transcribe_chunk(&chunk)
            .expect_err("port 1 must refuse connection");
        match err {
            SttError::ProviderUnavailable {
                attempts,
                last_error,
            } => {
                assert_eq!(attempts, 3, "exhausted budget == 3 attempts");
                assert!(
                    !last_error.is_empty(),
                    "last_error should capture the underlying transport failure"
                );
            }
            other => panic!("expected ProviderUnavailable, got {other:?}"),
        }
    }

    #[test]
    fn connect_does_not_retry_on_config_error() {
        // Bad URL → `SttError::Config` from `into_client_request`. Config errors are
        // user-actionable, not transient — must surface immediately without consuming
        // the retry budget. Same shape as the Deepgram counterpart.
        let cfg = ElevenLabsConfig {
            api_key: Some("xi-abc".into()),
            url: "not-a-valid-url".into(),
            read_drain_timeout: Duration::from_millis(10),
            backoff: BackoffConfig {
                initial_delay: Duration::from_millis(50),
                multiplier: 2.0,
                max_delay: Duration::from_millis(500),
                max_retries: 3,
                jitter: 0.0,
            },
        };
        let mut adapter = ElevenLabsAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);

        let start = std::time::Instant::now();
        let err = adapter
            .transcribe_chunk(&chunk)
            .expect_err("bad url must error");
        let elapsed = start.elapsed();

        assert!(
            matches!(err, SttError::Config(_)),
            "config errors are not retried; got {err:?}"
        );
        // If we accidentally retried 3× with 50/100/200 ms backoff this would be
        // ≥ 150 ms. Single attempt + no sleep → < 50 ms wall-clock even on slow CI.
        assert!(
            elapsed < Duration::from_millis(50),
            "config error must not consume backoff budget; elapsed = {elapsed:?}"
        );
    }
}
