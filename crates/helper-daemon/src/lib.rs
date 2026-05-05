// Meeting Copilot helper-daemon — Phase 1 T-1.2 scaffold + T-1.6 event bridge + T-1.8 context loader
// + T-1.12 SQLite persistence.
// T-1.2 shipped a single liveness fn (`ping`) so Tauri IPC could be smoke-tested.
// T-1.6 adds the Tauri-free event bridge (`crate::bridge`) that pumps Chunker → STT → Sink.
// T-1.8 adds the context loader (`crate::context`) — single-file PRD/MD/TXT reader feeding ARCH §6.
// T-1.12 adds the local persistence layer (`crate::repo`) — rusqlite-backed Repo for ARCH §10
// schema (Meeting / TranscriptChunk / Question / Answer / ContextSource + junction).
// Surface stays in-process; out-of-process RPC framing per ARCH §8.2 deferred to Phase 1.x.

pub mod bridge;
pub mod context;
pub mod repo;

pub use bridge::{
    BridgeError, EventBridge, EventSink, MeetingStateEvent, MeetingStatus, RecorderSink,
    TranscriptChunkEvent,
};
pub use context::{read_context_file, ContextError, ContextFile, ALLOWED_EXTENSIONS};
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
