// Phase 1 T-1.12 — SQLite persistence layer.
//
// Owns the data-model half of ARCH §10. Schema (idempotent DDL) is created on
// `Repo::open`; row DTOs use `serde(rename_all = "camelCase")` so they serialise
// to the same JSON shape `shared/types.ts` declares (`MeetingSession`,
// `TranscriptChunk`, `Question`, `Answer`, `ContextSource`).
//
// Stack pick: `rusqlite` (vendored libsqlite3 via the `bundled` feature). The
// alternative — `tauri-plugin-sql` — was not chosen because the cargo-side
// integration test (per INDEX §"TDD per task") requires DDL-level assertions
// that the plugin's JS shim does not expose. Plugin-sql lands Phase 1.x if
// the React side wants to query the DB directly.
//
// Surface is in-process only. T-1.13 wires the Tauri command bindings
// (`save_meeting` / `load_meeting`) on top of this Repo.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors returned from `Repo` operations. Wraps `rusqlite::Error` so callers
/// can distinguish constraint violations from unrelated SQL errors. Phase 1.x
/// migrations may add an `Other(String)` variant once a non-rusqlite invariant
/// needs to surface (e.g. a schema-version mismatch caught before DDL runs).
#[derive(Debug, Error)]
pub enum RepoError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Top-level meeting record. Mirrors `shared/types.ts:MeetingSession`.
/// `status` is the lowercase string union "idle" | "active" | "ended" — Rust
/// stores it as a free-form `String` to keep the DTO layer dumb; the
/// `bridge.rs:MeetingStatus` enum is the source of truth for valid values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRow {
    pub id: String,
    pub title: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stt_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub privacy_mode: Option<String>,
    pub status: String,
}

/// Transcript chunk row. Mirrors `shared/types.ts:TranscriptChunk`.
/// `is_final` is stored as INTEGER (0/1) by SQLite but exposed as `bool` here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptChunkRow {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub is_final: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub confidence: Option<f32>,
}

/// Question row. Mirrors `shared/types.ts:Question`.
/// `method` is "auto" | "manual"; today's UI only emits "manual" (T-1.9).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRow {
    pub id: String,
    pub meeting_id: String,
    pub text: String,
    pub detected_ts: i64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<String>,
}

/// Answer row. Mirrors `shared/types.ts:Answer`.
/// `cached_ratio` is the `cacheReadRatio` from `src/llm/pricing.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRow {
    pub id: String,
    pub question_id: String,
    pub text: String,
    pub generated_at: i64,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tokens_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tokens_out: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cached_ratio: Option<f64>,
}

/// Context source row. Mirrors `shared/types.ts:ContextSource`.
/// The N:N junction (`meeting_context`) is owned by `Repo::link_context_to_meeting`;
/// the row itself is meeting-agnostic (a PRD can be reused across meetings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSourceRow {
    pub id: String,
    pub path: String,
    pub char_count: i64,
    pub estimated_tokens: i64,
    pub loaded_at: i64,
}

/// Idempotent schema DDL. Re-running on an existing database is a no-op
/// (the `IF NOT EXISTS` clauses + the absence of `ALTER TABLE` here).
/// First migration (Phase 1.x) lands when this DDL needs to evolve.
const SCHEMA_DDL: &str = "
CREATE TABLE IF NOT EXISTS meetings (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    stt_provider  TEXT,
    model         TEXT,
    privacy_mode  TEXT,
    status        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
    id          TEXT PRIMARY KEY,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    is_final    INTEGER NOT NULL,
    speaker     TEXT,
    confidence  REAL
);

CREATE TABLE IF NOT EXISTS questions (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    detected_ts  INTEGER NOT NULL,
    method       TEXT NOT NULL,
    confidence   REAL,
    status       TEXT
);

