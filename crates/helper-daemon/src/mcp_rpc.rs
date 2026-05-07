// Phase 4 T-4.5 — Helper-daemon Unix-domain RPC server.
//
// Out-of-process surface counterpart to the in-process `bridge.rs` and
// `repo.rs` from Phase 1. Listens on a Unix-domain socket (path supplied by
// the binary entrypoint, defaults baked into the TS side) and serves a tiny
// line-delimited JSON protocol:
//
//     <-- {"method":"status"[,"meetingId":"…"]}
//     --> {"meetings":[{...}, ...]}
//
// One request → one response → connection closes (single-shot). The future
// `subscribe` method (T-4.9) keeps the connection open and streams events as
// `\n`-terminated JSON; the dispatch shape laid down here is forward-compat
// with that addition (each method owns its own handler — see `dispatch`).
//
// Wire shape parity: response objects use `serde(rename_all = "camelCase")`
// so they JSON-decode 1:1 against `src/mcp/tools.ts:StatusOutputSchema`. The
// MCP handler re-parses the line through Zod; any drift fails the parse
// loudly. The struct names here are the parity anchors.
//
// Stale-socket recovery (R-4 in `docs/tasks/phase-4/INDEX.md`):
//   When the daemon binds, it first checks whether the path already has a
//   listener responding. The helper `recover_stale_socket` documents the
//   strategy: dial-with-timeout; if connect-or-respond fails inside the
//   recovery deadline, `unlink` the file and return success so `bind` can
//   proceed. If the dial succeeds (a live daemon is already running),
//   recovery returns an error so the bind aborts — operator must stop the
//   other daemon first. The unit test `recover_stale_socket_unlinks_dead`
//   exercises the dead-socket branch directly.
//
// Surface ownership: T-4.5 ships `status` + dispatch shape. T-4.6 ADDS
// `stop` (mutates `RpcState`; the Phase 4.x entrypoint wires the Repo
// `mark_meeting_ended` callback and STT-buffer flush around it). T-4.9 will
// add `subscribe` (long-lived). The `RpcState` struct gathers the read-side
// state needed to answer queries plus the stop-record cache for idempotency
// — the Tauri-app entrypoint constructs a `Repo` + a meetings tracker and
// passes them in via `Arc`s.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

/// One row of the `status` response. Parity with TS
/// `StatusOutputSchema.meetings[*]` (see `src/mcp/tools.ts`). Adding a new
/// field requires bumping both sides in lockstep.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatusEntry {
    pub id: String,
    pub pid: u32,
    pub started_at: i64,
    pub stt_provider: String,
    pub transcript_chunks: u32,
    pub question_count: u32,
    pub answer_count: u32,
    pub uptime_sec: u64,
}

/// Response envelope for `status`. Singular `MeetingStatusEntry` collected
/// inside `meetings`. Mirror of TS `StatusOutput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub meetings: Vec<MeetingStatusEntry>,
}

/// Response envelope for `stop`. Mirror of TS `StopOutputSchema`. The optional
/// `exported_path` is `None` unless the entrypoint passes through an auto-
/// export side-effect at stop time (Phase 4.x — the lib leaves this `None`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exported_path: Option<String>,
    pub duration_sec: f64,
    pub question_count: u32,
}

/// Cached stop record kept inside `RpcState.stopped` for idempotency. Re-stops
/// of the same meeting return the same record without mutating state again.
/// `Clone` so the dispatch can hand back a fresh copy without holding the
/// state mutex across serialisation.
#[derive(Debug, Clone, PartialEq)]
pub struct StopRecord {
    pub exported_path: Option<String>,
    pub duration_sec: f64,
    pub question_count: u32,
}

impl From<&StopRecord> for StopResponse {
    fn from(rec: &StopRecord) -> Self {
        StopResponse {
            exported_path: rec.exported_path.clone(),
            duration_sec: rec.duration_sec,
            question_count: rec.question_count,
        }
    }
}

