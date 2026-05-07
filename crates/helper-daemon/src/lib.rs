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
// T-4.9 adds the dashboard iframe embed HTTP layer (`crate::embed_http`) + the
// scope-bounded token store (`crate::auth`) that gates every embed request.

pub mod auth;
pub mod bridge;
pub mod context;
pub mod embed_http;
pub mod mcp_rpc;
pub mod repo;
pub mod setup_install;

pub use auth::{AuthError, Clock as AuthClock, TokenStore, TOKEN_TTL};
pub use bridge::{
    BridgeError, EventBridge, EventSink, MeetingStateEvent, MeetingStatus, RecorderSink,
    TranscriptChunkEvent,
};
pub use context::{read_context_file, ContextError, ContextFile, ALLOWED_EXTENSIONS};
pub use embed_http::{
    router as embed_router, Clock as EmbedClock, EmbedEvent, EmbedState, TokenQuery,
    DEFAULT_ALLOWED_ORIGIN, DEFAULT_BIND_ADDR,
};
pub use mcp_rpc::{
    dispatch, recover_stale_socket, serve, serve_once, ErrorBody, ErrorResponse,
    MeetingStatusEntry, RpcError, RpcState, StatusResponse, StopRecord, StopResponse,
};
pub use repo::{
    AnswerRow, ContextSourceRow, MeetingRow, MeetingSnapshot, QuestionRow, Repo, RepoError,
    TranscriptChunkRow,
};
pub use setup_install::{
    build_manual_install_url, detect_brew_path, install_via_brew, FilesystemCheck, InstallError,
    InstallReport, ProcessOutput, ProcessRunner, RealFilesystem, RealProcessRunner,
    BREW_INSTALL_ARGS, BREW_PATH_APPLE_SILICON, BREW_PATH_INTEL, MANUAL_INSTALL_URL,
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
