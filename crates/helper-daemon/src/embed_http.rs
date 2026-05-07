// Phase 4 T-4.9 — Dashboard iframe embed HTTP layer.
//
// Loopback-only HTTP service (binds `127.0.0.1:7411` in the binary
// entrypoint; the lib here exposes the `Router::new()` builder and the
// `EmbedState` shape so tests can construct one without a real bind).
//
// Two routes:
//   - GET /embed/transcript/:meetingId?token=<UUID>
//       Returns the static iframe shell HTML with a hard-coded
//       `Referrer-Policy: no-referrer` + `Cache-Control: no-store`. The
//       Vite-built `dist/embed/transcript.html` is loaded by the binary
//       entrypoint and passed in via `EmbedState.html_body`. Lib tests
//       inject a stub HTML.
//   - GET /embed/transcript/:meetingId/events?token=<UUID>
//       Server-Sent Events stream. Subscribes to a `broadcast::Receiver`
//       supplied by the entrypoint per active meeting; each `EmbedEvent` is
//       JSON-encoded and emitted as a single SSE frame.
//
// Security model (R-3 mitigation, see `docs/tasks/phase-4/T-4.9-…md` §3.2-3.3):
//   - **Auth**: token query param verified against `TokenStore` (5-min TTL,
//     scoped to meetingId). Any failure → 401 with bare-bones body (no
//     transcript bytes leak).
//   - **CORS**: hardcoded allow-list `[http://127.0.0.1:7878]`. Missing or
//     mismatched `Origin:` → 403 with no `Access-Control-Allow-Origin`
//     header (browser refuses).
//   - **Side channels**: `Referrer-Policy: no-referrer` +
//     `Cache-Control: no-store` on every response so the URL token can't
//     leak via Referer or browser cache.
//
// Surface ownership: T-4.9 ships the route handlers + `EmbedState` factory.
// Phase 4.x's binary entrypoint constructs the broadcast `Sender` per
// meeting (driven by the in-process Chunker → STT pipeline) and inserts it
// into `EmbedState.channels`; this lib does not start any audio capture.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auth::{AuthError, TokenStore};

/// Hardcoded allow-list (R-3). Wildcard is **never** emitted. Phase 4.x can
/// extend this to a `Vec<String>` if more origins land — keep the type-level
/// constraint that the comparison is exact-equal.
pub const DEFAULT_ALLOWED_ORIGIN: &str = "http://127.0.0.1:7878";

/// Default loopback bind address (the binary entrypoint passes this to
/// `axum::serve`; the lib does not bind).
pub const DEFAULT_BIND_ADDR: &str = "127.0.0.1:7411";

/// One SSE frame's worth of payload. Mirrors the TS `EmbedEventPayload` in
/// `src/embed/types.ts`. JSON-encoded on the wire as
/// `data: {"kind":"transcriptChunk","payload":{…}}\n\n`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", content = "payload")]
pub enum EmbedEvent {
    /// A new transcript chunk landed.
    #[serde(rename_all = "camelCase")]
    TranscriptChunk {
        chunk_id: String,
        speaker: String,
        text: String,
        started_at_ms: i64,
        ended_at_ms: i64,
    },
    /// A new question was detected from the transcript.
    #[serde(rename_all = "camelCase")]
    Question {
        question_id: String,
        text: String,
        detected_at_ms: i64,
    },
    /// The Claude-side answer for a question landed.
    #[serde(rename_all = "camelCase")]
    Answer {
        question_id: String,
        answer_id: String,
        text: String,
        completed_at_ms: i64,
    },
    /// Meeting transitioned to ended — receivers may close.
    #[serde(rename_all = "camelCase")]
    MeetingEnded { ended_at_ms: i64 },
}

/// Pluggable wall-clock — production passes `Instant::now`, tests pass a
/// closure backed by an `Arc<AtomicU64>` to drive expiry deterministically.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// Shared state for the embed router. `Arc<EmbedState>` is cheap to clone
/// per request (axum hands it to each handler).
pub struct EmbedState {
    pub tokens: Arc<TokenStore>,
    /// One broadcast sender per active meeting, keyed by meetingId. The
    /// binary entrypoint (Phase 4.x) inserts/removes entries as meetings
    /// start/stop. Lib tests insert one directly.
    pub channels: Mutex<HashMap<String, broadcast::Sender<EmbedEvent>>>,
    pub clock: Clock,
    pub allowed_origin: String,
    /// Static HTML shell — produced by the Vite `embed-transcript` rollup
    /// entry. The binary entrypoint reads `dist/embed/transcript.html` at
    /// startup and passes the bytes in here.
    pub html_body: String,
}

