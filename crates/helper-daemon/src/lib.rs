// Meeting Copilot helper-daemon — Phase 1 T-1.2 scaffold + T-1.6 event bridge + T-1.8 context loader
// + T-1.12 SQLite persistence + Phase 4 T-4.5 MCP-side UDS RPC server.
// T-1.2 shipped a single liveness fn (`ping`) so Tauri IPC could be smoke-tested.
// T-1.6 adds the Tauri-free event bridge (`crate::bridge`) that pumps Chunker → STT → Sink.
// T-1.8 adds the context loader (`crate::context`) — single-file PRD/MD/TXT reader feeding ARCH §6.
// T-1.12 adds the local persistence layer (`crate::repo`) — rusqlite-backed Repo for ARCH §10
// schema (Meeting / TranscriptChunk / Question / Answer / ContextSource + junction).
// T-4.5 adds the out-of-process RPC surface (`crate::mcp_rpc`) — line-delimited JSON over UDS;
// the Tauri app's binary entrypoint in Phase 4.x wires `serve` into a tokio runtime.
// T-4.6 fills in the `stop` method on the same RPC surface (idempotent flush) + adds
// `Repo::mark_meeting_ended` for the entrypoint's persist-on-shutdown side-effect.

pub mod bridge;
pub mod context;
pub mod mcp_rpc;
pub mod repo;

pub use bridge::{
    BridgeError, EventBridge, EventSink, MeetingStateEvent, MeetingStatus, RecorderSink,
    TranscriptChunkEvent,
};
pub use context::{read_context_file, ContextError, ContextFile, ALLOWED_EXTENSIONS};
pub use mcp_rpc::{
    dispatch, recover_stale_socket, serve, serve_once, ErrorBody, ErrorResponse,
    MeetingStatusEntry, RpcError, RpcState, StatusResponse, StopRecord, StopResponse,
};
pub use repo::{
    AnswerRow, ContextSourceRow, MeetingRow, MeetingSnapshot, QuestionRow, Repo, RepoError,
    TranscriptChunkRow,
};

pub fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
