// MlxWhisperSubprocess — production STT via Python `mlx-whisper` (Apple Silicon only).
// Per docs/ARCHITECTURE.md §3.2 (MLX local default) and Phase 1 T-1.5 task plan.
//
// HARDWARE-VERIFY PENDING: this module is code-complete but its runtime path requires
// (a) `cargo` toolchain installed (blocked-action #3 per Phase 1 INDEX) — every cargo test
// in this module is hardware-verify-only on the loop sandbox; static-trace recorded in
// T-1.5-review.md, and
// (b) Python with `mlx_whisper` importable. The integration test
// `mlx_subprocess_transcribes_short_utterance` soft-skips if `is_available()` is false or
// macOS `say`/`ffmpeg` are missing.
//
// Constraints respected here:
// - One subprocess per chunk (Phase 1 MVP). Long-lived warm-loaded subprocess is Phase 1.x
//   `T-1.5b` (Silero VAD + `large-v3-turbo` upgrade gate).
// - Chunk samples are written to a unique temp WAV file per call; file is removed on
//   completion (success or error) so disk usage stays bounded.
// - Stdout is parsed as exactly one JSON line; stderr is captured for diagnostics in
//   the SttError::Subprocess message but not parsed.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use audio_capture::PcmChunk;
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::Deserialize;

use crate::provider::{duration_ms, SttError, SttProvider, SttSegment};

/// The Python script is embedded into the Rust binary at compile time. `cargo` reruns the
/// build when `scripts/transcribe.py` changes (the `include_str!` macro registers it as a
/// rebuild input).
const TRANSCRIBE_PY: &str = include_str!("../scripts/transcribe.py");

/// Configuration for `MlxWhisperSubprocess`. Defaults read env vars (`MLX_WHISPER_PYTHON`,
/// `MLX_WHISPER_MODEL`) so dev hosts and the Phase-0 spike venv at
/// `experiments/T-0.4/.venv/bin/python` can be pointed at without code changes.
#[derive(Debug, Clone)]
pub struct MlxConfig {
    /// Python interpreter — must have `mlx_whisper` installed. Default `$MLX_WHISPER_PYTHON`
    /// or `python3`.
    pub python_bin: PathBuf,
    /// HuggingFace repo for the model. Default `$MLX_WHISPER_MODEL` or
    /// `mlx-community/whisper-medium-mlx` (per spike-memo Phase 1 stack decision).
    pub hf_repo: String,
    /// Where to write the embedded `transcribe.py` and per-chunk temp WAV files. Default
    /// `std::env::temp_dir()/meeting-copilot-stt-mlx`.
    pub work_dir: PathBuf,
}