CREATE TABLE IF NOT EXISTS answers (
    id            TEXT PRIMARY KEY,
    question_id   TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
    text          TEXT NOT NULL,
    generated_at  INTEGER NOT NULL,
    model         TEXT NOT NULL,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cached_ratio  REAL
);

CREATE TABLE IF NOT EXISTS context_sources (
    id                TEXT PRIMARY KEY,
    path              TEXT NOT NULL,
    char_count        INTEGER NOT NULL,
    estimated_tokens  INTEGER NOT NULL,
    loaded_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_context (
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    context_id  TEXT NOT NULL REFERENCES context_sources(id) ON DELETE CASCADE,
    PRIMARY KEY (meeting_id, context_id)
);
";

/// Single-process SQLite repo. Wraps `Connection` in a `Mutex` because
/// `rusqlite::Connection` is `!Sync` by default; the Mutex is the rusqlite-blessed
/// pattern for shared-across-threads use (per the rusqlite README "Concurrency"
/// section). All public methods take `&self` so the Mutex stays internal.
pub struct Repo {
    conn: Mutex<Connection>,
}

impl Repo {
    /// Open (or create) a SQLite database at `path`. Runs DDL idempotently and
    /// enables WAL journal mode + foreign-key enforcement.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, RepoError> {
        let conn = Connection::open(path.as_ref())?;
        Self::init(conn)
    }

    /// In-memory variant for unit tests that don't need disk round-trip.
    /// SQLite forces journal_mode = "memory" here, so DB-R2's WAL assertion
    /// only applies to the file-backed path.
    pub fn open_in_memory() -> Result<Self, RepoError> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, RepoError> {
        // FK enforcement is per-connection (defaults to OFF) so we set it before
        // any DDL — the REFERENCES clauses are then honoured immediately.
        // WAL is a no-op on `:memory:` (SQLite reports "memory" instead) — that's
        // fine; DB-R2's WAL assertion runs against the file-backed path only.
        // execute_batch swallows the row PRAGMA journal_mode emits, which is
        // exactly what we want here (the DB-R2 test queries the pragma directly).
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(SCHEMA_DDL)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // PoisonError → recover the inner; the connection itself doesn't carry
        // mutable invariant state, just the SQLite handle. This is safer than
        // unwrap() (which would propagate the panic) per AC-10.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -- inserts ----------------------------------------------------------------

    pub fn insert_meeting(&self, m: &MeetingRow) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO meetings
                (id, title, started_at, ended_at, stt_provider, model, privacy_mode, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                m.id,
                m.title,
                m.started_at,
                m.ended_at,
                m.stt_provider,
                m.model,
                m.privacy_mode,
                m.status,
            ],
        )?;
        Ok(())
    }

    pub fn insert_transcript_chunk(&self, c: &TranscriptChunkRow) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO transcript_chunks
                (id, meeting_id, text, start_ts, end_ts, is_final, speaker, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                c.id,
                c.meeting_id,
                c.text,
                c.start_ts,
                c.end_ts,
                c.is_final as i32,
                c.speaker,
                c.confidence,
            ],
        )?;
        Ok(())
    }

    pub fn insert_question(&self, q: &QuestionRow) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO questions
                (id, meeting_id, text, detected_ts, method, confidence, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                q.id,
                q.meeting_id,
                q.text,
                q.detected_ts,
                q.method,
                q.confidence,
                q.status,
            ],
        )?;
        Ok(())
    }

    pub fn insert_answer(&self, a: &AnswerRow) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO answers
                (id, question_id, text, generated_at, model, tokens_in, tokens_out, cached_ratio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                a.id,
                a.question_id,
                a.text,
                a.generated_at,
                a.model,
                a.tokens_in,
                a.tokens_out,
                a.cached_ratio,
            ],
        )?;
        Ok(())
    }

    pub fn insert_context_source(&self, c: &ContextSourceRow) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO context_sources
                (id, path, char_count, estimated_tokens, loaded_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                c.id,
                c.path,
                c.char_count,
                c.estimated_tokens,
                c.loaded_at,
            ],
        )?;
        Ok(())
    }

    /// `INSERT OR IGNORE` so re-linking the same pair is a no-op (DB-R6).
    pub fn link_context_to_meeting(
        &self,
        meeting_id: &str,
        context_id: &str,
    ) -> Result<(), RepoError> {
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO meeting_context (meeting_id, context_id)
             VALUES (?1, ?2)",
            params![meeting_id, context_id],
        )?;
        Ok(())
    }

    // -- reads ------------------------------------------------------------------

    pub fn list_meetings(&self) -> Result<Vec<MeetingRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, stt_provider, model, privacy_mode, status
             FROM meetings
             ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MeetingRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    started_at: row.get(2)?,
                    ended_at: row.get(3)?,
                    stt_provider: row.get(4)?,
                    model: row.get(5)?,
                    privacy_mode: row.get(6)?,
                    status: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_meeting(&self, id: &str) -> Result<Option<MeetingRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, stt_provider, model, privacy_mode, status
             FROM meetings WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], |row| {
                Ok(MeetingRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    started_at: row.get(2)?,
                    ended_at: row.get(3)?,
                    stt_provider: row.get(4)?,
                    model: row.get(5)?,
                    privacy_mode: row.get(6)?,
                    status: row.get(7)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    pub fn list_chunks(&self, meeting_id: &str) -> Result<Vec<TranscriptChunkRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, text, start_ts, end_ts, is_final, speaker, confidence
             FROM transcript_chunks
             WHERE meeting_id = ?1
             ORDER BY start_ts ASC",
        )?;
        let rows = stmt
            .query_map(params![meeting_id], |row| {
                let is_final_i: i64 = row.get(5)?;
                Ok(TranscriptChunkRow {
                    id: row.get(0)?,
                    meeting_id: row.get(1)?,
                    text: row.get(2)?,
                    start_ts: row.get(3)?,
                    end_ts: row.get(4)?,
                    is_final: is_final_i != 0,
                    speaker: row.get(6)?,
                    confidence: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_questions(&self, meeting_id: &str) -> Result<Vec<QuestionRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, text, detected_ts, method, confidence, status
             FROM questions
             WHERE meeting_id = ?1
             ORDER BY detected_ts ASC",
        )?;
        let rows = stmt
            .query_map(params![meeting_id], |row| {
                Ok(QuestionRow {
                    id: row.get(0)?,
                    meeting_id: row.get(1)?,
                    text: row.get(2)?,
                    detected_ts: row.get(3)?,
                    method: row.get(4)?,
                    confidence: row.get(5)?,
                    status: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_answer(&self, question_id: &str) -> Result<Option<AnswerRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, question_id, text, generated_at, model, tokens_in, tokens_out, cached_ratio
             FROM answers WHERE question_id = ?1",
        )?;
        let row = stmt
            .query_row(params![question_id], |row| {
                Ok(AnswerRow {
                    id: row.get(0)?,
                    question_id: row.get(1)?,
                    text: row.get(2)?,
                    generated_at: row.get(3)?,
                    model: row.get(4)?,
                    tokens_in: row.get(5)?,
                    tokens_out: row.get(6)?,
                    cached_ratio: row.get(7)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    pub fn get_context_source(&self, id: &str) -> Result<Option<ContextSourceRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, path, char_count, estimated_tokens, loaded_at
             FROM context_sources WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], |row| {
                Ok(ContextSourceRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    char_count: row.get(2)?,
                    estimated_tokens: row.get(3)?,
                    loaded_at: row.get(4)?,
                })
            })
            .optional()?;
        Ok(row)
    }

    pub fn list_contexts_for_meeting(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<ContextSourceRow>, RepoError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT cs.id, cs.path, cs.char_count, cs.estimated_tokens, cs.loaded_at
             FROM context_sources cs
             INNER JOIN meeting_context mc ON mc.context_id = cs.id
             WHERE mc.meeting_id = ?1
             ORDER BY cs.loaded_at ASC",
        )?;
        let rows = stmt
            .query_map(params![meeting_id], |row| {
                Ok(ContextSourceRow {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    char_count: row.get(2)?,
                    estimated_tokens: row.get(3)?,
                    loaded_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Drop-guarded temp DB path. Cleans `.db`, `.db-wal`, `.db-shm` on Drop so
    /// concurrent test runs don't pollute the temp dir or step on each other.
    struct TmpDb {
        path: PathBuf,
    }

    impl TmpDb {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("repo_t112_{}_{}.db", pid, n));
            // Defensive: clean any prior siblings before the test starts.
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("db-wal"));
            let _ = std::fs::remove_file(path.with_extension("db-shm"));
            TmpDb { path }
        }
    }

    impl Drop for TmpDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
            let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
        }
    }

    fn sample_meeting(id: &str) -> MeetingRow {
        MeetingRow {
            id: id.to_string(),
            title: "Roadmap sync".to_string(),
            started_at: 1_700_000_000_000,
            ended_at: Some(1_700_000_900_000),
            stt_provider: Some("mlx-whisper".to_string()),
            model: Some("medium".to_string()),
            privacy_mode: Some("local-only".to_string()),
            status: "ended".to_string(),
        }
    }

    fn sample_chunk(meeting: &str, idx: u32) -> TranscriptChunkRow {
        TranscriptChunkRow {
            id: format!("{}-{}", meeting, idx),
            meeting_id: meeting.to_string(),
            text: format!("chunk number {idx}"),
            start_ts: (idx as i64) * 1000,
            end_ts: (idx as i64) * 1000 + 800,
            is_final: true,
            speaker: Some("self".to_string()),
            confidence: Some(0.92),
        }
    }

    fn sample_question(meeting: &str) -> QuestionRow {
        QuestionRow {
            id: "q-1".to_string(),
            meeting_id: meeting.to_string(),
            text: "What is the projected ARR by Q4?".to_string(),
            detected_ts: 1_700_000_120_000,
            method: "manual".to_string(),
            confidence: None,
            status: Some("answered".to_string()),
        }
    }

    fn sample_answer(question: &str) -> AnswerRow {
        AnswerRow {
            id: "a-1".to_string(),
            question_id: question.to_string(),
            text: "Per the PRD §3.1, target ARR is $4.2M by Q4.".to_string(),
            generated_at: 1_700_000_125_000,
            model: "claude-sonnet-4-6".to_string(),
            tokens_in: Some(22_010),
            tokens_out: Some(48),
            cached_ratio: Some(0.997),
        }
    }

    fn sample_context() -> ContextSourceRow {
        ContextSourceRow {
            id: "ctx-1".to_string(),
            path: "/home/user/PRD.md".to_string(),
            char_count: 18_204,
            estimated_tokens: 4_551,
            loaded_at: 1_700_000_000_000,
        }
    }

    // DB-R1: open creates schema (all 6 tables present).
    #[test]
    fn open_creates_schema() {
        let tmp = TmpDb::new();
        let _repo = Repo::open(&tmp.path).expect("open ok");
        // Re-open the connection directly to verify schema persisted to disk.
        let conn = Connection::open(&tmp.path).expect("re-open conn");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
            .expect("prepare");
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        for required in [
            "answers",
            "context_sources",
            "meeting_context",
            "meetings",
            "questions",
            "transcript_chunks",
        ] {
            assert!(
                names.iter().any(|n| n == required),
                "missing table {required}: got {names:?}"
            );
        }
    }

    // DB-R2: file-backed Repo enables WAL + foreign keys.
    #[test]
    fn open_enables_wal_and_foreign_keys() {
        let tmp = TmpDb::new();
        let repo = Repo::open(&tmp.path).expect("open ok");
        let conn = repo.lock();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        assert_eq!(fk, 1);
    }

    // DB-R2 (in-memory variant): journal_mode is "memory" but FK still ON.
    #[test]
    fn open_in_memory_enables_foreign_keys() {
        let repo = Repo::open_in_memory().expect("open ok");
        let conn = repo.lock();
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        assert_eq!(fk, 1);
    }

    // DB-R3: meeting insert + readback round-trip (every field).
    #[test]
    fn meeting_insert_and_get_round_trip() {
        let repo = Repo::open_in_memory().expect("open ok");
        let m = sample_meeting("m-1");
        repo.insert_meeting(&m).expect("insert");
        let got = repo.get_meeting("m-1").expect("get").expect("present");
        assert_eq!(got, m);
        // Missing id → None.
        assert_eq!(repo.get_meeting("ghost").expect("get"), None);
    }

    // DB-R4: chunks list ordered by start_ts ASC regardless of insert order.
    #[test]
    fn chunks_list_ordered_by_start_ts() {
        let repo = Repo::open_in_memory().expect("open ok");
        repo.insert_meeting(&sample_meeting("m-1")).expect("m");
        // Insert shuffled (5, 2, 8, 0, 3, 9, 1, 7, 4, 6).
        for idx in [5, 2, 8, 0, 3, 9, 1, 7, 4, 6] {
            repo.insert_transcript_chunk(&sample_chunk("m-1", idx))
                .expect("insert chunk");
        }
        let chunks = repo.list_chunks("m-1").expect("list");
        assert_eq!(chunks.len(), 10);
        let ts: Vec<i64> = chunks.iter().map(|c| c.start_ts).collect();
        assert_eq!(ts, (0..10i64).map(|i| i * 1000).collect::<Vec<_>>());
        // Field round-trip on the first chunk (covers is_final / speaker / confidence).
        assert_eq!(chunks[0], sample_chunk("m-1", 0));
    }

    // DB-R5: question + answer 1:1 round-trip.
    #[test]
    fn question_and_answer_round_trip() {
        let repo = Repo::open_in_memory().expect("open ok");
        repo.insert_meeting(&sample_meeting("m-1")).expect("m");
        repo.insert_question(&sample_question("m-1")).expect("q");
        repo.insert_answer(&sample_answer("q-1")).expect("a");
        let qs = repo.list_questions("m-1").expect("list q");
        assert_eq!(qs, vec![sample_question("m-1")]);
        let a = repo.get_answer("q-1").expect("get a").expect("present");
        assert_eq!(a, sample_answer("q-1"));
        assert_eq!(repo.get_answer("ghost").expect("get a"), None);
    }

    // DB-R6: context source insert + link, idempotent re-link.
    #[test]
    fn context_link_is_idempotent() {
        let repo = Repo::open_in_memory().expect("open ok");
        repo.insert_meeting(&sample_meeting("m-1")).expect("m");
        repo.insert_context_source(&sample_context()).expect("ctx");
        repo.link_context_to_meeting("m-1", "ctx-1").expect("link 1");
        // Re-link same pair: must NOT error (INSERT OR IGNORE).
        repo.link_context_to_meeting("m-1", "ctx-1").expect("link 2");
        let ctxs = repo.list_contexts_for_meeting("m-1").expect("list");
        assert_eq!(ctxs.len(), 1);
        assert_eq!(ctxs[0], sample_context());
    }

    // DB-R7 (HEADLINE AC-6): full round-trip across Repo lifecycles.
    #[test]
    fn full_round_trip_across_reopen() {
        let tmp = TmpDb::new();

        {
            let repo = Repo::open(&tmp.path).expect("open 1");
            repo.insert_meeting(&sample_meeting("m-1")).expect("m");
            repo.insert_context_source(&sample_context()).expect("ctx");
            repo.link_context_to_meeting("m-1", "ctx-1").expect("link");
            for idx in 0..10 {
                repo.insert_transcript_chunk(&sample_chunk("m-1", idx))
                    .expect("chunk");
            }
            repo.insert_question(&sample_question("m-1")).expect("q");
            repo.insert_answer(&sample_answer("q-1")).expect("a");
            // `repo` drops here → connection closed.
        }

        // Re-open at the same path.
        let repo = Repo::open(&tmp.path).expect("re-open");
        let meetings = repo.list_meetings().expect("list meetings");
        assert_eq!(meetings, vec![sample_meeting("m-1")]);
        let chunks = repo.list_chunks("m-1").expect("list chunks");
        assert_eq!(chunks.len(), 10);
        assert_eq!(chunks[0], sample_chunk("m-1", 0));
        assert_eq!(chunks[9], sample_chunk("m-1", 9));
        let qs = repo.list_questions("m-1").expect("list qs");
        assert_eq!(qs, vec![sample_question("m-1")]);
        let a = repo.get_answer("q-1").expect("get a").expect("present");
        assert_eq!(a, sample_answer("q-1"));
        let ctxs = repo.list_contexts_for_meeting("m-1").expect("list ctxs");
        assert_eq!(ctxs, vec![sample_context()]);
    }

    // DB-R8: chunk with bogus meeting_id → FK violation.
    #[test]
    fn chunk_with_bogus_meeting_id_fails_fk() {
        let repo = Repo::open_in_memory().expect("open ok");
        let mut bad = sample_chunk("ghost", 0);
        bad.id = "orphan-chunk".to_string();
        let err = repo
            .insert_transcript_chunk(&bad)
            .expect_err("FK should reject");
        let msg = format!("{err}").to_uppercase();
        assert!(msg.contains("FOREIGN KEY"), "got: {err}");
    }

    // DB-R9: duplicate meeting PK → UNIQUE / PRIMARY KEY violation.
    #[test]
    fn duplicate_meeting_pk_rejected() {
        let repo = Repo::open_in_memory().expect("open ok");
        let m = sample_meeting("m-1");
        repo.insert_meeting(&m).expect("first ok");
        let err = repo.insert_meeting(&m).expect_err("dup should reject");
        let msg = format!("{err}").to_uppercase();
        assert!(
            msg.contains("UNIQUE") || msg.contains("PRIMARY KEY"),
            "got: {err}"
        );
    }

    // DB-R10: 1:1 question→answer constraint enforced (UNIQUE on question_id).
    #[test]
    fn duplicate_answer_per_question_rejected() {
        let repo = Repo::open_in_memory().expect("open ok");
        repo.insert_meeting(&sample_meeting("m-1")).expect("m");
        repo.insert_question(&sample_question("m-1")).expect("q");
        repo.insert_answer(&sample_answer("q-1")).expect("a1");
        let mut a2 = sample_answer("q-1");
        a2.id = "a-2".to_string();
        a2.text = "Different answer for same question".to_string();
        let err = repo.insert_answer(&a2).expect_err("dup should reject");
        let msg = format!("{err}").to_uppercase();
        assert!(msg.contains("UNIQUE"), "got: {err}");
    }

    // DB-R11: serde JSON shape uses camelCase (matches shared/types.ts).
    #[test]
    fn serde_json_uses_camel_case_for_all_dtos() {
        let m_json = serde_json::to_string(&sample_meeting("m-1")).expect("m json");
        assert!(m_json.contains("\"startedAt\""), "{m_json}");
        assert!(m_json.contains("\"endedAt\""), "{m_json}");
        assert!(m_json.contains("\"sttProvider\""), "{m_json}");
        assert!(m_json.contains("\"privacyMode\""), "{m_json}");
        assert!(!m_json.contains("started_at"), "{m_json}");

        let c_json = serde_json::to_string(&sample_chunk("m-1", 3)).expect("c json");
        assert!(c_json.contains("\"meetingId\""), "{c_json}");
        assert!(c_json.contains("\"startTs\""), "{c_json}");
        assert!(c_json.contains("\"endTs\""), "{c_json}");
        assert!(c_json.contains("\"isFinal\""), "{c_json}");
        assert!(!c_json.contains("meeting_id"), "{c_json}");

        let q_json = serde_json::to_string(&sample_question("m-1")).expect("q json");
        assert!(q_json.contains("\"detectedTs\""), "{q_json}");
        assert!(q_json.contains("\"meetingId\""), "{q_json}");

        let a_json = serde_json::to_string(&sample_answer("q-1")).expect("a json");
        assert!(a_json.contains("\"questionId\""), "{a_json}");
        assert!(a_json.contains("\"generatedAt\""), "{a_json}");
        assert!(a_json.contains("\"tokensIn\""), "{a_json}");
        assert!(a_json.contains("\"tokensOut\""), "{a_json}");
        assert!(a_json.contains("\"cachedRatio\""), "{a_json}");
        assert!(!a_json.contains("question_id"), "{a_json}");

        let ctx_json = serde_json::to_string(&sample_context()).expect("ctx json");
        assert!(ctx_json.contains("\"charCount\""), "{ctx_json}");
        assert!(ctx_json.contains("\"estimatedTokens\""), "{ctx_json}");
        assert!(ctx_json.contains("\"loadedAt\""), "{ctx_json}");
    }

    // DB-R12: empty queries return empty vec, no panic on missing.
    #[test]
    fn empty_queries_return_empty_vec() {
        let repo = Repo::open_in_memory().expect("open ok");
        assert_eq!(repo.list_meetings().expect("list"), vec![]);
        assert_eq!(repo.list_chunks("ghost").expect("list"), vec![]);
        assert_eq!(repo.list_questions("ghost").expect("list"), vec![]);
        assert_eq!(repo.get_answer("ghost").expect("get"), None);
        assert_eq!(repo.get_meeting("ghost").expect("get"), None);
        assert_eq!(repo.get_context_source("ghost").expect("get"), None);
        assert_eq!(
            repo.list_contexts_for_meeting("ghost").expect("list"),
            vec![]
        );
    }

    // DB-R13: re-open is idempotent on schema (CREATE TABLE IF NOT EXISTS).
    #[test]
    fn reopen_is_idempotent() {
        let tmp = TmpDb::new();
        let _r1 = Repo::open(&tmp.path).expect("open 1");
        // Re-opening must not error on duplicate CREATE TABLE.
        let _r2 = Repo::open(&tmp.path).expect("open 2");
        let _r3 = Repo::open(&tmp.path).expect("open 3");
    }

    // Bonus: optional fields preserve None across insert+get.
    #[test]
    fn meeting_with_none_optional_fields_round_trips() {
        let repo = Repo::open_in_memory().expect("open ok");
        let m = MeetingRow {
            id: "m-2".into(),
            title: "Quick sync".into(),
            started_at: 1_700_000_000_000,
            ended_at: None,
            stt_provider: None,
            model: None,
            privacy_mode: None,
            status: "active".into(),
        };
        repo.insert_meeting(&m).expect("insert");
        let got = repo.get_meeting("m-2").expect("get").expect("present");
        assert_eq!(got, m);
        assert_eq!(got.ended_at, None);
        assert_eq!(got.stt_provider, None);
    }

    // Bonus: meetings ordered started_at DESC (newest first) for the past-meetings list.
    #[test]
    fn list_meetings_orders_newest_first() {
        let repo = Repo::open_in_memory().expect("open ok");
        let mut older = sample_meeting("m-old");
        older.started_at = 1_000_000;
        let mut newer = sample_meeting("m-new");
        newer.started_at = 9_000_000;
        repo.insert_meeting(&older).expect("older");
        repo.insert_meeting(&newer).expect("newer");
        let listed = repo.list_meetings().expect("list");
        assert_eq!(listed[0].id, "m-new");
        assert_eq!(listed[1].id, "m-old");
    }
}
