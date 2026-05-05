// Tauri event bridge — Phase 1 T-1.6.
// Pumps `Chunker::try_next_chunk()` → `SttProvider::transcribe_chunk()` → an `EventSink`
// that emits two Tauri events: `transcript:chunk` and `meeting:state`. The `EventSink`
// trait abstracts away the AppHandle so this crate stays Tauri-free; src-tauri owns the
// `TauriEventSink` adapter, T-1.9 owns the live mic→bridge wiring.
//
// Schema parity contract: `TranscriptChunkEvent` + `MeetingStateEvent` use
// `serde(rename_all = "camelCase")` so the JSON shape mirrors `shared/types.ts`
// (`TranscriptChunk` + `MeetingStatus`) byte-for-byte. The canonical literal lives in
// `shared/fixtures/transcript_chunk.sample.json` — both Rust + Vitest tests read it.

use std::fmt;
use std::sync::Mutex;

use audio_capture::Chunker;
use serde::{Deserialize, Serialize};
use stt_mlx::{SttError, SttProvider};
use thiserror::Error;

/// Payload shape for the `transcript:chunk` event. Mirrors `shared/types.ts:TranscriptChunk`.
/// `id` is `<meeting_id>-<chunk_idx>`; `meeting_id` is supplied by the bridge constructor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptChunkEvent {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub start_ts: u64,
    pub end_ts: u64,
    pub is_final: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub confidence: Option<f32>,
}

/// Payload shape for the `meeting:state` event. Mirrors `shared/types.ts:MeetingStatus` +
/// the `meetingId` / `atTs` envelope T-1.9 will own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStateEvent {
    pub meeting_id: String,
    pub status: String,
    pub at_ts: u64,
}

/// Lifecycle states for a meeting. The TS contract (`shared/types.ts:MeetingStatus`) is the
/// lowercase string union `"idle" | "active" | "ended"`; the `Display` impl produces those
/// exact strings so `format!("{}", status)` round-trips into the JSON payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingStatus {
    Idle,
    Active,
    Ended,
}

impl fmt::Display for MeetingStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            MeetingStatus::Idle => "idle",
            MeetingStatus::Active => "active",
            MeetingStatus::Ended => "ended",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("stt error: {0}")]
    Stt(#[from] SttError),

    #[error("sink error: {0}")]
    Sink(String),
}

/// Object-safe sink for Tauri events. `Send + Sync` so the bridge can be driven from a
/// `tokio::task::spawn_blocking` worker (T-1.9). The two methods are infallible from the
/// caller's perspective; production impls log + swallow IPC errors so the meeting loop
/// keeps pumping.
pub trait EventSink: Send + Sync {
    fn emit_transcript_chunk(&self, payload: &TranscriptChunkEvent);
    fn emit_meeting_state(&self, payload: &MeetingStateEvent);
}

/// In-process recorder used by the bridge tests + (later) by T-1.9 happy-path tests.
/// Captures every emitted event into a `Mutex<Vec<…>>` so assertions can read them back
/// in order.
#[derive(Debug, Default)]
pub struct RecorderSink {
    pub transcripts: Mutex<Vec<TranscriptChunkEvent>>,
    pub states: Mutex<Vec<MeetingStateEvent>>,
}

impl RecorderSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn transcripts(&self) -> Vec<TranscriptChunkEvent> {
        self.transcripts.lock().expect("recorder lock").clone()
    }

    pub fn states(&self) -> Vec<MeetingStateEvent> {
        self.states.lock().expect("recorder lock").clone()
    }
}

impl EventSink for RecorderSink {
    fn emit_transcript_chunk(&self, payload: &TranscriptChunkEvent) {
        self.transcripts
            .lock()
            .expect("recorder lock")
            .push(payload.clone());
    }

    fn emit_meeting_state(&self, payload: &MeetingStateEvent) {
        self.states
            .lock()
            .expect("recorder lock")
            .push(payload.clone());
    }
}

/// Drains a `Chunker` through an `SttProvider` and emits one `transcript:chunk` event per
/// resulting `SttSegment`. Holds a `chunk_idx` counter so consecutive `pump_one` calls
/// produce monotonically increasing event IDs (`<meeting_id>-<n>`).
pub struct EventBridge {
    meeting_id: String,
    chunk_idx: u64,
}

impl EventBridge {
    pub fn new(meeting_id: impl Into<String>) -> Self {
        Self {
            meeting_id: meeting_id.into(),
            chunk_idx: 0,
        }
    }

    pub fn meeting_id(&self) -> &str {
        &self.meeting_id
    }

    /// Drain every available window from `chunker`, transcribe each via `stt`, emit one event
    /// per resulting segment, and return the count of emitted events. Returns `Err` on the
    /// first STT failure (caller's responsibility to surface a `meeting:stt_error` — Phase 1.x).
    pub fn pump_one(
        &mut self,
        chunker: &mut Chunker,
        stt: &mut dyn SttProvider,
        sink: &dyn EventSink,
    ) -> Result<usize, BridgeError> {
        let mut emitted = 0usize;
        while let Some(chunk) = chunker.try_next_chunk() {
            let segments = stt.transcribe_chunk(&chunk)?;
            for seg in segments {
                let id = format!("{}-{}", self.meeting_id, self.chunk_idx);
                self.chunk_idx = self.chunk_idx.saturating_add(1);
                let event = TranscriptChunkEvent {
                    id,
                    meeting_id: self.meeting_id.clone(),
                    text: seg.text,
                    start_ts: seg.start_ts_ms,
                    end_ts: seg.end_ts_ms,
                    is_final: seg.is_final,
                    speaker: None,
                    confidence: seg.confidence,
                };
                sink.emit_transcript_chunk(&event);
                emitted += 1;
            }
        }
        Ok(emitted)
    }