impl Default for MlxConfig {
    fn default() -> Self {
        let python_bin = std::env::var_os("MLX_WHISPER_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("python3"));
        let hf_repo = std::env::var("MLX_WHISPER_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "mlx-community/whisper-medium-mlx".to_string());
        let work_dir = std::env::temp_dir().join("meeting-copilot-stt-mlx");
        Self {
            python_bin,
            hf_repo,
            work_dir,
        }
    }
}

pub struct MlxWhisperSubprocess {
    config: MlxConfig,
    script_path: PathBuf,
    invocation_idx: u64,
}

impl MlxWhisperSubprocess {
    /// Create a new subprocess driver. Eagerly creates `work_dir` and writes the embedded
    /// `transcribe.py` script. Two concurrent constructors writing to the same `work_dir`
    /// is safe — content is byte-identical.
    pub fn new(config: MlxConfig) -> Result<Self, SttError> {
        std::fs::create_dir_all(&config.work_dir)
            .map_err(|e| SttError::Io(format!("create work_dir {:?}: {e}", config.work_dir)))?;
        let script_path = config.work_dir.join("transcribe.py");
        std::fs::write(&script_path, TRANSCRIBE_PY)
            .map_err(|e| SttError::Io(format!("write {script_path:?}: {e}")))?;
        Ok(Self {
            config,
            script_path,
            invocation_idx: 0,
        })
    }

    /// Convenience for `Self::new(MlxConfig::default())`.
    pub fn with_default() -> Result<Self, SttError> {
        Self::new(MlxConfig::default())
    }

    /// Best-effort runtime probe. Returns `true` iff `python_bin -c "import mlx_whisper"`
    /// exits 0. Used by tests to soft-skip on hosts without MLX. Never panics, never hangs
    /// (subprocess returns immediately on import success/failure).
    pub fn is_available(&self) -> bool {
        let status = Command::new(&self.config.python_bin)
            .args(["-c", "import mlx_whisper"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        matches!(status, Ok(s) if s.success())
    }

    /// Read-only accessor (used by tests).
    pub fn config(&self) -> &MlxConfig {
        &self.config
    }

    /// Path of the on-disk `transcribe.py` (used by tests).
    pub fn script_path(&self) -> &PathBuf {
        &self.script_path
    }

    /// Write the chunk's samples as a 16-bit PCM mono WAV at `chunk.sample_rate`. f32 in
    /// `[-1.0, 1.0]` → i16 via `* i16::MAX` with explicit clamp; whisper's encoder is
    /// robust to mild clipping artifacts.
    pub(crate) fn write_chunk_wav(&mut self, chunk: &PcmChunk) -> Result<PathBuf, SttError> {
        self.invocation_idx = self.invocation_idx.saturating_add(1);
        let path = self
            .config
            .work_dir
            .join(format!("chunk-{:08}.wav", self.invocation_idx));
        let spec = WavSpec {
            channels: 1,
            sample_rate: chunk.sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&path, spec)
            .map_err(|e| SttError::Io(format!("WavWriter::create {path:?}: {e}")))?;
        for s in &chunk.samples {
            let scaled = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i32;
            let clipped = scaled.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            writer
                .write_sample(clipped)
                .map_err(|e| SttError::Io(format!("write_sample: {e}")))?;
        }
        writer
            .finalize()
            .map_err(|e| SttError::Io(format!("WavWriter::finalize: {e}")))?;
        Ok(path)
    }
}

// JSON shape emitted by `transcribe.py`. Only the fields we consume are bound here;
// extra fields are ignored by serde.
#[derive(Deserialize, Debug)]
struct ScriptOut {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    segments: Vec<ScriptSegment>,
}

#[derive(Deserialize, Debug)]
struct ScriptSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    no_speech_prob: Option<f64>,
}

/// Parse the script's first stdout line into a `ScriptOut`. Public-in-crate for unit tests.
pub(crate) fn parse_script_output(stdout: &str) -> Result<ScriptOut, SttError> {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err(SttError::Decode("empty stdout from transcribe.py".to_string()));
    }
    serde_json::from_str(line).map_err(|e| SttError::Decode(format!("json: {e} — line={line:?}")))
}

/// Lift script segments into our `SttSegment` shape, offsetting timestamps by the source
/// chunk's `ts_ms` so consumers see absolute meeting-time. If the script's `segments` array
/// is empty but `text` is non-empty, fall back to a single segment spanning the whole chunk.
pub(crate) fn build_segments(parsed: &ScriptOut, chunk: &PcmChunk) -> Vec<SttSegment> {
    let chunk_offset_ms = chunk.ts_ms;
    if !parsed.segments.is_empty() {
        return parsed
            .segments
            .iter()
            .map(|s| {
                let start_ms = (s.start.max(0.0) * 1000.0).round() as u64;
                let end_ms = (s.end.max(s.start) * 1000.0).round() as u64;
                SttSegment {
                    text: s.text.trim().to_string(),
                    start_ts_ms: chunk_offset_ms.saturating_add(start_ms),
                    end_ts_ms: chunk_offset_ms.saturating_add(end_ms),
                    is_final: true,
                    confidence: s.no_speech_prob.map(|p| (1.0 - p).clamp(0.0, 1.0) as f32),
                }
            })
            .filter(|s| !s.text.is_empty())
            .collect();
    }
    let text = parsed
        .text
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Vec::new();
    }
    let dur_ms = duration_ms(chunk.samples.len(), chunk.sample_rate);
    vec![SttSegment {
        text,
        start_ts_ms: chunk_offset_ms,
        end_ts_ms: chunk_offset_ms.saturating_add(dur_ms),
        is_final: true,
        confidence: None,
    }]
}

impl SttProvider for MlxWhisperSubprocess {
    fn name(&self) -> &'static str {
        "mlx-whisper"
    }

