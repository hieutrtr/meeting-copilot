// Deepgram WebSocket STT adapter — Phase 3 T-3.2.
//
// Streams 16 kHz linear16 PCM frames over a WebSocket to Deepgram's `/v1/listen` endpoint
// and decodes the `Results` JSON envelopes into `SttSegment`s. Plugs into the `SttProvider`
// trait extracted by T-3.1 (`crate::provider::SttProvider`).
//
// ## Trait shape — streaming source through a sync per-chunk API
//
// `SttProvider::transcribe_chunk(&mut self, chunk)` is sync request/response (Phase 1
// T-1.5 contract; ARCH §3.1's async-stream is the IPC envelope, not the per-provider
// trait — see `crates/stt-mlx/src/provider.rs:5–9`). Deepgram is naturally streaming, so:
//
//   1. Lazy-connect on first call (so `new()` doesn't bind a socket ahead of `start`).
//   2. Encode the chunk to little-endian i16 PCM and send as a binary frame.
//   3. Drain pending text frames using a short read timeout (`read_drain_timeout`,
//      default 50 ms); for each `Results` envelope with `is_final = true` build an
//      `SttSegment` and push to the result vector.
//   4. Return the drained vector. Many calls return `vec![]` (Deepgram batches across
//      chunks); a later call returns one or more accumulated segments.
//
// **Timestamp policy**: Deepgram's `start` field is offset from when *Deepgram* started
// receiving audio (= our first chunk's send). The adapter records the first chunk's
// `ts_ms` as `session_base_ts_ms`; segment timestamps are
// `session_base_ts_ms + Deepgram.start * 1000`. Best-effort heuristic — within ~200 ms
// on localhost, perfectly fine for the question-detector pipeline which only reads
// finalized text strings (`shared/types.ts:TranscriptChunk.text`).
//
// ## TLS / production
//
// T-3.2 ships **plain WebSocket only** (`tungstenite` with `default-features = false,
// features = ["handshake"]`). Production `wss://api.deepgram.com/v1/listen` requires
// TLS; the rustls feature flag + reconnect/chaos handling land together in T-3.3.
// Until then, the unit test exercises the framing + parsing seam against an in-process
// `ws://` mock server, and `DeepgramConfig::default().url` still names the production
// `wss://` URL — production-mode connect surfaces a typed `SttError::Io` from
// tungstenite's TLS-unsupported error so the failure is loud, not silent.

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

/// Configuration for the Deepgram WebSocket adapter.
///
/// `api_key` — when `None` or empty, `DeepgramAdapter::new()` returns
/// `SttError::Config("DEEPGRAM_API_KEY missing or empty")`. `Default::default()` reads
/// the `DEEPGRAM_API_KEY` env var.
///
/// `url` — full WebSocket URL including query parameters. Default points at production
/// `wss://api.deepgram.com/v1/listen?...`; tests override with `ws://127.0.0.1:PORT/...`.
///
/// `read_drain_timeout` — how long to wait on the socket per drain iteration before giving
/// up and returning what we've collected. 50 ms is short enough that real-time chunks
/// don't stall, long enough that a localhost mock server's response arrives in time.
#[derive(Debug, Clone)]
pub struct DeepgramConfig {
    pub api_key: Option<String>,
    pub url: String,
    pub read_drain_timeout: Duration,
}

impl Default for DeepgramConfig {
    fn default() -> Self {
        Self {
            api_key: env::var("DEEPGRAM_API_KEY").ok().filter(|s| !s.is_empty()),
            // ARCH §3.2 — Deepgram Nova-2 streaming, linear16 mono @ 16 kHz, interim_results
            // enabled (we filter them out client-side; surfacing them lets a future telemetry
            // / UX hook surface partials without re-handshaking the socket).
            url: "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&interim_results=true".into(),
            read_drain_timeout: Duration::from_millis(50),
        }
    }
}

/// Concrete provider type alias. Without TLS features compiled in, the only `MaybeTlsStream`
/// variant `tungstenite::connect` can construct is `Plain(TcpStream)` — but the type itself
/// always has the same shape so callers don't need to special-case TLS-on vs TLS-off.
type Sock = WebSocket<MaybeTlsStream<TcpStream>>;