/// Error envelope for any RPC method. Wire shape `{"error":{"code":…,"message":…}}`.
/// Codes are the same closed set the MCP layer uses (`tools.ts:ERROR_CODES`)
/// where applicable; daemon-only errors (e.g. unknown method) get a daemon
/// prefix to avoid clashing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

/// Read-side + stop-record state for the RPC server. Kept inside an
/// `Arc<Mutex<…>>` so the `stop` mutation is atomic against concurrent
/// `status` reads. T-4.6 added `stopped` for idempotent stop replay.
#[derive(Debug, Default, Clone)]
pub struct RpcState {
    pub meetings: Vec<MeetingStatusEntry>,
    /// Map from `meetingId` → cached `StopRecord`. Populated on the first
    /// stop of a given meeting; subsequent stops return the cached record
    /// without mutating `meetings` (which already had the entry removed).
    pub stopped: HashMap<String, StopRecord>,
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("recovery failed: live listener responded at {0}")]
    StaleRecoveryRefused(PathBuf),
    #[error("malformed request line: {0}")]
    MalformedRequest(String),
}

/// Public entry point: bind the listener, serve until cancelled. The caller
/// owns the cancellation surface (drop the returned future, or wrap in
/// `tokio::select!` against a shutdown signal). Recovers stale socket files
/// per R-4 mitigation.
pub async fn serve(
    socket_path: &Path,
    state: Arc<Mutex<RpcState>>,
) -> Result<(), RpcError> {
    recover_stale_socket(socket_path).await?;
    let listener = UnixListener::bind(socket_path)?;
    loop {
        let (stream, _peer) = listener.accept().await?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, state).await {
                // We deliberately swallow per-connection errors here; the
                // listener stays up. A real entrypoint would forward to a
                // tracing subscriber; the lib leaves that decision to the
                // caller (logging is an out-of-process concern).
                let _ = err;
            }
        });
    }
}

/// Test-friendly variant: accepts ONE connection, dispatches it, and returns.
/// Used by the unit tests so we don't need a cancellation token. The bind +
/// recovery flow is the same shape as `serve` minus the loop.
pub async fn serve_once(
    socket_path: &Path,
    state: Arc<Mutex<RpcState>>,
) -> Result<(), RpcError> {
    recover_stale_socket(socket_path).await?;
    let listener = UnixListener::bind(socket_path)?;
    let (stream, _peer) = listener.accept().await?;
    handle_connection(stream, state).await?;
    Ok(())
}

/// Per-connection request/response loop. Reads one line, dispatches, writes
/// the response, closes. Forward-compat with `subscribe`: a future method
/// that keeps the connection open will own its own handler instead of
/// returning here.
async fn handle_connection(
    stream: UnixStream,
    state: Arc<Mutex<RpcState>>,
) -> Result<(), RpcError> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 {
        // peer closed without sending anything — nothing to do.
        return Ok(());
    }
    let response = dispatch(line.trim_end_matches('\n'), &state).await;
    write_half.write_all(response.as_bytes()).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await?;
    Ok(())
}

/// Dispatch a single request line to the per-method handler. Returns the
/// JSON-encoded response **without** trailing newline (the caller appends).
pub async fn dispatch(line: &str, state: &Arc<Mutex<RpcState>>) -> String {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        method: String,
        #[serde(default)]
        meeting_id: Option<String>,
    }

    let request: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(err) => {
            return serde_json::to_string(&ErrorResponse {
                error: ErrorBody {
                    code: "DaemonMalformedRequest".to_string(),
                    message: err.to_string(),
                },
            })
            .expect("error envelope serializes")
        }
    };

    match request.method.as_str() {
        "status" => handle_status(state, request.meeting_id.as_deref()).await,
        "stop" => match request.meeting_id.as_deref() {
            Some(id) => handle_stop(state, id).await,
            None => serde_json::to_string(&ErrorResponse {
                error: ErrorBody {
                    code: "DaemonMalformedRequest".to_string(),
                    message: "stop requires meetingId".to_string(),
                },
            })
            .expect("error envelope serializes"),
        },
        other => serde_json::to_string(&ErrorResponse {
            error: ErrorBody {
                code: "DaemonUnknownMethod".to_string(),
                message: format!("unknown method: {other}"),
            },
        })
        .expect("error envelope serializes"),
    }
}