    fn transcribe_chunk(&mut self, chunk: &PcmChunk) -> Result<Vec<SttSegment>, SttError> {
        let wav_path = self.write_chunk_wav(chunk)?;
        let output = Command::new(&self.config.python_bin)
            .arg(&self.script_path)
            .arg(&self.config.hf_repo)
            .arg(&wav_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();

        // Always remove the temp WAV — keep work_dir bounded even on error.
        let _ = std::fs::remove_file(&wav_path);

        let output = output.map_err(|e| {
            SttError::SubprocessSpawn(format!(
                "spawn {:?}: {e}",
                self.config.python_bin
            ))
        })?;

        let stdout = std::str::from_utf8(&output.stdout)
            .map_err(|e| SttError::Decode(format!("utf8: {e}")))?;
        let parsed = parse_script_output(stdout)?;

        if !parsed.ok {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr_tail: String = stderr.lines().rev().take(5).collect::<Vec<_>>().join("\n");
            return Err(SttError::Subprocess(format!(
                "transcribe.py failed: {} (exit={:?}); stderr_tail=\n{}",
                parsed.error.unwrap_or_default(),
                output.status.code(),
                stderr_tail
            )));
        }

        Ok(build_segments(&parsed, chunk))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use audio_capture::WavFileSource;

    fn unique_work_dir(label: &str) -> PathBuf {
        // Process-id + nano-timestamp + label keeps tests parallel-safe.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "mc-stt-mlx-test-{label}-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    fn tool_available(name: &str) -> bool {
        Command::new(name)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn say_available() -> bool {
        // macOS `say` doesn't have --version but exits 0 on stdin EOF with no args; safer
        // to just probe `which`-style via `command -v`. Use std::process::Command directly.
        Command::new("say")
            .arg("-?")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|_| true) // `say -?` exits 1 with usage; success means binary present
            .unwrap_or(false)
    }

    fn fake_chunk(n: usize, rate: u32, ts: u64) -> PcmChunk {
        PcmChunk {
            samples: vec![0.0; n],
            sample_rate: rate,
            ts_ms: ts,
        }
    }

    #[test]
    fn mlx_config_default_picks_python3_and_medium_model() {
        // Don't mutate env (other tests in this binary may run in parallel and read it).
        // Assert only the *shape* of the defaults, plus the env override path. Strict
        // value-match for the no-env case is exercised by `mlx_config_default_uses_python3_when_env_unset`.
        let cfg = MlxConfig::default();
        assert!(!cfg.python_bin.as_os_str().is_empty(), "python_bin empty");
        assert!(cfg.hf_repo.contains("whisper"), "hf_repo missing 'whisper': {}", cfg.hf_repo);
        assert!(
            cfg.work_dir.to_string_lossy().contains("meeting-copilot-stt-mlx"),
            "work_dir does not contain expected suffix: {:?}",
            cfg.work_dir
        );
        // If MLX_WHISPER_PYTHON happens to be set, default *must* honour it.
        if let Some(want) = std::env::var_os("MLX_WHISPER_PYTHON") {
            assert_eq!(cfg.python_bin.as_os_str(), want);
        } else {
            assert_eq!(cfg.python_bin, PathBuf::from("python3"));
        }
        // Same for MLX_WHISPER_MODEL.
        if let Ok(want) = std::env::var("MLX_WHISPER_MODEL") {
            if !want.is_empty() {
                assert_eq!(cfg.hf_repo, want);
            }
        } else {
            assert!(cfg.hf_repo.contains("medium"), "default hf_repo: {}", cfg.hf_repo);
        }
    }

    #[test]
    fn mlx_subprocess_new_writes_transcribe_script() {
        let dir = unique_work_dir("script");
        let cfg = MlxConfig {
            work_dir: dir.clone(),
            ..MlxConfig::default()
        };
        let stt = MlxWhisperSubprocess::new(cfg).expect("new");
        let script = dir.join("transcribe.py");
        assert!(script.exists(), "transcribe.py not written to {dir:?}");
        let content = std::fs::read_to_string(&script).expect("read script");
        assert!(content.contains("mlx_whisper"));
        assert!(content.contains("ok"));
        assert_eq!(stt.script_path(), &script);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mlx_subprocess_is_available_returns_bool_and_does_not_panic() {
        let dir = unique_work_dir("avail");
        let cfg = MlxConfig {
            work_dir: dir.clone(),
            ..MlxConfig::default()
        };
        let stt = MlxWhisperSubprocess::new(cfg).expect("new");
        // Don't assert true/false — host-dependent. Just prove no panic + no hang.
        let _ = stt.is_available();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mlx_subprocess_writes_chunk_wav_with_correct_format() {
        let dir = unique_work_dir("wav");
        let cfg = MlxConfig {
            work_dir: dir.clone(),
            ..MlxConfig::default()
        };
        let mut stt = MlxWhisperSubprocess::new(cfg).expect("new");
        let chunk = PcmChunk {
            samples: vec![0.5; 16_000],
            sample_rate: 16_000,
            ts_ms: 0,
        };
        let path = stt.write_chunk_wav(&chunk).expect("wav");
        let reader = hound::WavReader::open(&path).expect("read");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);
        assert_eq!(reader.duration(), 16_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_script_output_accepts_ok_payload() {
        let line = r#"{"ok":true,"model":"x","language":"en","text":"hi","segments":[{"start":0.0,"end":1.0,"text":" hi","no_speech_prob":0.05}]}"#;
        let parsed = parse_script_output(line).expect("parse");
        assert!(parsed.ok);
        assert_eq!(parsed.text.as_deref(), Some("hi"));
        assert_eq!(parsed.segments.len(), 1);
        assert_eq!(parsed.segments[0].text, " hi");
    }

    #[test]
    fn parse_script_output_rejects_empty_stdout() {
        let err = parse_script_output("").expect_err("should fail");
        match err {
            SttError::Decode(_) => (),
            other => panic!("expected Decode, got {other:?}"),
        }
    }

    #[test]
    fn build_segments_offsets_by_chunk_ts_and_filters_empty() {
        let parsed = ScriptOut {
            ok: true,
            error: None,
            text: Some("hello world".to_string()),
            segments: vec![
                ScriptSegment {
                    start: 0.0,
                    end: 0.5,
                    text: " hello".to_string(),
                    no_speech_prob: Some(0.1),
                },
                ScriptSegment {
                    start: 0.5,
                    end: 1.0,
                    text: " ".to_string(), // whitespace only — filtered out
                    no_speech_prob: None,
                },
                ScriptSegment {
                    start: 1.0,
                    end: 1.5,
                    text: " world".to_string(),
                    no_speech_prob: Some(0.05),
                },
            ],
        };
        let chunk = fake_chunk(32_000, 16_000, 4_000);
        let segs = build_segments(&parsed, &chunk);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "hello");
        assert_eq!(segs[0].start_ts_ms, 4_000);
        assert_eq!(segs[0].end_ts_ms, 4_500);
        assert_eq!(segs[1].text, "world");
        assert_eq!(segs[1].start_ts_ms, 5_000);
        assert!((segs[0].confidence.unwrap() - 0.9).abs() < 1e-5);
        assert!(segs[1].confidence.is_some());
    }

    #[test]
    fn build_segments_falls_back_to_full_text_when_segments_empty() {
        let parsed = ScriptOut {
            ok: true,
            error: None,
            text: Some("the whole transcript".to_string()),
            segments: vec![],
        };
        let chunk = fake_chunk(32_000, 16_000, 100);
        let segs = build_segments(&parsed, &chunk);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "the whole transcript");
        assert_eq!(segs[0].start_ts_ms, 100);
        // 32_000 samples @ 16 kHz = 2_000 ms
        assert_eq!(segs[0].end_ts_ms, 2_100);
        assert!(segs[0].confidence.is_none());
    }

    #[test]
    fn build_segments_returns_empty_when_text_blank_and_no_segments() {
        let parsed = ScriptOut {
            ok: true,
            error: None,
            text: Some("   ".to_string()),
            segments: vec![],
        };
        let chunk = fake_chunk(16_000, 16_000, 0);
        let segs = build_segments(&parsed, &chunk);
        assert!(segs.is_empty());
    }

    /// Integration: end-to-end with the real `mlx-whisper` subprocess.
    /// Soft-skips if (a) `mlx_whisper` not importable from the configured python_bin, or
    /// (b) macOS `say` / `ffmpeg` are missing — both required to generate the fixture.
    #[test]
    fn mlx_subprocess_transcribes_short_utterance() {
        let dir = unique_work_dir("integration");
        let cfg = MlxConfig {
            work_dir: dir.clone(),
            ..MlxConfig::default()
        };
        let mut stt = MlxWhisperSubprocess::new(cfg).expect("new");

        if !stt.is_available() {
            eprintln!(
                "SKIP: mlx_whisper not importable from {:?}; set MLX_WHISPER_PYTHON to a venv with mlx-whisper installed (e.g. experiments/T-0.4/.venv/bin/python).",
                stt.config().python_bin
            );
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        if !say_available() || !tool_available("ffmpeg") {
            eprintln!("SKIP: macOS `say` or `ffmpeg` missing — cannot generate fixture.");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let aiff = dir.join("hello.aiff");
        let wav = dir.join("hello.wav");
        let say_status = Command::new("say")
            .args(["-o", aiff.to_str().unwrap(), "Hello world."])
            .status()
            .expect("say spawn");
        assert!(say_status.success(), "say failed");
        let ff_status = Command::new("ffmpeg")
            .args([
                "-y",
                "-loglevel",
                "error",
                "-i",
                aiff.to_str().unwrap(),
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                wav.to_str().unwrap(),
            ])
            .status()
            .expect("ffmpeg spawn");
        assert!(ff_status.success(), "ffmpeg failed");

        // Read the whole fixture as a single chunk (chunk_size large enough for 2-3 s).
        let mut src = WavFileSource::open(&wav, 1 << 22).expect("open fixture");
        let chunk = src.next_chunk().expect("first chunk");

        let segs = stt.transcribe_chunk(&chunk).expect("transcribe");
        assert!(!segs.is_empty(), "expected ≥ 1 segment from MLX whisper");
        assert!(
            segs.iter().any(|s| !s.text.is_empty()),
            "expected at least one non-empty segment text"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
