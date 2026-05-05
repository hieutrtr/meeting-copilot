#!/usr/bin/env python3
# Phase 1 T-1.5 — MLX whisper subprocess for Meeting Copilot.
# Spawned per chunk by `crates/stt-mlx/src/mlx.rs::MlxWhisperSubprocess::transcribe_chunk`.
#
# argv:   transcribe.py <hf_repo_id> <wav_path>
# stdin:  none
# stdout: exactly ONE JSON line:
#         {"ok":true, "model":"…", "language":"en", "text":"…",
#          "segments":[{"start":0.0,"end":1.5,"text":"…","no_speech_prob":0.01}, ...]}
#         or on failure:
#         {"ok":false, "exit_code":N, "error":"…", "hint":"…", ...}
# stderr: human log (caller may capture for debugging; not parsed)
#
# Exit codes (parallel to experiments/T-0.4/bench.py):
#   0  ok
#   2  bad_argv
#   3  not_apple_silicon
#   4  wav_missing
#   5  mlx_import_failed
#   6  model_load_failed   (currently folded into 7 — kept reserved for future split)
#   7  transcribe_failed
#
# This script is **embedded** into the Rust binary via `include_str!("../scripts/transcribe.py")`
# (see `crates/stt-mlx/src/mlx.rs`) and rewritten to `work_dir/transcribe.py` at construction
# time; the source file lives in the repo for human review and rebuild-cache invalidation.
from __future__ import annotations

import json
import platform
import sys
import traceback
from pathlib import Path


def emit(d: dict) -> None:
    sys.stdout.write(json.dumps(d, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(exit_code: int, error: str, hint: str = "", **extra) -> None:
    emit({"ok": False, "exit_code": exit_code, "error": error, "hint": hint, **extra})
    sys.exit(exit_code)


def main() -> None:
    if len(sys.argv) != 3:
        fail(
            2,
            "bad_argv",
            hint="usage: transcribe.py <hf_repo_id> <wav_path>",
            argv=sys.argv,
        )

    hf_repo = sys.argv[1]
    wav_path = sys.argv[2]

    if platform.machine() != "arm64":
        fail(
            3,
            "not_apple_silicon",
            hint=f"machine={platform.machine()} — mlx requires arm64",
            model=hf_repo,
            sample_path=wav_path,
        )

    if not Path(wav_path).is_file():
        fail(4, "wav_missing", hint=f"file not found: {wav_path}")

    try:
        import mlx_whisper  # noqa: F401
        from mlx_whisper.transcribe import transcribe  # type: ignore[import]
    except ImportError as e:
        fail(
            5,
            "mlx_import_failed",
            hint=f"{e!r} — `uv pip install mlx-whisper` and ensure venv active",
            model=hf_repo,
        )
        return  # unreachable; for type checker

    try:
        result = transcribe(
            wav_path,
            path_or_hf_repo=hf_repo,
            verbose=None,
            fp16=True,
        )
    except Exception as e:
        fail(
            7,
            "transcribe_failed",
            hint=f"{type(e).__name__}: {e}",
            model=hf_repo,
            sample_path=wav_path,
            traceback=traceback.format_exc(limit=4),
        )
        return

    text = (result or {}).get("text", "") or ""
    language = (result or {}).get("language", "") or ""
    segs_raw = (result or {}).get("segments", []) or []

    segments: list[dict] = []
    for s in segs_raw:
        if not isinstance(s, dict):
            continue
        seg_text = (s.get("text") or "").strip()
        try:
            seg_start = float(s.get("start", 0.0))
            seg_end = float(s.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        seg_no_speech = s.get("no_speech_prob")
        try:
            seg_no_speech_f = float(seg_no_speech) if seg_no_speech is not None else None
        except (TypeError, ValueError):
            seg_no_speech_f = None
        seg_out = {
            "start": seg_start,
            "end": seg_end,
            "text": seg_text,
        }
        if seg_no_speech_f is not None:
            seg_out["no_speech_prob"] = seg_no_speech_f
        segments.append(seg_out)

    emit(
        {
            "ok": True,
            "model": hf_repo,
            "language": language,
            "text": text.strip(),
            "segments": segments,
        }
    )


if __name__ == "__main__":
    main()