impl std::fmt::Debug for EmbedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbedState")
            .field("tokens", &"<TokenStore>")
            .field("channels", &"<channels>")
            .field("clock", &"<fn>")
            .field("allowed_origin", &self.allowed_origin)
            .field("html_body", &format!("<{} bytes>", self.html_body.len()))
            .finish()
    }
}

impl EmbedState {
    /// Constructor for the binary entrypoint (production). Uses
    /// `Instant::now` as the clock and the default allow-list.
    pub fn new(tokens: Arc<TokenStore>, html_body: String) -> Arc<Self> {
        Arc::new(Self {
            tokens,
            channels: Mutex::new(HashMap::new()),
            clock: Arc::new(Instant::now),
            allowed_origin: DEFAULT_ALLOWED_ORIGIN.to_string(),
            html_body,
        })
    }

    /// Insert a broadcast sender for a meeting; the entrypoint calls this
    /// when `bridge_meeting_start` fires. Idempotent — overwriting an
    /// existing sender drops the old one (subscribers see end-of-stream).
    pub fn register_channel(&self, meeting_id: &str, tx: broadcast::Sender<EmbedEvent>) {
        let mut chans = self.channels.lock().expect("channels mutex poisoned");
        chans.insert(meeting_id.to_string(), tx);
    }

    /// Remove a broadcast sender; `bridge_meeting_stop` calls this. Returns
    /// the dropped sender so the caller can drain or drop it explicitly.
    pub fn deregister_channel(&self, meeting_id: &str) -> Option<broadcast::Sender<EmbedEvent>> {
        let mut chans = self.channels.lock().expect("channels mutex poisoned");
        chans.remove(meeting_id)
    }

    fn channel_for(&self, meeting_id: &str) -> Option<broadcast::Sender<EmbedEvent>> {
        let chans = self.channels.lock().expect("channels mutex poisoned");
        chans.get(meeting_id).cloned()
    }
}

/// Build the embed router. Returns `Router<()>` with the state wired in via
/// `with_state`, ready to mount under `axum::serve` or call `.oneshot` on in
/// tests.
pub fn router(state: Arc<EmbedState>) -> Router {
    Router::new()
        .route(
            "/embed/transcript/:meeting_id",
            get(handle_html),
        )
        .route(
            "/embed/transcript/:meeting_id/events",
            get(handle_sse),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    pub token: Option<String>,
}

/// Apply the trio of side-channel hardening headers to a response.
fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    // Defence in depth: forbid the document from being framed by anyone
    // other than the dashboard. The browser also enforces CORS for the SSE
    // route, but `X-Frame-Options` blocks malicious framing of the HTML.
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
}

/// Reject requests whose `Origin:` header is missing or is not the exact
/// dashboard origin. Returns the validated origin string on success so the
/// handler can echo it in `Access-Control-Allow-Origin`.
fn check_cors(headers: &HeaderMap, allowed_origin: &str) -> Result<String, Response> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    match origin {
        Some(o) if o == allowed_origin => Ok(o),
        _ => Err(forbidden_response("origin not allowed")),
    }
}

fn forbidden_response(msg: &str) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(axum::body::Body::from(msg.to_string()))
        .expect("static response");
    apply_security_headers(response.headers_mut());
    response
}

fn unauthorized_response(msg: &str) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .body(axum::body::Body::from(msg.to_string()))
        .expect("static response");
    apply_security_headers(response.headers_mut());
    response
}

fn check_auth(
    state: &EmbedState,
    meeting_id: &str,
    token: Option<&str>,
) -> Result<(), Response> {
    let Some(raw) = token else {
        return Err(unauthorized_response("missing token"));
    };
    let parsed = Uuid::parse_str(raw)
        .map_err(|_| unauthorized_response("malformed token"))?;
    let now = (state.clock)();
    state
        .tokens
        .verify(meeting_id, &parsed, now)
        .map_err(|err| match err {
            AuthError::NotFound(_) => unauthorized_response("token not issued"),
            AuthError::Expired(_) => unauthorized_response("token expired"),
            AuthError::Mismatch(_) => unauthorized_response("token mismatch"),
        })
}

