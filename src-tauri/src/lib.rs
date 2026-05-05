// Phase 0 (T-0.8) shipped a `greet` IPC smoke command — kept as a regression baseline.
// Phase 1 T-1.2 added `ping` (Tauri command → helper-daemon::ping).
// Phase 1 T-1.6 adds `TauriEventSink` — the bridge sink that forwards
// `TranscriptChunkEvent` / `MeetingStateEvent` to the front-end via `app.emit(...)`.
// T-1.9 will construct a `TauriEventSink(app.handle())` inside the `start_meeting`
// command and feed it into `helper_daemon::EventBridge`.

use helper_daemon::{EventSink, MeetingStateEvent, TranscriptChunkEvent};
use tauri::{AppHandle, Emitter};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello {name}, from Tauri!")
}

#[tauri::command]
fn ping() -> String {
    helper_daemon::ping().to_string()
}

/// Bridge sink that forwards transcript + meeting events to the React UI.
/// Kept thin on purpose — T-1.6's logic lives in `helper_daemon::bridge`.
/// IPC errors are logged + swallowed so the meeting pump keeps running; Phase 1.x will
/// route them to a `meeting:error` event for UI surfacing.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_transcript_chunk(&self, payload: &TranscriptChunkEvent) {
        if let Err(err) = self.app.emit("transcript:chunk", payload) {
            eprintln!("transcript:chunk emit failed: {err}");
        }
    }

    fn emit_meeting_state(&self, payload: &MeetingStateEvent) {
        if let Err(err) = self.app.emit("meeting:state", payload) {
            eprintln!("meeting:state emit failed: {err}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet, ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_smoke() {
        assert_eq!(greet("World"), "Hello World, from Tauri!");
    }

    #[test]
    fn greet_handles_empty_name() {
        assert_eq!(greet(""), "Hello , from Tauri!");
    }

    #[test]
    fn ping_command_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn ping_delegates_to_daemon() {
        assert_eq!(ping(), helper_daemon::ping());
    }

    /// Compile-time assertion: `TauriEventSink` satisfies the `EventSink` trait bound.
    /// We don't construct an `AppHandle` here (mock_app would need `tauri = ["test"]`
    /// feature; not worth the build-cost in this iteration). T-1.13 wires the live
    /// runtime path; the type-level check guarantees the impl exists.
    #[test]
    fn tauri_event_sink_implements_event_sink() {
        fn assert_impls<T: EventSink>() {}
        assert_impls::<TauriEventSink>();
    }
}