/// `SttProvider` impl for Deepgram. Holds at most one live WebSocket. On any read error,
/// drops the socket so the next `transcribe_chunk` triggers a fresh connect — T-3.3 will
/// add bounded retry + exponential backoff on top of this lazy-reconnect behavior.
pub struct DeepgramAdapter {
    config: DeepgramConfig,
    socket: Option<Sock>,
    /// Set on the first chunk send. Used to offset Deepgram's session-relative `start`
    /// field against the meeting timeline.
    session_base_ts_ms: Option<u64>,
}

impl DeepgramAdapter {
    /// Construct an adapter. Validates the API key but does NOT connect — the socket
    /// is opened lazily on the first `transcribe_chunk` call so the meeting state machine
    /// (T-1.9) can construct the provider in `idle` and only pay the network handshake
    /// when transitioning to `active`.
    pub fn new(config: DeepgramConfig) -> Result<Self, SttError> {
        match config.api_key.as_deref() {
            Some(s) if !s.is_empty() => {}
            _ => {
                return Err(SttError::Config(
                    "DEEPGRAM_API_KEY missing or empty".into(),
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
            .ok_or_else(|| SttError::Config("DEEPGRAM_API_KEY missing".into()))?;

        let mut req = self
            .config
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| SttError::Config(format!("invalid url {}: {e}", self.config.url)))?;

        let value = HeaderValue::from_str(&format!("Token {api_key}"))
            .map_err(|e| SttError::Config(format!("auth header value: {e}")))?;
        req.headers_mut().insert("Authorization", value);

        let (sock, _resp) = tungstenite::connect(req)
            .map_err(|e| SttError::Io(format!("ws connect: {e}")))?;
        Ok(sock)
    }
}

impl SttProvider for DeepgramAdapter {
    fn name(&self) -> &'static str {
        "deepgram"
    }

    fn transcribe_chunk(&mut self, chunk: &PcmChunk) -> Result<Vec<SttSegment>, SttError> {
        if self.socket.is_none() {
            self.socket = Some(self.connect()?);
            self.session_base_ts_ms = Some(chunk.ts_ms);
        }
        let session_base = self.session_base_ts_ms.unwrap_or(chunk.ts_ms);

        let payload = encode_linear16(&chunk.samples);
        let drain_timeout = self.config.read_drain_timeout;

        let socket = self.socket.as_mut().expect("socket connected above");
        socket
            .send(Message::Binary(payload))
            .map_err(|e| SttError::Io(format!("ws send: {e}")))?;

        // Switch the underlying TcpStream to non-blocking-via-timeout for the drain loop.
        set_read_timeout(socket, Some(drain_timeout));

        let mut out = Vec::new();
        let mut closed = false;
        loop {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if let Some(seg) = parse_results(&text, session_base)? {
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
/// no frame is buffered. T-3.2 ships plain-TCP only, so the only `MaybeTlsStream` variant
/// the connector ever produces is `Plain`. T-3.3 will extend this match for the rustls
/// `Rustls` variant when wiring TLS support.
fn set_read_timeout(socket: &mut Sock, dur: Option<Duration>) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(dur);
        }
        // `MaybeTlsStream` is `#[non_exhaustive]`. With T-3.2's feature set (handshake
        // only, no TLS), `Plain` is the only constructible variant; the catch-all keeps
        // us forward-compatible if tungstenite adds variants without us re-pinning.
        _ => {}
    }
}

/// Encode `[-1.0, 1.0]`-clamped f32 PCM samples to little-endian i16 bytes. Deepgram's
/// `encoding=linear16&sample_rate=16000` query expects exactly this on the wire.
pub(crate) fn encode_linear16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let scaled = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&scaled.to_le_bytes());
    }
    bytes
}

#[derive(Debug, Deserialize)]
struct DgEnvelope {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    is_final: Option<bool>,
    start: Option<f64>,
    duration: Option<f64>,
    channel: Option<DgChannel>,
}