async fn handle_status(state: &Arc<Mutex<RpcState>>, filter: Option<&str>) -> String {
    let state = state.lock().await;
    let meetings: Vec<MeetingStatusEntry> = match filter {
        Some(id) => state
            .meetings
            .iter()
            .filter(|m| m.id == id)
            .cloned()
            .collect(),
        None => state.meetings.clone(),
    };
    serde_json::to_string(&StatusResponse { meetings })
        .expect("status response serializes")
}

/// Dispatch the `stop` method.
///
/// Three branches, in priority order:
///   1. **Idempotent replay** — meetingId is in `stopped`: return the cached
///      `StopRecord` verbatim. No mutation. The Phase 4.x entrypoint that
///      wires Repo + STT must NOT re-flush on a replay (it has already done
///      so on the first stop).
///   2. **First stop** — meetingId is in `meetings`: remove the entry,
///      construct a `StopRecord` from the entry's recorded `uptime_sec` +
///      `question_count`, cache it in `stopped`, return it. The entrypoint's
///      side-effect callback (mark_meeting_ended on the Repo + STT flush) is
///      driven by the entrypoint at the call site that invokes `dispatch`,
///      not here — keeps the lib pure.
///   3. **Unknown id** — return `DaemonMeetingNotFound` typed error envelope.
///      The TS handler maps this to `MeetingNotFound`.
///
/// Note on `exported_path`: at the lib level we always return `None`. The
/// Phase 4.x entrypoint that owns settings + auto-export is responsible for
/// populating the field by reaching into `state.stopped` after the first stop
/// and replacing the record's `exported_path` with the resolved file path.
/// Idempotent replay then reflects that mutation.
async fn handle_stop(state: &Arc<Mutex<RpcState>>, meeting_id: &str) -> String {
    let mut state = state.lock().await;

    // Branch 1: idempotent replay.
    if let Some(rec) = state.stopped.get(meeting_id) {
        return serde_json::to_string(&StopResponse::from(rec))
            .expect("stop response serializes");
    }

    // Branch 2: first stop on a known active meeting.
    if let Some(idx) = state.meetings.iter().position(|m| m.id == meeting_id) {
        let entry = state.meetings.remove(idx);
        let rec = StopRecord {
            exported_path: None,
            duration_sec: entry.uptime_sec as f64,
            question_count: entry.question_count,
        };
        let response = StopResponse::from(&rec);
        state.stopped.insert(meeting_id.to_string(), rec);
        return serde_json::to_string(&response).expect("stop response serializes");
    }

    // Branch 3: unknown id.
    serde_json::to_string(&ErrorResponse {
        error: ErrorBody {
            code: "DaemonMeetingNotFound".to_string(),
            message: format!("no active meeting with id \"{meeting_id}\""),
        },
    })
    .expect("error envelope serializes")
}

/// Stale-socket recovery (R-4 mitigation).
///
/// Strategy:
///   1. If the path doesn't exist, return success — nothing to recover.
///   2. If the path exists, attempt a 200ms dial. If it succeeds, refuse
///      recovery (return `StaleRecoveryRefused`) so the operator must stop
///      the live daemon first.
///   3. If the dial fails inside the deadline (connect refused, EAGAIN, etc.),
///      `unlink` the path and return success.
///
/// The function is `pub` so tests can exercise both branches directly.
pub async fn recover_stale_socket(socket_path: &Path) -> Result<(), RpcError> {
    if !socket_path.exists() {
        return Ok(());
    }
    // Try a quick dial — if this succeeds, refuse recovery.
    let dial = timeout(
        Duration::from_millis(200),
        UnixStream::connect(socket_path),
    )
    .await;
    match dial {
        // Connect succeeded inside the timeout — live listener present.
        Ok(Ok(_stream)) => Err(RpcError::StaleRecoveryRefused(socket_path.to_path_buf())),
        // Connect failed (path dangling, or refused). Unlink + proceed.
        Ok(Err(_)) | Err(_) => {
            tokio::fs::remove_file(socket_path).await?;
            Ok(())
        }
    }
}

