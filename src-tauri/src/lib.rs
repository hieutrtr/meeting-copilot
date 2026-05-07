// Phase 0 (T-0.8) shipped a `greet` IPC smoke command — kept as a regression baseline.
// Phase 1 T-1.2 added `ping` (Tauri command → helper-daemon::ping).
// Phase 1 T-1.6 adds `TauriEventSink` — the bridge sink that forwards
// `TranscriptChunkEvent` / `MeetingStateEvent` to the front-end via `app.emit(...)`.
// Phase 1 T-1.8 adds `read_context_file` — single-file PRD/MD/TXT loader (ARCH §6).
// Phase 1 T-1.13 adds `save_meeting` + `load_meetings` — Stop→persist + hydrate-on-open
// thin wrappers over `helper_daemon::Repo` (the schema lives in T-1.12).
// Live mic→bridge wiring (`start_meeting`) lands in `PHASE-BROWSER-TEST.md` step 4.

use helper_daemon::{
    ContextFile, EventSink, MeetingRow, MeetingSnapshot, MeetingStateEvent, Repo,
    TranscriptChunkEvent,
};
use tauri::{AppHandle, Emitter, Manager, State};

pub mod commands;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello {name}, from Tauri!")
}

#[tauri::command]
fn ping() -> String {
    helper_daemon::ping().to_string()
}

/// IPC entry-point for T-1.8. Reads a UTF-8 text file and returns its
/// `ContextFile` shape, or stringifies the typed `ContextError` for the UI.
/// Phase 1 keeps the error surface plain `String`; Phase 1.x can move to a
/// serde-tagged enum if T-1.10 needs machine-readable error variants.
#[tauri::command]
fn read_context_file(path: String) -> Result<ContextFile, String> {
    helper_daemon::read_context_file(&path).map_err(|err| err.to_string())
}

/// T-1.13 — opaque handle that holds the live `Repo`. Tauri's `tauri::State`
/// hands an `&RepoHandle` to commands so all callers share a single SQLite
/// connection (the Repo wraps the connection in a `Mutex` internally).
pub struct RepoHandle {
    repo: Repo,
}

impl RepoHandle {
    pub fn new(repo: Repo) -> Self {
        Self { repo }
    }

    pub fn repo(&self) -> &Repo {
        &self.repo
    }
}

/// Free function that drives the actual save. Keeping this separate from the
/// `#[tauri::command]` lets unit tests construct an in-memory `Repo` without
/// spinning up a Tauri runtime — same pattern as the T-1.8 split.
pub fn save_meeting_inner(repo: &Repo, snapshot: &MeetingSnapshot) -> Result<(), String> {
    repo.save_meeting_snapshot(snapshot)
        .map_err(|err| err.to_string())
}

pub fn load_meetings_inner(repo: &Repo) -> Result<Vec<MeetingRow>, String> {
    repo.list_meetings().map_err(|err| err.to_string())
}

#[tauri::command]
fn save_meeting(state: State<'_, RepoHandle>, snapshot: MeetingSnapshot) -> Result<(), String> {
    save_meeting_inner(state.repo(), &snapshot)
}

