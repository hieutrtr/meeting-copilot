// ElevenLabs TTS adapter — Phase 3 T-3.7.
//
// HTTP-style adapter over the `TtsTransport` seam. Production wiring (Phase
// 3.x) plugs in a `reqwest::blocking::Client`-backed transport; tests inject a
// deterministic `FakeTransport` returning hardcoded PCM bytes. The seam keeps
// `reqwest` out of the default dep graph entirely — `cargo build` (no
// `--features tts`) compiles zero new bytes for this module.
//
// Endpoint shape (production, ARCH §4 ref + ElevenLabs API docs):
//
//     POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000
//     Headers:
//       xi-api-key: <key>
//       content-type: application/json
//       accept: audio/wav
//     Body: {
//       "text": "...",
//       "model_id": "eleven_turbo_v2",
//       "voice_settings": { ... } // optional, default elided here
//     }
//
// Response: streaming `audio/wav` (or PCM bytes if `output_format=pcm_16000`).
// Adapter parses i16 LE bytes into `TtsAudioChunk` (one chunk per response in
// this synchronous return shape; a future streaming variant can split into
// multiple chunks for first-audio < 400 ms latency per ARCH §4).
//
// Header carrier: `xi-api-key` (matches T-3.4 STT adapter — the standard
// ElevenLabs header for every API). `Authorization` header is NOT used.
//
// Production base URL: `https://api.elevenlabs.io`. The default config points
// here; tests override with a localhost transport seam (no real network).

use std::env;

use crate::tts::provider::{
    TtsAudioChunk, TtsError, TtsProvider, TtsRequest, TtsSpeakOptions, TtsTransport,
};

/// Default ElevenLabs voice — "Rachel" (`21m00Tcm4TlvDq8ikWAM`). Pinned in
/// `provider-comparison.md` (T-3.10). Drift here is a doc-sync issue, not a
/// compile error.
pub const ELEVENLABS_DEFAULT_VOICE_ID: &str = "21m00Tcm4TlvDq8ikWAM";

/// Default ElevenLabs TTS model — "Eleven Turbo v2" (~400 ms first audio per
/// ARCH §4). Drift in production (provider deprecates the model) surfaces as a
/// 404 from the live transport; the default constant stays the canonical pin.
pub const ELEVENLABS_DEFAULT_MODEL_ID: &str = "eleven_turbo_v2";

/// Production base URL. Tests override with `http://127.0.0.1:0/` style or
/// inject a `FakeTransport` that ignores the URL entirely.
pub const ELEVENLABS_DEFAULT_BASE_URL: &str = "https://api.elevenlabs.io";

/// `output_format=pcm_16000` query param — 16 kHz mono i16 LE. Matches the
/// helper-daemon's STT input convention so a future TTS-as-mic loopback path
/// needs no resampling.
pub const ELEVENLABS_DEFAULT_OUTPUT_FORMAT: &str = "pcm_16000";
pub const ELEVENLABS_DEFAULT_SAMPLE_RATE: u32 = 16_000;

/// Configuration for the ElevenLabs TTS adapter.
///
/// `api_key` — when `None` or empty, `ElevenLabsTtsAdapter::new()` returns
/// `TtsError::Config("ELEVENLABS_API_KEY missing or empty")`. Construction-time
/// validation matches the T-3.4 STT adapter convention so the settings UI
/// (T-3.6) can present a uniform error shape across STT + TTS.
///
/// `base_url` — root URL (no trailing slash needed; the adapter inserts the
/// path separator). Defaults to production.
///
/// `voice_id` / `model_id` — pinned defaults; future picker UI can override.
#[derive(Debug, Clone)]
pub struct ElevenLabsTtsConfig {
    pub api_key: Option<String>,
    pub base_url: String,
    pub voice_id: String,
    pub model_id: String,
    pub sample_rate: u32,
}

impl Default for ElevenLabsTtsConfig {
    fn default() -> Self {
        Self {
            api_key: env::var("ELEVENLABS_API_KEY").ok(),
            base_url: ELEVENLABS_DEFAULT_BASE_URL.into(),
            voice_id: ELEVENLABS_DEFAULT_VOICE_ID.into(),
            model_id: ELEVENLABS_DEFAULT_MODEL_ID.into(),
            sample_rate: ELEVENLABS_DEFAULT_SAMPLE_RATE,
        }
    }
}