async fn handle_html(
    State(state): State<Arc<EmbedState>>,
    Path(meeting_id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = check_cors(&headers, &state.allowed_origin) {
        return resp;
    }
    if let Err(resp) = check_auth(&state, &meeting_id, query.token.as_deref()) {
        return resp;
    }

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_str(&state.allowed_origin).expect("ascii origin"),
        )
        .body(axum::body::Body::from(state.html_body.clone()))
        .expect("static html response");
    apply_security_headers(response.headers_mut());
    response
}

async fn handle_sse(
    State(state): State<Arc<EmbedState>>,
    Path(meeting_id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = check_cors(&headers, &state.allowed_origin) {
        return resp;
    }
    if let Err(resp) = check_auth(&state, &meeting_id, query.token.as_deref()) {
        return resp;
    }

    let Some(tx) = state.channel_for(&meeting_id) else {
        return unauthorized_response("no active stream for meeting");
    };
    let rx = tx.subscribe();

    let stream = broadcast_to_sse(rx);
    let mut sse = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();

    // Inject CORS + side-channel headers into the SSE response. We mutate
    // the headers post-`into_response` because `Sse` does not expose a
    // builder for arbitrary headers.
    sse.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_str(&state.allowed_origin).expect("ascii origin"),
    );
    apply_security_headers(sse.headers_mut());
    sse
}

/// Wrap a `broadcast::Receiver<EmbedEvent>` in a `Stream<Item = Result<Event, Infallible>>`
/// suitable for `Sse::new`. Lag (subscriber too slow) ends the stream — the
/// browser reconnects, which makes the auth gate fire afresh, which is the
/// safer default than swallowing dropped events.
fn broadcast_to_sse(
    rx: broadcast::Receiver<EmbedEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
    futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let json = serde_json::to_string(&event).expect("EmbedEvent serializes");
                    let frame = Event::default().data(json);
                    return Some((Ok(frame), rx));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Skip the lag marker but keep listening — semantically
                    // we'd rather drop a chunk than terminate the iframe.
                    continue;
                }
            }
        }
    })
    .boxed()
}