#[tauri::command]
fn load_meetings(state: State<'_, RepoHandle>) -> Result<Vec<MeetingRow>, String> {
    load_meetings_inner(state.repo())
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
        .setup(|app| {
            // T-1.13 — open the Repo at the OS-canonical app data dir. Phase 1
            // ships a single DB file ("meetings.db"); Phase 1.x adds migrations
            // + per-profile DBs.
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir failed: {e}"))?;
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("create_dir_all({}): {e}", dir.display()))?;
            let db_path = dir.join("meetings.db");
            let repo = Repo::open(&db_path)
                .map_err(|e| format!("Repo::open({}): {e}", db_path.display()))?;
            app.manage(RepoHandle::new(repo));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            read_context_file,
            save_meeting,
            load_meetings,
            commands::setup::setup_detect_blackhole,
            commands::setup::setup_install_blackhole,
            commands::setup::setup_configure_multi_output,
            commands::setup::setup_verify_capture,
        ])
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

    /// T-1.8 — the Tauri command wraps `helper_daemon::read_context_file` and
    /// stringifies its error so the UI can render it. Bypasses the IPC layer
    /// itself (which would need a runtime `AppHandle` + `tauri = ["test"]`).
    #[test]
    fn read_context_file_command_rejects_pdf() {
        let path = std::env::temp_dir().join("nope.pdf").to_string_lossy().to_string();
        let err = read_context_file(path).expect_err("pdf should reject");
        assert!(err.contains("unsupported extension"), "got: {err}");
    }

    #[test]
    fn read_context_file_command_round_trips_md() {
        use std::fs::File;
        use std::io::Write;

        let p = std::env::temp_dir().join("ctx_t18_tauri_smoke.md");
        {
            let mut f = File::create(&p).expect("tmp create");
            f.write_all(b"hello").expect("tmp write");
        }
        let result = read_context_file(p.to_string_lossy().to_string()).expect("ok");
        assert_eq!(result.content, "hello");
        assert_eq!(result.char_count, 5);
        assert_eq!(result.estimated_tokens, 2);
        let _ = std::fs::remove_file(&p);
    }

    /// T-1.13 E5 — `save_meeting_inner` round-trips a meeting snapshot via
    /// `Repo::save_meeting_snapshot` + `Repo::list_meetings`. Bypasses the
    /// `tauri::State` wrapper (same pattern as `read_context_file_command_*`).
    #[test]
    fn save_meeting_command_round_trips() {
        use helper_daemon::{
            AnswerRow, ContextSourceRow, MeetingRow, QuestionRow, TranscriptChunkRow,
        };
        let repo = Repo::open_in_memory().expect("open ok");
        let snap = MeetingSnapshot {
            meeting: MeetingRow {
                id: "m-cmd".into(),
                title: "Cmd round-trip".into(),
                started_at: 1,
                ended_at: Some(2),
                stt_provider: None,
                model: None,
                privacy_mode: None,
                status: "ended".into(),
            },
            chunks: vec![TranscriptChunkRow {
                id: "c-1".into(),
                meeting_id: "m-cmd".into(),
                text: "hi".into(),
                start_ts: 0,
                end_ts: 100,
                is_final: true,
                speaker: None,
                confidence: None,
            }],
            questions: vec![QuestionRow {
                id: "q-1".into(),
                meeting_id: "m-cmd".into(),
                text: "what?".into(),
                detected_ts: 50,
                method: "manual".into(),
                confidence: None,
                status: None,
            }],
            answer: Some(AnswerRow {
                id: "a-1".into(),
                question_id: "q-1".into(),
                text: "answer".into(),
                generated_at: 60,
                model: "claude-sonnet-4-6".into(),
                tokens_in: None,
                tokens_out: None,
                cached_ratio: None,
            }),
            context_source: Some(ContextSourceRow {
                id: "ctx-1".into(),
                path: "/tmp/PRD.md".into(),
                char_count: 100,
                estimated_tokens: 25,
                loaded_at: 0,
            }),
        };
        save_meeting_inner(&repo, &snap).expect("save");
        let listed = load_meetings_inner(&repo).expect("load");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "m-cmd");
    }

    /// T-1.13 E6 — `load_meetings_inner` returns rows ordered started_at DESC.
    #[test]
    fn load_meetings_command_returns_known_rows_ordered_desc() {
        use helper_daemon::MeetingRow;
        let repo = Repo::open_in_memory().expect("open ok");
        for (id, started) in [("old", 1_000), ("new", 9_000), ("mid", 5_000)] {
            repo.insert_meeting(&MeetingRow {
                id: id.into(),
                title: format!("{id}"),
                started_at: started,
                ended_at: None,
                stt_provider: None,
                model: None,
                privacy_mode: None,
                status: "ended".into(),
            })
            .expect("seed");
        }
        let listed = load_meetings_inner(&repo).expect("load");
        let ids: Vec<&str> = listed.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }
}