/// ElevenLabs TTS adapter. Construction-time validates the API key (loud-fail
/// on missing); `speak()` issues one request and parses the response into one
/// `TtsAudioChunk`. The transport seam keeps the dep graph minimal.
pub struct ElevenLabsTtsAdapter {
    cfg: ElevenLabsTtsConfig,
    api_key: String,
    transport: Box<dyn TtsTransport + Send>,
}

impl ElevenLabsTtsAdapter {
    pub fn new(
        cfg: ElevenLabsTtsConfig,
        transport: Box<dyn TtsTransport + Send>,
    ) -> Result<Self, TtsError> {
        let api_key = cfg.api_key.clone().unwrap_or_default();
        if api_key.is_empty() {
            return Err(TtsError::Config(
                "ELEVENLABS_API_KEY missing or empty".into(),
            ));
        }
        Ok(Self {
            cfg,
            api_key,
            transport,
        })
    }

    fn build_request(&self, text: &str, opts: &TtsSpeakOptions) -> TtsRequest {
        let voice_id = if opts.voice.is_empty() {
            &self.cfg.voice_id
        } else {
            &opts.voice
        };
        let url = format!(
            "{}/v1/text-to-speech/{}/stream?output_format={}",
            self.cfg.base_url.trim_end_matches('/'),
            voice_id,
            ELEVENLABS_DEFAULT_OUTPUT_FORMAT
        );
        // Hand-rolled JSON to avoid pulling `serde_json` into hot-path here
        // (the crate already depends on `serde_json`, but keeping the body
        // construction explicit makes the request shape obvious in code review
        // and trivial to assert in `tests::request_body_*`).
        let body = format!(
            "{{\"text\":{},\"model_id\":{}}}",
            json_string(text),
            json_string(&self.cfg.model_id)
        )
        .into_bytes();
        TtsRequest {
            url,
            method: "POST",
            headers: vec![
                ("xi-api-key".into(), self.api_key.clone()),
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "audio/wav".into()),
            ],
            body,
        }
    }
}

/// Encode a Rust string as a JSON string literal — used to keep `build_request`
/// dependency-free. Handles the four characters that JSON requires escaped
/// inside a string (`"`, `\`, control chars below 0x20). Sufficient for
/// arbitrary user text — the adapter never sees binary in a JSON field.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Decode a stream of i16 LE bytes into `Vec<i16>` samples. Returns
/// `TtsError::Decode` on an odd byte count (transport corruption).
fn decode_pcm_le_i16(bytes: &[u8]) -> Result<Vec<i16>, TtsError> {
    if bytes.len() % 2 != 0 {
        return Err(TtsError::Decode(format!(
            "odd byte count {} — expected i16 LE pairs",
            bytes.len()
        )));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        out.push(i16::from_le_bytes([pair[0], pair[1]]));
    }
    Ok(out)
}

