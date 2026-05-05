// Meeting Copilot helper-daemon — Phase 1 T-1.2 scaffold + T-1.6 event bridge.
// T-1.2 shipped a single liveness fn (`ping`) so Tauri IPC could be smoke-tested.
// T-1.6 adds the Tauri-free event bridge (`crate::bridge`) that pumps Chunker → STT → Sink.
// Surface stays in-process; out-of-process RPC framing per ARCH §8.2 deferred to Phase 1.x.

pub mod bridge;

pub use bridge::{
    BridgeError, EventBridge, EventSink, MeetingStateEvent, MeetingStatus, RecorderSink,
    TranscriptChunkEvent,
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
