// Phase 1 T-1.8 — context loader for a single PRD/MD/TXT file.
//
// Owns the read+stat half of ARCH §6 (Context Loader). The token-count is the
// loop INDEX's `chars/4` proxy — see T-1.8 task file AC-4 for the rationale and
// the Phase 1.x escape hatch (swap to `tiktoken-rs`) if T-1.10 cost AC drifts.
//
// Surface is in-process only: `read_context_file(path)` returns a `ContextFile`
// (or a typed error). `src-tauri/src/lib.rs` adapts it to a Tauri command and
// stringifies the error for the IPC boundary.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Allowed source-file extensions for Phase 1. Lower-cased ASCII for the match.
/// Phase 1.x widens this once `pdf-parse` (or a Rust equivalent) lands per ARCH §6.1.
pub const ALLOWED_EXTENSIONS: &[&str] = &["md", "txt"];

#[derive(Debug, Error)]
pub enum ContextError {
    /// Caller passed a path with an unsupported / missing extension.
    #[error("unsupported extension `{0}` (Phase 1 accepts: .md, .txt)")]
    UnsupportedExtension(String),

    /// `fs::read_to_string` failed (missing file, permission denied, …).
    #[error("io error reading `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Public-facing record of a loaded context file. Field names use camelCase via serde
/// to match `shared/types.ts:ContextSource` so the Tauri IPC payload is byte-identical.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub path: String,
    pub content: String,
    pub char_count: u64,
    pub estimated_tokens: u64,
}

/// `chars / 4` rounded up. 0 → 0; 1..=4 → 1; 5..=8 → 2; …
///
/// Plain integer math (no `f64`) so the AC stays deterministic on every host.
pub(crate) fn estimate_tokens(char_count: u64) -> u64 {
    if char_count == 0 {
        0
    } else {
        (char_count + 3) / 4
    }
}

/// Read a UTF-8 text file from disk, returning a `ContextFile` describing it.
/// Rejects extensions outside `ALLOWED_EXTENSIONS` before touching the disk.
pub fn read_context_file<P: AsRef<Path>>(path: P) -> Result<ContextFile, ContextError> {
    let path_ref = path.as_ref();

    let ext_owned: String = path_ref
        .extension()
        .and_then(|os| os.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if !ALLOWED_EXTENSIONS.iter().any(|allowed| *allowed == ext_owned) {
        return Err(ContextError::UnsupportedExtension(ext_owned));
    }

    let content = fs::read_to_string(path_ref).map_err(|source| ContextError::Io {
        path: path_ref.to_path_buf(),
        source,
    })?;

    let char_count = content.chars().count() as u64;
    let estimated_tokens = estimate_tokens(char_count);

    Ok(ContextFile {
        path: path_ref.to_string_lossy().to_string(),
        content,
        char_count,
        estimated_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Write `content` to a uniquely-named file under `std::env::temp_dir()` and
    /// return its path. Caller is responsible for `fs::remove_file` (we wrap in a
    /// drop-guard below). Avoids adding a `tempfile` dep so the helper-daemon
    /// crate stays tempfile-free until something else needs it.
    struct TmpFile(PathBuf);

    impl TmpFile {
        fn new(extension: &str, content: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let path = std::env::temp_dir()
                .join(format!("ctx_t18_{}_{}.{}", pid, n, extension));
            let mut f = File::create(&path).expect("tmp create");
            f.write_all(content.as_bytes()).expect("tmp write");
            TmpFile(path)
        }
    }

    impl Drop for TmpFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    // CTX-R6: estimated_tokens edge cases — exercise on its own.
    #[test]
    fn estimate_tokens_rounds_up() {
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(1), 1);
        assert_eq!(estimate_tokens(4), 1);
        assert_eq!(estimate_tokens(5), 2);
        assert_eq!(estimate_tokens(8), 2);
        assert_eq!(estimate_tokens(9), 3);
        // 100 chars → 25 tokens exactly; 101 → 26.
        assert_eq!(estimate_tokens(100), 25);
        assert_eq!(estimate_tokens(101), 26);
    }

    // CTX-R1: .md fixture round-trip.
    #[test]
    fn reads_md_file() {
        let tmp = TmpFile::new("md", "# Hello PRD\n\nSome body text.");
        let got = read_context_file(&tmp.0).expect("md should load");

        assert_eq!(got.content, "# Hello PRD\n\nSome body text.");
        assert_eq!(got.char_count, 28);
        assert_eq!(got.estimated_tokens, estimate_tokens(28));
        assert!(got.path.ends_with(".md"));
    }

    // CTX-R2: .txt fixture round-trip.
    #[test]
    fn reads_txt_file() {
        let tmp = TmpFile::new("txt", "plain text body");
        let got = read_context_file(&tmp.0).expect("txt should load");

        assert_eq!(got.content, "plain text body");
        assert_eq!(got.char_count, 15);
        assert_eq!(got.estimated_tokens, 4); // ceil(15/4) = 4
        assert!(got.path.ends_with(".txt"));
    }

    // CTX-R3: .pdf is rejected without IO.
    #[test]
    fn rejects_pdf_extension() {
        // Path doesn't need to exist — extension check runs first.
        let path = std::env::temp_dir().join("nope.pdf");
        let err = read_context_file(&path).expect_err("pdf should reject");
        match err {
            ContextError::UnsupportedExtension(ext) => assert_eq!(ext, "pdf"),
            other => panic!("expected UnsupportedExtension, got {:?}", other),
        }
    }

    // CTX-R4: extensionless path is rejected.
    #[test]
    fn rejects_extensionless_path() {
        let path = std::env::temp_dir().join("README");
        let err = read_context_file(&path).expect_err("extensionless should reject");
        match err {
            ContextError::UnsupportedExtension(ext) => assert_eq!(ext, ""),
            other => panic!("expected UnsupportedExtension, got {:?}", other),
        }
    }

    // CTX-R5: missing file → typed Io error.
    #[test]
    fn rejects_missing_file() {
        let path = std::env::temp_dir().join("ctx_t18_does_not_exist.md");
        // Defensive: ensure it really is missing.
        let _ = fs::remove_file(&path);
        let err = read_context_file(&path).expect_err("missing should error");
        match err {
            ContextError::Io { path: errp, .. } => assert_eq!(errp, path),
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    // CTX-R7: serde JSON shape uses camelCase keys.
    #[test]
    fn serde_json_uses_camel_case() {
        let f = ContextFile {
            path: "/tmp/x.md".into(),
            content: "abcd".into(),
            char_count: 4,
            estimated_tokens: 1,
        };
        let json = serde_json::to_string(&f).expect("serialise");
        assert!(json.contains("\"charCount\":4"), "missing charCount: {}", json);
        assert!(
            json.contains("\"estimatedTokens\":1"),
            "missing estimatedTokens: {}",
            json
        );
        // Snake_case keys must NOT leak.
        assert!(!json.contains("char_count"));
        assert!(!json.contains("estimated_tokens"));
    }

    // Bonus: case-insensitive extension matching (.MD accepted).
    #[test]
    fn accepts_uppercase_extension() {
        let tmp = TmpFile::new("MD", "uppercase");
        let got = read_context_file(&tmp.0).expect("MD should load");
        assert_eq!(got.content, "uppercase");
    }
}