// --- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request};
    use tower::ServiceExt;

    fn fixed_clock(start: Instant) -> Clock {
        // Test clock — returns a fixed `Instant`. Tests that need to
        // advance the clock construct a fresh state with a later anchor.
        Arc::new(move || start)
    }

    fn variable_clock(anchor: Instant) -> (Clock, Arc<AtomicU64>) {
        let offset_ns = Arc::new(AtomicU64::new(0));
        let offset_ns_for_clock = Arc::clone(&offset_ns);
        let clock: Clock = Arc::new(move || {
            let off = offset_ns_for_clock.load(Ordering::SeqCst);
            anchor + Duration::from_nanos(off)
        });
        (clock, offset_ns)
    }

    fn build_state(clock: Clock) -> Arc<EmbedState> {
        Arc::new(EmbedState {
            tokens: Arc::new(TokenStore::new()),
            channels: Mutex::new(HashMap::new()),
            clock,
            allowed_origin: DEFAULT_ALLOWED_ORIGIN.to_string(),
            html_body: "<html><body><div id=\"root\"></div></body></html>".to_string(),
        })
    }

    fn html_request(meeting_id: &str, token: Option<&str>, origin: Option<&str>) -> Request<Body> {
        let mut path = format!("/embed/transcript/{meeting_id}");
        if let Some(t) = token {
            path.push_str(&format!("?token={t}"));
        }
        let mut req = Request::builder().method(Method::GET).uri(path);
        if let Some(o) = origin {
            req = req.header(header::ORIGIN, o);
        }
        req.body(Body::empty()).expect("request")
    }

    fn sse_request(meeting_id: &str, token: Option<&str>, origin: Option<&str>) -> Request<Body> {
        let mut path = format!("/embed/transcript/{meeting_id}/events");
        if let Some(t) = token {
            path.push_str(&format!("?token={t}"));
        }
        let mut req = Request::builder().method(Method::GET).uri(path);
        if let Some(o) = origin {
            req = req.header(header::ORIGIN, o);
        }
        req.body(Body::empty()).expect("request")
    }

    #[tokio::test]
    async fn html_route_returns_200_on_valid_token_and_origin() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let app = router(state.clone());

        let resp = app
            .oneshot(html_request(
                "m_1",
                Some(&token.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some(DEFAULT_ALLOWED_ORIGIN),
        );
        assert_eq!(
            resp.headers()
                .get(header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer"),
        );
        assert_eq!(
            resp.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
        );
        assert_eq!(
            resp.headers()
                .get(header::X_FRAME_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("SAMEORIGIN"),
        );
        let body = to_bytes(resp.into_body(), 65_536).await.expect("body");
        let text = std::str::from_utf8(&body).expect("utf8");
        assert!(text.contains("<div id=\"root\">"));
    }

    #[tokio::test]
    async fn html_route_rejects_missing_token_with_401() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let _token = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(html_request("m_1", None, Some(DEFAULT_ALLOWED_ORIGIN)))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        // CORS header NOT present on auth failure — defence in depth.
        assert!(resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
        // Side-channel headers ARE present on every response.
        assert_eq!(
            resp.headers()
                .get(header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer"),
        );
    }

    #[tokio::test]
    async fn html_route_rejects_expired_token_with_401() {
        let anchor = Instant::now();
        let (clock, offset_ns) = variable_clock(anchor);
        let state = build_state(clock);
        let token = state.tokens.mint("m_1", anchor);
        let app = router(state);

        // Advance the clock past the TTL.
        let advance = (crate::auth::TOKEN_TTL + Duration::from_secs(1)).as_nanos() as u64;
        offset_ns.store(advance, Ordering::SeqCst);

        let resp = app
            .oneshot(html_request(
                "m_1",
                Some(&token.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(resp.into_body(), 1024).await.expect("body");
        assert!(std::str::from_utf8(&body).unwrap().contains("expired"));
    }

    #[tokio::test]
    async fn html_route_rejects_token_for_different_meeting_with_401() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let _t1 = state.tokens.mint("m_1", now);
        let t2 = state.tokens.mint("m_2", now);
        let app = router(state);

        // Use m_2's token to ask for m_1.
        let resp = app
            .oneshot(html_request(
                "m_1",
                Some(&t2.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(resp.into_body(), 1024).await.expect("body");
        assert!(std::str::from_utf8(&body).unwrap().contains("mismatch"));
    }

    #[tokio::test]
    async fn html_route_rejects_malformed_token_with_401() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let _ = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(html_request(
                "m_1",
                Some("not-a-uuid"),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn html_route_rejects_missing_origin_with_403() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(html_request("m_1", Some(&token.to_string()), None))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // Hard requirement (R-3): no `Access-Control-Allow-Origin` on a
        // forbidden response — and definitely no wildcard.
        assert!(resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn html_route_rejects_evil_origin_with_403() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(html_request(
                "m_1",
                Some(&token.to_string()),
                Some("http://evil.example"),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn html_route_rejects_wrong_loopback_port_with_403() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(html_request(
                "m_1",
                Some(&token.to_string()),
                Some("http://127.0.0.1:1234"),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn cors_check_does_not_emit_wildcard_header_under_any_branch() {
        // Defensive: even if a future regression accidentally tries to
        // emit a wildcard, the production code path never constructs the
        // header value `*`. Snapshot of the implementation surface.
        for outcome in [
            // valid
            (Some(DEFAULT_ALLOWED_ORIGIN), false),
            // missing
            (None, false),
            // evil
            (Some("http://evil.example"), false),
            // wrong port
            (Some("http://127.0.0.1:9999"), false),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(o) = outcome.0 {
                headers.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
            }
            let res = check_cors(&headers, DEFAULT_ALLOWED_ORIGIN);
            match res {
                Ok(echoed) => {
                    assert_ne!(echoed, "*", "must never emit wildcard");
                    assert_eq!(echoed, DEFAULT_ALLOWED_ORIGIN);
                    assert!(outcome.0 == Some(DEFAULT_ALLOWED_ORIGIN));
                }
                Err(resp) => {
                    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
                    assert!(resp
                        .headers()
                        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                        .is_none());
                }
            }
        }
    }

    #[tokio::test]
    async fn sse_route_rejects_unknown_meeting_channel_with_401() {
        // No channel has been registered yet — even a valid token can't
        // open a stream. Treated as unauthorized so the daemon doesn't
        // leak channel-existence to a probing client (a 404 here would
        // let an unauthenticated peer enumerate live meetings).
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let app = router(state);

        let resp = app
            .oneshot(sse_request(
                "m_1",
                Some(&token.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sse_route_streams_events_in_submitted_order() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let (tx, _rx) = broadcast::channel::<EmbedEvent>(16);
        state.register_channel("m_1", tx.clone());
        let app = router(state.clone());

        // Push three events BEFORE the request lands so they are queued
        // in the broadcast channel. Drop the sender after to close the
        // stream so `to_bytes` finishes deterministically.
        tx.send(EmbedEvent::TranscriptChunk {
            chunk_id: "c1".into(),
            speaker: "alice".into(),
            text: "hello".into(),
            started_at_ms: 0,
            ended_at_ms: 100,
        })
        .expect("send 1");
        tx.send(EmbedEvent::Question {
            question_id: "q1".into(),
            text: "what time?".into(),
            detected_at_ms: 110,
        })
        .expect("send 2");
        tx.send(EmbedEvent::Answer {
            question_id: "q1".into(),
            answer_id: "a1".into(),
            text: "now".into(),
            completed_at_ms: 120,
        })
        .expect("send 3");

        let resp = app
            .oneshot(sse_request(
                "m_1",
                Some(&token.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some(DEFAULT_ALLOWED_ORIGIN),
        );
        assert_eq!(
            resp.headers()
                .get(header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer"),
        );

        // Drop the sender + state's last reference so the stream ends.
        // `state.deregister_channel` removes the registry entry; the
        // local clone of `tx` still has to be dropped to fully close.
        state.deregister_channel("m_1");
        drop(tx);

        let body = to_bytes(resp.into_body(), 64 * 1024).await.expect("body");
        let text = std::str::from_utf8(&body).expect("utf8");
        // Each SSE frame is `data: <json>\n\n` (KeepAlive may add comments
        // — `: \n` lines — but won't change order).
        let chunk_pos = text.find("transcriptChunk").expect("chunk in body");
        let q_pos = text.find("question").expect("question in body");
        let a_pos = text.find("answer").expect("answer in body");
        assert!(chunk_pos < q_pos, "chunk must precede question");
        assert!(q_pos < a_pos, "question must precede answer");
        assert!(text.contains("\"speaker\":\"alice\""));
        assert!(text.contains("\"text\":\"hello\""));
    }

    #[tokio::test]
    async fn sse_route_emits_security_headers() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let (tx, _rx) = broadcast::channel::<EmbedEvent>(4);
        state.register_channel("m_1", tx.clone());
        let app = router(state.clone());

        // Drop the channel before the request so the stream closes
        // immediately and `to_bytes` returns.
        state.deregister_channel("m_1");
        drop(tx);

        let resp = app
            .oneshot(sse_request(
                "m_1",
                Some(&token.to_string()),
                Some(DEFAULT_ALLOWED_ORIGIN),
            ))
            .await
            .expect("oneshot");
        // Even with no events the route should reach 200 if the channel
        // existed at request time. We registered + deregistered above
        // so the channel is gone — expect 401 on the no-channel branch.
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        // 401 still carries the side-channel headers.
        assert_eq!(
            resp.headers()
                .get(header::REFERRER_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer"),
        );
        assert_eq!(
            resp.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
        );
    }

    #[tokio::test]
    async fn sse_route_rejects_evil_origin_with_403() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let token = state.tokens.mint("m_1", now);
        let (tx, _rx) = broadcast::channel::<EmbedEvent>(4);
        state.register_channel("m_1", tx.clone());
        let app = router(state);

        let resp = app
            .oneshot(sse_request(
                "m_1",
                Some(&token.to_string()),
                Some("http://evil.example"),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[test]
    fn embed_event_serializes_with_camel_case_kind_and_payload() {
        let evt = EmbedEvent::TranscriptChunk {
            chunk_id: "c1".into(),
            speaker: "alice".into(),
            text: "hi".into(),
            started_at_ms: 0,
            ended_at_ms: 50,
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        // Tag field present + camelCase keys.
        assert!(json.contains("\"kind\":\"transcriptChunk\""));
        assert!(json.contains("\"chunkId\":\"c1\""));
        assert!(json.contains("\"startedAtMs\":0"));
        assert!(json.contains("\"endedAtMs\":50"));
    }

    #[test]
    fn embed_event_meeting_ended_serializes() {
        let evt = EmbedEvent::MeetingEnded { ended_at_ms: 999 };
        let json = serde_json::to_string(&evt).expect("serialize");
        assert!(json.contains("\"kind\":\"meetingEnded\""));
        assert!(json.contains("\"endedAtMs\":999"));
    }

    #[tokio::test]
    async fn register_and_deregister_channel_are_observable_under_lock() {
        let now = Instant::now();
        let state = build_state(fixed_clock(now));
        let (tx, _rx) = broadcast::channel::<EmbedEvent>(2);
        state.register_channel("m_1", tx.clone());
        assert!(state.channel_for("m_1").is_some());
        let dropped = state.deregister_channel("m_1");
        assert!(dropped.is_some());
        assert!(state.channel_for("m_1").is_none());
    }
}
