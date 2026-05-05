#!/usr/bin/env python3
# experimental, not for prod — T-0.4 spike: single-shot MLX whisper RTF bench
"""
One subprocess invocation = one (model, sample) pair.

stdin: none
argv:  bench.py <hf_repo_id> <wav_path> <sample_idx>
stdout: exactly one JSON line with the measurement
stderr: human log
exit:  0 ok ; 2 bad-argv ; 3 not-apple-silicon ; 4 wav-missing ;
       5 mlx-import-failed ; 6 model-load-failed ; 7 transcribe-failed ;
       8 wave-read-failed
"""
from __future__ import annotations

import json
import os
import platform
import resource
import sys
import time
import traceback
import wave
from pathlib import Path


def emit(d: dict) -> None:
    sys.stdout.write(json.dumps(d, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(exit_code: int, error: str, hint: str = "", **extra) -> None:
    rec = {
        "ok": False,
        "exit_code": exit_code,
        "error": error,
        "hint": hint,
        **extra,
    }
    emit(rec)
    sys.exit(exit_code)


def peak_rss_bytes() -> int:
    # macOS: ru_maxrss reported in BYTES (BSD); Linux: kilobytes.
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return int(rss)
    return int(rss) * 1024


def wav_duration_seconds(path: str) -> float:
    with wave.open(path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
    if rate == 0:
        raise ValueError("wav frame rate is zero")
    return frames / float(rate)


def main() -> None:
    if len(sys.argv) != 4:
        fail(
            2,
            "bad_argv",
            hint="usage: bench.py <hf_repo_id> <wav_path> <sample_idx>",
            argv=sys.argv,
        )

    hf_repo = sys.argv[1]
    wav_path = sys.argv[2]
    try:
        sample_idx = int(sys.argv[3])
    except ValueError:
        fail(2, "bad_argv", hint="sample_idx must be int")
        return  # unreachable; for type-checker

    model_short = hf_repo.split("/")[-1].replace("whisper-", "").replace("-mlx", "")

    if platform.machine() != "arm64":
        fail(
            3,
            "not_apple_silicon",
            hint=f"machine={platform.machine()} — mlx requires arm64",
            model=hf_repo,
            sample_path=wav_path,
            sample_idx=sample_idx,
        )

    if not Path(wav_path).is_file():
        fail(4, "wav_missing", hint=f"file not found: {wav_path}")

    try:
        audio_seconds = wav_duration_seconds(wav_path)
    except Exception as e:
        fail(8, "wave_read_failed", hint=str(e), sample_path=wav_path)
        return

    # mlx_whisper exposes transcribe(audio, path_or_hf_repo=...) — public since v0.4.
    # Load + transcribe are split here only conceptually; mlx_whisper.transcribe is one call
    # that internally loads on first use. We measure load by calling load_model explicitly
    # if available, else attribute the wall delta to load when transcribe() is hit cold.
    try:
        load_t0 = time.perf_counter()
        import mlx_whisper  # noqa: F401  — module-load latency is part of "load_ms"
        from mlx_whisper.load_models import load_model  # type: ignore[import]

        # load_model accepts path_or_hf_repo and a dtype; default float16
        model = load_model(hf_repo)  # noqa: F841 — held to keep weights resident
        load_ms = (time.perf_counter() - load_t0) * 1000.0
    except ImportError as e:
        fail(
            5,
            "mlx_import_failed",
            hint=f"{e!r} — `uv pip install mlx-whisper` and ensure venv active",
            model=hf_repo,
        )
        return
    except Exception as e:
        fail(
            6,
            "model_load_failed",
            hint=f"{type(e).__name__}: {e}",
            model=hf_repo,
            traceback=traceback.format_exc(limit=4),
        )
        return

    try:
        from mlx_whisper.transcribe import transcribe  # type: ignore[import]

        trans_t0 = time.perf_counter()
        result = transcribe(
            wav_path,
            path_or_hf_repo=hf_repo,
            verbose=None,
            fp16=True,
        )
        transcribe_ms = (time.perf_counter() - trans_t0) * 1000.0
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

    text = (result or {}).get("text", "")
    language = (result or {}).get("language", "")

    # Save raw text for sanity check (separate file, not in the JSON line).
    raw_dir = Path(__file__).parent / "out" / "raw_text"
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / f"{model_short}-{sample_idx:02d}.txt"
    raw_path.write_text(text, encoding="utf-8")

    wall_total_ms = load_ms + transcribe_ms
    rtf = (transcribe_ms / 1000.0) / audio_seconds
    rtf_with_load = (wall_total_ms / 1000.0) / audio_seconds

    rss = peak_rss_bytes()

    emit({
        "ok": True,
        "model": hf_repo,
        "model_short": model_short,
        "sample_path": wav_path,
        "sample_idx": sample_idx,
        "audio_seconds": round(audio_seconds, 3),
        "load_ms": round(load_ms, 1),
        "transcribe_ms": round(transcribe_ms, 1),
        "wall_total_ms": round(wall_total_ms, 1),
        "rtf": round(rtf, 4),
        "rtf_with_load": round(rtf_with_load, 4),
        "peak_rss_bytes": rss,
        "peak_rss_mb": round(rss / (1024 * 1024), 1),
        "text_chars": len(text),
        "language": language,
    })


if __name__ == "__main__":
    main()