    /// Emit a `meeting:state` event. The state machine (T-1.9) drives this; the bridge just
    /// holds the meeting_id and a status→string mapping (`MeetingStatus::Display`).
    pub fn emit_state(&self, sink: &dyn EventSink, status: MeetingStatus, at_ts: u64) {
        let event = MeetingStateEvent {
            meeting_id: self.meeting_id.clone(),
            status: status.to_string(),
            at_ts,
        };
        sink.emit_meeting_state(&event);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use audio_capture::ChunkerConfig;
    use stt_mlx::FakeStt;

    /// Canonical event JSON — kept in lockstep with `shared/fixtures/transcript_chunk.sample.json`.
    /// If this literal drifts from the fixture file, both this test and the Vitest schema-parity
    /// test fail on the next run.
    const SAMPLE_TRANSCRIPT_JSON: &str = include_str!(
        "../../../shared/fixtures/transcript_chunk.sample.json"
    );

    #[test]
    fn recorder_sink_captures_emitted_events() {
        let sink = RecorderSink::new();
        let event = TranscriptChunkEvent {
            id: "m1-0".into(),
            meeting_id: "m1".into(),
            text: "Hello world.".into(),
            start_ts: 0,
            end_ts: 2_000,
            is_final: true,
            speaker: None,
            confidence: Some(1.0),
        };
        sink.emit_transcript_chunk(&event);

        let captured = sink.transcripts();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0], event);
        assert!(sink.states().is_empty());
    }

    #[test]
    fn event_bridge_pumps_chunker_through_stt_to_sink() {
        // 5 s synthetic mono PCM @ 16 kHz → Chunker drains exactly 2 windows of 2 s.
        let mut chunker = Chunker::new(ChunkerConfig::default());
        chunker.push(&vec![0.0_f32; 80_000], 16_000, 1);

        let mut stt = FakeStt::new("hello");
        let sink = RecorderSink::new();
        let mut bridge = EventBridge::new("m1");

        let emitted = bridge
            .pump_one(&mut chunker, &mut stt, &sink)
            .expect("pump ok");
        assert_eq!(emitted, 2);

        let events = sink.transcripts();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, "m1-0");
        assert_eq!(events[0].meeting_id, "m1");
        assert_eq!(events[0].start_ts, 0);
        assert_eq!(events[0].end_ts, 2_000);
        assert_eq!(events[0].text, "hello");
        assert!(events[0].is_final);
        assert_eq!(events[0].confidence, Some(1.0));

        assert_eq!(events[1].id, "m1-1");
        assert_eq!(events[1].start_ts, 2_000);
        assert_eq!(events[1].end_ts, 4_000);
    }

    #[test]
    fn event_bridge_increments_chunk_idx_across_pump_calls() {
        let mut bridge = EventBridge::new("m1");
        let mut stt = FakeStt::new("x");
        let sink = RecorderSink::new();

        for _ in 0..2 {
            let mut chunker = Chunker::new(ChunkerConfig::default());
            chunker.push(&vec![0.0_f32; 80_000], 16_000, 1);
            bridge.pump_one(&mut chunker, &mut stt, &sink).expect("pump");
        }

        let events = sink.transcripts();
        assert_eq!(events.len(), 4);
        let ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["m1-0", "m1-1", "m1-2", "m1-3"]);
    }

    #[test]
    fn event_bridge_serialises_to_canonical_json() {
        let event = TranscriptChunkEvent {
            id: "m1-0".into(),
            meeting_id: "m1".into(),
            text: "Hello world.".into(),
            start_ts: 0,
            end_ts: 2_000,
            is_final: true,
            speaker: None,
            confidence: Some(1.0),
        };

        let actual = serde_json::to_value(&event).expect("serialise");
        let expected: serde_json::Value =
            serde_json::from_str(SAMPLE_TRANSCRIPT_JSON).expect("fixture parse");

        assert_eq!(actual, expected, "serialised event must match shared fixture");

        // Round-trip parity: deserialising the fixture yields the same struct.
        let parsed: TranscriptChunkEvent =
            serde_json::from_str(SAMPLE_TRANSCRIPT_JSON).expect("fixture decode");
        assert_eq!(parsed, event);
    }

    #[test]
    fn event_bridge_emits_state_transitions() {
        let bridge = EventBridge::new("m1");
        let sink = RecorderSink::new();

        bridge.emit_state(&sink, MeetingStatus::Active, 1_234);
        bridge.emit_state(&sink, MeetingStatus::Ended, 5_678);

        let states = sink.states();
        assert_eq!(states.len(), 2);
        assert_eq!(
            states[0],
            MeetingStateEvent {
                meeting_id: "m1".into(),
                status: "active".into(),
                at_ts: 1_234,
            }
        );
        assert_eq!(states[1].status, "ended");
        assert_eq!(states[1].at_ts, 5_678);
        assert!(sink.transcripts().is_empty());
    }

    #[test]
    fn meeting_status_display_matches_ts_contract() {
        assert_eq!(MeetingStatus::Idle.to_string(), "idle");
        assert_eq!(MeetingStatus::Active.to_string(), "active");
        assert_eq!(MeetingStatus::Ended.to_string(), "ended");
    }
}