impl TtsProvider for ElevenLabsTtsAdapter {
    fn name(&self) -> &'static str {
        "elevenlabs-tts"
    }

    fn speak(
        &mut self,
        text: &str,
        opts: &TtsSpeakOptions,
    ) -> Result<Vec<TtsAudioChunk>, TtsError> {
        let req = self.build_request(text, opts);
        let bytes = self.transport.execute(req)?;
        let samples = decode_pcm_le_i16(&bytes)?;
        if samples.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![TtsAudioChunk {
            samples,
            sample_rate: self.cfg.sample_rate,
            ts_ms: 0,
        }])
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Deterministic transport for tests. Captures the most recent request and
    /// returns a pre-canned response. Used to assert the request shape (URL,
    /// headers, body) without any network.
    struct FakeTransport {
        last: Arc<Mutex<Option<TtsRequest>>>,
        response: Result<Vec<u8>, TtsError>,
    }

    impl FakeTransport {
        fn ok(bytes: Vec<u8>) -> (Self, Arc<Mutex<Option<TtsRequest>>>) {
            let last = Arc::new(Mutex::new(None));
            (
                Self {
                    last: last.clone(),
                    response: Ok(bytes),
                },
                last,
            )
        }

        fn err(e: TtsError) -> (Self, Arc<Mutex<Option<TtsRequest>>>) {
            let last = Arc::new(Mutex::new(None));
            (
                Self {
                    last: last.clone(),
                    response: Err(e),
                },
                last,
            )
        }
    }

    impl TtsTransport for FakeTransport {
        fn execute(&mut self, req: TtsRequest) -> Result<Vec<u8>, TtsError> {
            *self.last.lock().unwrap() = Some(req);
            // Cloning to satisfy `&mut self` — `Result<Vec<u8>, TtsError>` is
            // not Clone, so we manually duplicate.
            match &self.response {
                Ok(bytes) => Ok(bytes.clone()),
                Err(TtsError::Config(s)) => Err(TtsError::Config(s.clone())),
                Err(TtsError::Io(s)) => Err(TtsError::Io(s.clone())),
                Err(TtsError::Decode(s)) => Err(TtsError::Decode(s.clone())),
            }
        }
    }

    fn cfg_with_key(key: &str) -> ElevenLabsTtsConfig {
        ElevenLabsTtsConfig {
            api_key: Some(key.into()),
            base_url: "http://127.0.0.1:0".into(),
            voice_id: "test-voice".into(),
            model_id: "test-model".into(),
            sample_rate: 16_000,
        }
    }

    #[test]
    fn missing_api_key_returns_config_error() {
        let (transport, _) = FakeTransport::ok(vec![]);
        let cfg = ElevenLabsTtsConfig {
            api_key: None,
            ..cfg_with_key("ignored")
        };
        let err = ElevenLabsTtsAdapter::new(cfg, Box::new(transport)).expect_err("must error");
        match err {
            TtsError::Config(msg) => {
                assert!(
                    msg.contains("ELEVENLABS_API_KEY"),
                    "msg should mention env var, got {msg:?}"
                );
            }
            other => panic!("expected Config, got {other:?}"),
        }
    }

    #[test]
    fn empty_api_key_returns_config_error() {
        let (transport, _) = FakeTransport::ok(vec![]);
        let cfg = ElevenLabsTtsConfig {
            api_key: Some("".into()),
            ..cfg_with_key("ignored")
        };
        let err = ElevenLabsTtsAdapter::new(cfg, Box::new(transport)).expect_err("must error");
        assert!(matches!(err, TtsError::Config(_)));
    }

    #[test]
    fn request_url_matches_arch_endpoint_shape() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let _ = adapter.speak("hi", &TtsSpeakOptions::new(""));
        let req = last.lock().unwrap().clone().expect("request captured");
        assert_eq!(req.method, "POST");
        assert!(
            req.url.contains("/v1/text-to-speech/test-voice/stream"),
            "URL should match ARCH endpoint shape, got {}",
            req.url
        );
        assert!(
            req.url.contains("output_format=pcm_16000"),
            "URL should pin pcm_16000 output format, got {}",
            req.url
        );
    }

    #[test]
    fn request_carries_xi_api_key_header() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter =
            ElevenLabsTtsAdapter::new(cfg_with_key("secret-key-42"), Box::new(transport))
                .expect("ctor");
        let _ = adapter.speak("hi", &TtsSpeakOptions::new("test-voice"));
        let req = last.lock().unwrap().clone().expect("request captured");
        let xi = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("xi-api-key"))
            .expect("xi-api-key header must be present");
        assert_eq!(xi.1, "secret-key-42");
        // No `Authorization` header — ElevenLabs uses xi-api-key only.
        assert!(
            !req.headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("authorization")),
            "Authorization header must NOT be present"
        );
    }

    #[test]
    fn request_body_contains_text_and_model_id() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let _ = adapter.speak("hello world", &TtsSpeakOptions::new("test-voice"));
        let req = last.lock().unwrap().clone().expect("request captured");
        let body = std::str::from_utf8(&req.body).unwrap();
        assert!(body.contains("\"text\":\"hello world\""));
        assert!(body.contains("\"model_id\":\"test-model\""));
    }

    #[test]
    fn request_body_escapes_quotes_and_backslashes() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        // Text contains a quote + backslash — must be escaped per JSON rules.
        let _ = adapter.speak("she said \"hi\\bye\"", &TtsSpeakOptions::new("v"));
        let req = last.lock().unwrap().clone().expect("captured");
        let body = std::str::from_utf8(&req.body).unwrap();
        // Escaped quote and escaped backslash both present.
        assert!(body.contains("\\\""), "must escape \" → \\\"");
        assert!(body.contains("\\\\"), "must escape \\ → \\\\");
    }

    #[test]
    fn voice_param_overrides_config_voice_id() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let _ = adapter.speak("hi", &TtsSpeakOptions::new("override-voice"));
        let req = last.lock().unwrap().clone().expect("captured");
        assert!(
            req.url.contains("/text-to-speech/override-voice/stream"),
            "opts.voice should override cfg.voice_id, got {}",
            req.url
        );
    }

    #[test]
    fn empty_voice_param_falls_back_to_config_voice_id() {
        let (transport, last) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let _ = adapter.speak("hi", &TtsSpeakOptions::new(""));
        let req = last.lock().unwrap().clone().expect("captured");
        assert!(
            req.url.contains("/text-to-speech/test-voice/stream"),
            "empty opts.voice should fall back to cfg.voice_id, got {}",
            req.url
        );
    }

    #[test]
    fn pcm_response_decodes_to_audio_chunk() {
        // Two i16 samples: 0x0001 + 0x00FF (LE) → values 1 + 255.
        let pcm = vec![0x01, 0x00, 0xFF, 0x00];
        let (transport, _) = FakeTransport::ok(pcm);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let chunks = adapter
            .speak("hi", &TtsSpeakOptions::new("test-voice"))
            .expect("speak ok");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].samples, vec![1, 255]);
        assert_eq!(chunks[0].sample_rate, 16_000);
        assert_eq!(chunks[0].ts_ms, 0);
    }

    #[test]
    fn empty_response_returns_no_chunks() {
        let (transport, _) = FakeTransport::ok(vec![]);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let chunks = adapter
            .speak("hi", &TtsSpeakOptions::new("test-voice"))
            .expect("speak ok");
        assert!(chunks.is_empty());
    }

    #[test]
    fn odd_response_byte_count_returns_decode_error() {
        // Odd number of bytes → can't form complete i16 LE pairs.
        let pcm = vec![0x01, 0x00, 0xFF];
        let (transport, _) = FakeTransport::ok(pcm);
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let err = adapter
            .speak("hi", &TtsSpeakOptions::new("test-voice"))
            .expect_err("decode must fail");
        assert!(matches!(err, TtsError::Decode(_)));
    }

    #[test]
    fn transport_io_error_propagates() {
        let (transport, _) = FakeTransport::err(TtsError::Io("connection refused".into()));
        let mut adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        let err = adapter
            .speak("hi", &TtsSpeakOptions::new("test-voice"))
            .expect_err("io must propagate");
        match err {
            TtsError::Io(msg) => assert!(msg.contains("connection refused")),
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn provider_name_is_stable_for_telemetry() {
        // T-3.9 telemetry log reads name() — drift here breaks the audit grep.
        let (transport, _) = FakeTransport::ok(vec![]);
        let adapter = ElevenLabsTtsAdapter::new(cfg_with_key("k"), Box::new(transport))
            .expect("ctor");
        assert_eq!(adapter.name(), "elevenlabs-tts");
    }

    #[test]
    fn default_config_constants_pinned() {
        // Constants are public + cross-referenced by `provider-comparison.md`
        // (T-3.10). Drift in one place breaks the other; this is the test
        // that catches it.
        assert_eq!(ELEVENLABS_DEFAULT_VOICE_ID, "21m00Tcm4TlvDq8ikWAM");
        assert_eq!(ELEVENLABS_DEFAULT_MODEL_ID, "eleven_turbo_v2");
        assert_eq!(ELEVENLABS_DEFAULT_BASE_URL, "https://api.elevenlabs.io");
        assert_eq!(ELEVENLABS_DEFAULT_OUTPUT_FORMAT, "pcm_16000");
        assert_eq!(ELEVENLABS_DEFAULT_SAMPLE_RATE, 16_000);
    }

    #[test]
    fn json_string_helper_handles_control_chars() {
        // Internal helper sanity — not a public surface but central to body
        // construction.
        assert_eq!(json_string("hi"), "\"hi\"");
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_string("a\\b"), "\"a\\\\b\"");
        assert_eq!(json_string("\n"), "\"\\n\"");
        assert_eq!(json_string("\r"), "\"\\r\"");
        assert_eq!(json_string("\t"), "\"\\t\"");
        // Below 0x20 → \u00xx escape.
        assert_eq!(json_string("\x01"), "\"\\u0001\"");
    }
}
