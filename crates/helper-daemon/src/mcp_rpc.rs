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
// Surface ownership: T-4.5 ships `status` + dispatch shape. T-4.6 will add
// `stop` (mutates Repo). T-4.9 will add `subscribe` (long-lived). The
// `RpcState` struct gathers the read-side state needed to answer queries —
// the Tauri-app entrypoint constructs a `Repo` + a meetings tracker and
// passes them in via `Arc`s.

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

/// Read-side state for the RPC server. Kept inside an `Arc<Mutex<…>>` so
/// future T-4.6 stop method can mutate without re-arch-ing the surface.
#[derive(Debug, Default, Clone)]
pub struct RpcState {
    pub meetings: Vec<MeetingStatusEntry>,
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
        "stop" => {
            // T-4.6 will own this; emit a typed unknown-method-shaped error
            // until then so the dispatch surface is stable.
            serde_json::to_string(&ErrorResponse {
                error: ErrorBody {
                    code: "DaemonNotImplemented".to_string(),
                    message: "stop method lands in T-4.6".to_string(),
                },
            })
            .expect("error envelope serializes")
        }
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
    async fn dispatch_stop_method_returns_t46_placeholder() {
        let state = Arc::new(Mutex::new(sample_state()));
        let body = dispatch(r#"{"method":"stop","meetingId":"m_1"}"#, &state).await;
        let parsed: ErrorResponse = serde_json::from_str(&body).expect("parse");
        assert_eq!(parsed.error.code, "DaemonNotImplemented");
        assert!(parsed.error.message.contains("T-4.6"));
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