#[derive(Debug, Deserialize)]
struct DgChannel {
    alternatives: Vec<DgAlternative>,
}

#[derive(Debug, Deserialize)]
struct DgAlternative {
    transcript: String,
    confidence: Option<f32>,
}

/// Parse one Deepgram WS text frame.
///
/// Returns:
/// - `Ok(Some(seg))` — finalized `Results` envelope with non-empty transcript.
/// - `Ok(None)` — interim hypothesis, non-`Results` envelope (Metadata / SpeechStarted /
///   UtteranceEnd / etc.), or empty alternative.
/// - `Err(SttError::Decode(_))` — JSON parse failure.
pub(crate) fn parse_results(text: &str, base_ts_ms: u64) -> Result<Option<SttSegment>, SttError> {
    let env: DgEnvelope = serde_json::from_str(text)
        .map_err(|e| SttError::Decode(format!("deepgram json: {e} — line={text:?}")))?;

    if env.msg_type.as_deref() != Some("Results") {
        return Ok(None);
    }
    if !env.is_final.unwrap_or(false) {
        return Ok(None);
    }

    let alt = env.channel.and_then(|c| c.alternatives.into_iter().next());
    let alt = match alt {
        Some(a) if !a.transcript.trim().is_empty() => a,
        _ => return Ok(None),
    };

    let start_ms = (env.start.unwrap_or(0.0) * 1000.0) as u64;
    let dur_ms = (env.duration.unwrap_or(0.0) * 1000.0) as u64;

    Ok(Some(SttSegment {
        text: alt.transcript,
        start_ts_ms: base_ts_ms.saturating_add(start_ms),
        end_ts_ms: base_ts_ms.saturating_add(start_ms.saturating_add(dur_ms)),
        is_final: true,
        confidence: alt.confidence,
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

    // -----------------------------------------------------------------------
    // Construction-time validation
    // -----------------------------------------------------------------------

    #[test]
    fn new_returns_config_error_when_key_missing() {
        let cfg = DeepgramConfig {
            api_key: None,
            url: "ws://127.0.0.1:1/v1/listen".into(),
            read_drain_timeout: Duration::from_millis(10),
        };
        let err = DeepgramAdapter::new(cfg).expect_err("missing key must error");
        match err {
            SttError::Config(msg) => {
                assert!(
                    msg.contains("DEEPGRAM_API_KEY"),
                    "msg should mention DEEPGRAM_API_KEY, got {msg:?}"
                );
            }
            other => panic!("expected SttError::Config, got {other:?}"),
        }
    }

    #[test]
    fn new_returns_config_error_when_key_empty() {
        let cfg = DeepgramConfig {
            api_key: Some(String::new()),
            url: "ws://127.0.0.1:1/v1/listen".into(),
            read_drain_timeout: Duration::from_millis(10),
        };
        let err = DeepgramAdapter::new(cfg).expect_err("empty key must error");
        assert!(matches!(err, SttError::Config(_)));
    }

    #[test]
    fn name_is_stable_for_settings_serialization() {
        let cfg = DeepgramConfig {
            api_key: Some("nope".into()),
            url: "ws://127.0.0.1:1/v1/listen".into(),
            read_drain_timeout: Duration::from_millis(10),
        };
        let adapter = DeepgramAdapter::new(cfg).expect("new");
        // Stable string ID — settings persistence (T-3.6) + telemetry (T-3.9) read this.
        assert_eq!(adapter.name(), "deepgram");
    }

    // -----------------------------------------------------------------------
    // Pure JSON parser tests
    // -----------------------------------------------------------------------

    const GOLDEN_FINAL: &str = r#"{"type":"Results","is_final":true,"speech_final":true,"start":1.5,"duration":2.3,"channel":{"alternatives":[{"transcript":"What time is the meeting?","confidence":0.987}]}}"#;
    const GOLDEN_INTERIM: &str = r#"{"type":"Results","is_final":false,"start":0.5,"duration":0.5,"channel":{"alternatives":[{"transcript":"What time","confidence":0.5}]}}"#;
    const GOLDEN_METADATA: &str = r#"{"type":"Metadata","request_id":"abc","model_info":{"name":"nova-2"}}"#;
    const GOLDEN_EMPTY_ALT: &str = r#"{"type":"Results","is_final":true,"start":3.0,"duration":1.0,"channel":{"alternatives":[{"transcript":"","confidence":0.1}]}}"#;
    const GOLDEN_WHITESPACE_ALT: &str = r#"{"type":"Results","is_final":true,"start":3.0,"duration":1.0,"channel":{"alternatives":[{"transcript":"   ","confidence":0.1}]}}"#;

    #[test]
    fn parse_results_extracts_finalized_segment_with_offset() {
        let seg = parse_results(GOLDEN_FINAL, 10_000)
            .expect("parse ok")
            .expect("segment present");
        assert_eq!(seg.text, "What time is the meeting?");
        // base 10_000 ms + Deepgram start 1.5 s = 11_500 ms
        assert_eq!(seg.start_ts_ms, 11_500);
        // start + duration 2.3 s = 13_800 ms
        assert_eq!(seg.end_ts_ms, 13_800);
        assert!(seg.is_final);
        assert!(
            (seg.confidence.expect("confidence") - 0.987).abs() < 1e-3,
            "confidence threaded through"
        );
    }

    #[test]
    fn parse_results_ignores_interim() {
        // Phase 2 question detector reads only finalized strings — interim hypotheses
        // would spam the queue with duplicates.
        let r = parse_results(GOLDEN_INTERIM, 0).expect("parse ok");
        assert!(r.is_none(), "interim envelope must be filtered");
    }

    #[test]
    fn parse_results_ignores_non_results_envelope() {
        let r = parse_results(GOLDEN_METADATA, 0).expect("parse ok");
        assert!(r.is_none(), "Metadata envelope must be filtered");
    }

    #[test]
    fn parse_results_ignores_empty_transcript() {
        let r = parse_results(GOLDEN_EMPTY_ALT, 0).expect("parse ok");
        assert!(r.is_none(), "empty alternative must be filtered");
        let r = parse_results(GOLDEN_WHITESPACE_ALT, 0).expect("parse ok");
        assert!(r.is_none(), "whitespace-only alternative must be filtered");
    }

    #[test]
    fn parse_results_returns_decode_error_on_invalid_json() {
        let err = parse_results("not json at all", 0).expect_err("must error");
        assert!(matches!(err, SttError::Decode(_)));
    }

    // -----------------------------------------------------------------------
    // Encoder
    // -----------------------------------------------------------------------

    #[test]
    fn encode_linear16_scales_and_clamps() {
        let samples = vec![0.0, 1.0, -1.0, 0.5, 2.0, -2.0];
        let bytes = encode_linear16(&samples);
        assert_eq!(bytes.len(), samples.len() * 2);
        // 0.0 → 0
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 0);
        // 1.0 → 32767
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 32767);
        // -1.0 → -32767 (note: not i16::MIN — symmetric scaling)
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), -32767);
        // 0.5 → ~16384 (rounding)
        let half = i16::from_le_bytes([bytes[6], bytes[7]]);
        assert!(
            (16380..=16384).contains(&half),
            "expected ~16384 for 0.5, got {half}"
        );
        // 2.0 clamped → 32767
        assert_eq!(i16::from_le_bytes([bytes[8], bytes[9]]), 32767);
        // -2.0 clamped → -32767
        assert_eq!(i16::from_le_bytes([bytes[10], bytes[11]]), -32767);
    }

    // -----------------------------------------------------------------------
    // Mock WebSocket harness
    //
    // Spawns an in-process tungstenite server on 127.0.0.1:0. The server captures the
    // upgrade request's Authorization header, sends the supplied responses as text frames
    // immediately after handshake, then drains incoming frames (with a bounded timeout)
    // until the client closes or the read times out. The handle joins to yield the
    // captured Authorization header.
    // -----------------------------------------------------------------------

    fn spawn_mock_server(
        responses: Vec<&'static str>,
    ) -> (u16, thread::JoinHandle<Option<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || -> Option<String> {
            let (stream, _addr) = listener.accept().ok()?;
            let mut auth: Option<String> = None;
            let mut sock = match tungstenite::accept_hdr(
                stream,
                |req: &ServerRequest, resp: ServerResponse| {
                    auth = req
                        .headers()
                        .get("Authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);
                    Ok(resp)
                },
            ) {
                Ok(s) => s,
                Err(_) => return auth,
            };

            for body in responses {
                let _ = sock.send(Message::Text(body.to_string()));
            }

            // Bound the server-side wait so a test never hangs if the adapter closes
            // before flushing its drain loop. 400 ms timeout × 5 iterations = 2 s ceiling.
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
            auth
        });
        (port, handle)
    }

    #[test]
    fn mock_ws_handshake_carries_authorization_header() {
        let (port, server) = spawn_mock_server(vec![]);
        let cfg = DeepgramConfig {
            api_key: Some("abc-xyz-test".into()),
            url: format!("ws://127.0.0.1:{port}/v1/listen?model=nova-2"),
            read_drain_timeout: Duration::from_millis(150),
        };
        let mut adapter = DeepgramAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);

        // First call connects + sends PCM. Segments not asserted here — only the
        // handshake header is the contract under test.
        let _ = adapter.transcribe_chunk(&chunk);

        let auth = server.join().expect("server thread");
        assert_eq!(
            auth.as_deref(),
            Some("Token abc-xyz-test"),
            "Deepgram auth contract: `Authorization: Token <key>`"
        );
    }

    #[test]
    fn mock_ws_round_trip_emits_golden_segment() {
        // Server sends 3 envelopes in order: interim (filtered), metadata (filtered),
        // final (emitted). The adapter must drain all three on the same drain pass and
        // return exactly one `SttSegment`.
        let (port, server) =
            spawn_mock_server(vec![GOLDEN_INTERIM, GOLDEN_METADATA, GOLDEN_FINAL]);
        let cfg = DeepgramConfig {
            api_key: Some("abc".into()),
            url: format!("ws://127.0.0.1:{port}/v1/listen?model=nova-2"),
            // Generous drain timeout — localhost RTT is sub-millisecond, but the server
            // sends 3 frames and we want the read loop to find them all before timing out.
            read_drain_timeout: Duration::from_millis(300),
        };
        let mut adapter = DeepgramAdapter::new(cfg).expect("new");
        // Chunk ts_ms = 5_000 → session_base = 5_000.
        let chunk = fake_chunk(32_000, 16_000, 5_000);

        let segs = adapter.transcribe_chunk(&chunk).expect("transcribe");
        let _ = server.join();

        assert_eq!(
            segs.len(),
            1,
            "interim + metadata filtered, only finalized envelope emitted; got {segs:?}"
        );
        let seg = &segs[0];
        assert_eq!(seg.text, "What time is the meeting?");
        // base 5_000 + Deepgram start 1.5 s = 6_500
        assert_eq!(seg.start_ts_ms, 6_500);
        // start + duration 2.3 s = 8_800
        assert_eq!(seg.end_ts_ms, 8_800);
        assert!(seg.is_final);
    }

    #[test]
    fn mock_ws_drains_zero_segments_when_server_silent() {
        // Server accepts the handshake but sends no frames — adapter should send PCM,
        // drain to a clean empty Vec, and not error. This is the steady-state path
        // between Deepgram batching boundaries.
        let (port, server) = spawn_mock_server(vec![]);
        let cfg = DeepgramConfig {
            api_key: Some("abc".into()),
            url: format!("ws://127.0.0.1:{port}/v1/listen"),
            read_drain_timeout: Duration::from_millis(50),
        };
        let mut adapter = DeepgramAdapter::new(cfg).expect("new");
        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = adapter.transcribe_chunk(&chunk).expect("transcribe");
        let _ = server.join();
        assert!(segs.is_empty(), "no responses → no segments");
    }
}
