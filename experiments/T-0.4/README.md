# T-0.4 — MLX whisper RTF benchmark (UNKNOWN #2)

> experimental, not for prod. Throwaway spike.

Measures `mlx-whisper` Real-Time Factor (RTF = wall_seconds / audio_seconds) on Apple Silicon for `tiny`, `small`, `medium`, and `large-v3-turbo`. UNKNOWN #2 (per `docs/spike-memo.md` plan + `docs/tasks/phase-0/INDEX.md`): is MLX local STT real-time-capable on this hardware class?

## Reproduce

```sh
cd experiments/T-0.4
./run.sh
```

Quick smoke (1 model × 1 sample, ~30s):

```sh
MODELS=tiny N_SAMPLES=1 ./run.sh
```

Full default run benches **4 models × 5 samples = 20 transcriptions**. First run downloads ~3.5 GB of HuggingFace weights into `~/.cache/huggingface/hub/`; subsequent runs hit cache.

## Outputs

| Path | Content |
|---|---|
| `results.md` | Markdown table (per-model summary + per-run detail) + verdict line |
| `results.json` | Canonical metrics (per-row + per-model summary + recommendation) |
| `out/runs/<short>-<idx>.json` | One JSON line per (model, sample) bench, raw |
| `out/runs/all.jsonl` | Concatenated JSONL of all runs |
| `out/raw_text/<short>-<idx>.txt` | Sanity check — actual transcript text |
| `out/run.log` | Full execution log (timestamps, install output, per-row summary) |
| `out/samples/0[1-5].wav` | 5 × 60s synthesized sample audio (16 kHz mono PCM_S16LE) |

## Files

| File | Purpose |
|---|---|
| `bench.py` | Single (model, sample) bench. Run as subprocess for clean per-invocation peak RSS. |
| `gen_samples.sh` | Generates 5 × 60s WAVs via macOS `say` + `ffmpeg`. Idempotent. |
| `run.sh` | Orchestrator. uv venv → install → samples → bench loop → aggregate. |
| `aggregate.py` | JSONL → `results.{md,json}`. Computes per-model verdict + recommended default. |

## Configuration

Env vars on `run.sh`:

| Var | Default | Effect |
|---|---|---|
| `MODELS` | `tiny,small,medium,large-v3-turbo` | Comma-separated model short names |
| `N_SAMPLES` | `5` | Samples per model (1..5) |
| `PYTHON_VERSION` | `3.12` | uv venv interpreter |
| `FAIL_FAST` | `0` | If `1`, abort the loop on the first bench-subprocess failure |

Model short-name → HF repo mapping is in `run.sh`. Add a new model by extending `MODEL_REPO`.

## Verdict logic (per `T-0.4-mlx-whisper-rtf.md` AC-5)

For each model: count samples with `rtf < 1.0`.

| pass count | per-model verdict |
|---|---|
| 5/5 | GO |
| 3–4/5 | CAVEAT-GO (variance — note worst sample) |
| 0–2/5 | NO-GO for production default; eligible only as cloud-burst fallback |

**Overall** UNKNOWN #2 verdict: GO iff at least one model with quality ≥ `small` is GO/CAVEAT-GO. Otherwise NO-GO → pivot to Deepgram per `IMPLEMENTATION-PLAN.md` line 38.

## bench.py exit codes

| code | error | hint |
|---|---|---|
| 0 | (ok) | one JSON line on stdout |
| 2 | bad_argv | usage: `bench.py <hf_repo> <wav> <idx>` |
| 3 | not_apple_silicon | mlx requires arm64 |
| 4 | wav_missing | sample file not found |
| 5 | mlx_import_failed | `uv pip install mlx-whisper` and ensure venv active |
| 6 | model_load_failed | HF download / corrupt cache / OOM at load |
| 7 | transcribe_failed | runtime error during transcribe() |
| 8 | wave_read_failed | WAV malformed |

## Caveats (must surface in spike memo)

- **Host stronger than target.** Bench M1 Max / 64 GB vs spec M1 Pro / 16 GB. Numbers optimistic; estimate 1.3–1.7× slower on target. NO-GO here ⇒ definitely NO-GO on target. CAVEAT-GO here ⇒ requires re-measure on target.
- **Batch RTF only.** Streaming wrapper (raw plan T-0.4 → loop-deferred to Phase 1 T-1.5) will add 1.2–1.5× overhead. Batch RTF here is a *necessary* condition, not sufficient.
- **TTS audio is best case.** Real meetings (overlap, noise, multiple speakers) will push RTF up.

## Cleanup

`out/samples/`, `out/runs/`, `out/raw_text/`, `out/run.log`, `.venv/` are throwaway. Only `results.{md,json}` + scripts are durable.