// --- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::tempdir;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    fn sample_state() -> RpcState {
        RpcState {
            meetings: vec![
                MeetingStatusEntry {
                    id: "m_1".into(),
                    pid: 4242,
                    started_at: 1_700_000_000_000,
                    stt_provider: "mlx".into(),
                    transcript_chunks: 12,
                    question_count: 1,
                    answer_count: 1,
                    uptime_sec: 18,
                },
                MeetingStatusEntry {
                    id: "m_2".into(),
                    pid: 4243,
                    started_at: 1_700_000_010_000,
                    stt_provider: "deepgram".into(),
                    transcript_chunks: 4,
                    question_count: 0,
                    answer_count: 0,
                    uptime_sec: 5,
                },
            ],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn dispatch_status_returns_full_list() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"status"}"#, &state).await;
        let parsed: StatusResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.meetings.len(), 2);
        assert_eq!(parsed.meetings[0].id, "m_1");
        assert_eq!(parsed.meetings[1].id, "m_2");
    }

    #[tokio::test]
    async fn dispatch_status_filters_by_meeting_id() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"status","meetingId":"m_2"}"#, &state).await;
        let parsed: StatusResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.meetings.len(), 1);
        assert_eq!(parsed.meetings[0].id, "m_2");
    }

    #[tokio::test]
    async fn dispatch_status_filter_returns_empty_when_no_match() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"status","meetingId":"nope"}"#, &state).await;
        let parsed: StatusResponse = serde_json::from_str(&body).expect("parse");
        assert!(parsed.meetings.is_empty());
    }

    #[tokio::test]
    async fn dispatch_unknown_method_returns_typed_error() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"frobnicate"}"#, &state).await;
        let parsed: ErrorResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.error.code, "DaemonUnknownMethod");
        assert!(parsed.error.message.contains("frobnicate"));
    }

    #[tokio::test]
    async fn dispatch_stop_returns_recorded_shape_for_known_meeting() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"stop","meetingId":"m_1"}"#, &state).await;
        let parsed: StopResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.duration_sec, 18.0);
        assert_eq!(parsed.question_count, 1);
        assert!(parsed.exported_path.is_none());
    }

    #[tokio::test]
    async fn dispatch_stop_is_idempotent_on_replay() {
        let state = Arc::new(Mutex::new(sample_state()));
        let first = dispatch(r#"{"method":"stop","meetingId":"m_1"}"#, &state).await;
        let second = dispatch(r#"{"method":"stop","meetingId":"m_1"}"#, &state).await;
        // Same wire payload on every replay.
        assert_eq!(first, second);
        let a: StopResponse = serde_json::from_str(&first).expect("parse 1");
        let b: StopResponse = serde_json::from_str(&second).expect("parse 2");
        assert_eq!(a, b);
        // Cached record exists exactly once.
        let st = state.lock().await;
        assert_eq!(st.stopped.len(), 1);
        assert!(st.stopped.contains_key("m_1"));
    }

    #[tokio::test]
    async fn dispatch_stop_removes_meeting_from_active_list() {
        let state = Arc::new(Mutex::new(sample_state()));
        // pre-stop: status returns 2 meetings.
        let pre = dispatch(r#"{"method":"status"}"#, &state).await;
        let pre_parsed: StatusResponse = serde_json::from_str(&pre).expect("parse");
        assert_eq!(pre_parsed.meetings.len(), 2);

        let _ = dispatch(r#"{"method":"stop","meetingId":"m_1"}"#, &state).await;

        // post-stop: status returns only m_2.
        let post = dispatch(r#"{"method":"status"}"#, &state).await;
        let post_parsed: StatusResponse = serde_json::from_str(&post).expect("parse");
        assert_eq!(post_parsed.meetings.len(), 1);
        assert_eq!(post_parsed.meetings[0].id, "m_2");
    }

    #[tokio::test]
    async fn dispatch_stop_unknown_id_returns_meeting_not_found() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"stop","meetingId":"m_ghost"}"#, &state).await;
        let parsed: ErrorResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.error.code, "DaemonMeetingNotFound");
        assert!(parsed.error.message.contains("m_ghost"));
    }

    #[tokio::test]
    async fn dispatch_stop_without_meeting_id_returns_malformed_request() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"stop"}"#, &state).await;
        let parsed: ErrorResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.error.code, "DaemonMalformedRequest");
        assert!(parsed.error.message.contains("meetingId"));
    }

    #[tokio::test]
    async fn dispatch_stop_after_status_filter_still_round_trips() {
        // Regression: status filter narrowing must not interfere with stop's
        // mutation of the same backing store.
        let state = Arc::new(Mutex::new(sample_state()));
        let _ = dispatch(r#"{"method":"status","meetingId":"m_2"}"#, &state).await;
        let stop = dispatch(r#"{"method":"stop","meetingId":"m_2"}"#, &state).await;
        let parsed: StopResponse = serde_json::from_str(&stop).expect("parse");
        assert_eq!(parsed.duration_sec, 5.0);
        assert_eq!(parsed.question_count, 0);
        // m_2 is now in `stopped` — re-stop returns identical envelope.
        let replay = dispatch(r#"{"method":"stop","meetingId":"m_2"}"#, &state).await;
        assert_eq!(stop, replay);
    }

    #[tokio::test]
    async fn dispatch_malformed_json_returns_typed_error() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch("not json", &state).await;
        let parsed: ErrorResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.error.code, "DaemonMalformedRequest");
    }

    #[tokio::test]
    async fn serve_once_round_trips_status() {
        let dir = tempdir().expect("tempdir");
        let sock = dir.path().join("rpc.sock");
        let state = Arc::new(Mutex::new(sample_state()));

        let server_path = sock.clone();
        let server_state = Arc::clone(&state);
        let server_handle = tokio::spawn(async move {
            serve_once(&server_path, server_state).await
        });

        // Give the listener a moment to bind.
        for _ in 0..20u32 {
            if sock.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(sock.exists(), "socket should bind in time");

        let mut client = UnixStream::connect(&sock).await.expect("connect");
        client
            .write_all(b"{\"method\":\"status\"}\n")
            .await
            .expect("write");
        client.flush().await.expect("flush");
        let (read_half, _w) = client.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read");
        let parsed: StatusResponse =
            serde_json::from_str(line.trim_end()).expect("parse");
        assert_eq!(parsed.meetings.len(), 2);

        server_handle.await.expect("server task").expect("server ok");
    }

    #[tokio::test]
    async fn recover_stale_socket_no_op_when_path_missing() {
        let dir = tempdir().expect("tempdir");
        let sock = dir.path().join("missing.sock");
        recover_stale_socket(&sock).await.expect("ok");
        assert!(!sock.exists());
    }

    #[tokio::test]
    async fn recover_stale_socket_unlinks_dead_file() {
        let dir = tempdir().expect("tempdir");
        let sock = dir.path().join("dead.sock");
        // Create a dangling file (NOT a socket — connect will fail). The
        // recovery path treats any connect failure as "dead" and unlinks.
        tokio::fs::write(&sock, b"junk").await.expect("write");
        assert!(sock.exists());
        recover_stale_socket(&sock).await.expect("recovery ok");
        assert!(!sock.exists(), "stale file should have been unlinked");
    }

    #[tokio::test]
    async fn recover_stale_socket_refuses_when_listener_alive() {
        let dir = tempdir().expect("tempdir");
        let sock = dir.path().join("live.sock");
        let _listener = UnixListener::bind(&sock).expect("bind");
        let result = recover_stale_socket(&sock).await;
        match result {
            Err(RpcError::StaleRecoveryRefused(_)) => {}
            other => panic!("expected StaleRecoveryRefused, got {other:?}"),
        }
        assert!(sock.exists(), "live socket file should NOT be unlinked");
    }
}
