# T-0.4 — MLX whisper RTF benchmark — Results

> Generated: `2026-05-05T19:33:48+0700`
> Host: `192.168.2.9` — arm64 — Python 3.12.12
> See `T-0.4-mlx-whisper-rtf.md` for AC + approach. Per-run JSON in `out/runs/*.json`. Raw transcripts in `out/raw_text/`.

## Headline

- **Overall verdict for UNKNOWN #2 (MLX whisper RTF < 1.0):** **GO**
- **Recommended default model:** `large-v3-turbo`
- **Fallback (per IMPLEMENTATION-PLAN.md line 38):** Deepgram Nova-2 (cloud, optional cloud-burst)

## Per-model summary

| model | runs ok / total | pass rtf < 1.0 | rtf min | rtf median | rtf mean | rtf max | mean load (ms) | mean transcribe (ms) | peak RSS (MB) | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `large-v3-turbo` | 5/5 | 5/5 | 0.041 | 0.229 | 0.196 | 0.256 | 1319 | 11732 | 3326 | **GO** |
| `medium` | 5/5 | 5/5 | 0.052 | 0.059 | 0.058 | 0.061 | 28756 | 3467 | 4386 | **GO** |
| `small` | 5/5 | 5/5 | 0.027 | 0.029 | 0.030 | 0.037 | 10356 | 1808 | 1784 | **GO** |
| `tiny` | 5/5 | 5/5 | 0.014 | 0.016 | 0.016 | 0.017 | 1186 | 944 | 438 | **GO** |

## Per-run detail

| model | sample | audio (s) | load (ms) | transcribe (ms) | rtf | rtf+load | peak RSS (MB) | text chars | ok |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `large-v3-turbo` | 1 | 60.00 | 1685 | 2436 | 0.041 | 0.069 | 3309 | 977 | ok |
| `large-v3-turbo` | 2 | 60.00 | 1217 | 15344 | 0.256 | 0.276 | 3325 | 1819 | ok |
| `large-v3-turbo` | 3 | 60.00 | 1222 | 13897 | 0.232 | 0.252 | 3324 | 1395 | ok |
| `large-v3-turbo` | 4 | 60.00 | 1230 | 13254 | 0.221 | 0.241 | 3324 | 1755 | ok |
| `large-v3-turbo` | 5 | 60.00 | 1240 | 13728 | 0.229 | 0.249 | 3326 | 1601 | ok |
| `medium` | 1 | 60.00 | 137899 | 3526 | 0.059 | 2.357 | 4386 | 981 | ok |
| `medium` | 2 | 60.00 | 1454 | 3642 | 0.061 | 0.085 | 3403 | 911 | ok |
| `medium` | 3 | 60.00 | 1473 | 3511 | 0.059 | 0.083 | 3405 | 834 | ok |
| `medium` | 4 | 60.00 | 1467 | 3143 | 0.052 | 0.077 | 3389 | 739 | ok |
| `medium` | 5 | 60.00 | 1485 | 3514 | 0.059 | 0.083 | 3401 | 804 | ok |
| `small` | 1 | 60.00 | 46670 | 1710 | 0.029 | 0.806 | 1784 | 987 | ok |
| `small` | 2 | 60.00 | 1267 | 2233 | 0.037 | 0.058 | 1340 | 1261 | ok |
| `small` | 3 | 60.00 | 1333 | 1726 | 0.029 | 0.051 | 1319 | 836 | ok |
| `small` | 4 | 60.00 | 1260 | 1630 | 0.027 | 0.048 | 1321 | 859 | ok |
| `small` | 5 | 60.00 | 1251 | 1742 | 0.029 | 0.050 | 1331 | 809 | ok |
| `tiny` | 1 | 60.00 | 1162 | 873 | 0.015 | 0.034 | 437 | 989 | ok |
| `tiny` | 2 | 60.00 | 1165 | 1024 | 0.017 | 0.036 | 438 | 912 | ok |
| `tiny` | 3 | 60.00 | 1201 | 935 | 0.016 | 0.036 | 437 | 854 | ok |
| `tiny` | 4 | 60.00 | 1228 | 864 | 0.014 | 0.035 | 437 | 853 | ok |
| `tiny` | 5 | 60.00 | 1172 | 1023 | 0.017 | 0.037 | 438 | 811 | ok |

## Verdict line (numeric)

`large-v3-turbo` passed RTF < 1.0 on **5/5** samples (rtf median = **0.229**, mean load = **1319 ms**, peak RSS = **3326 MB**) → GO. UNKNOWN #2 overall: **GO**.

## Caveats

- **Host vs target spec.** Bench host is M1 Max / 64 GB; target spec is M1 Pro / 16 GB. Estimate ~1.3–1.7× slower on target. CAVEAT-GO on this host should re-measure on M1 Pro before Phase 1 commit. NO-GO on this host ⇒ definitely NO-GO on target.
- **Batch vs streaming gap.** This bench runs `transcribe()` over a complete WAV. Streaming wrapper (Phase 1 T-1.5) will add chunk overhead and window-seam re-decode — expect 1.2–1.5× slower in streaming mode.
- **TTS audio is easier than real meetings.** `say`-generated audio has no overlap, no background noise, single speaker — RTF here is a *best-case* number. Production audio may push RTF up by 5–15 % per anecdotal MLX whisper threads.
- **Cold-start `load_ms` includes mlx_whisper module import.** First model in a process has the heaviest load; subsequent loads in the same process amortize. Per-row `load_ms` reflects cold-start because each row is a fresh subprocess.
- **First sample of each model includes HF download time, not just load.** The `out/runs/<model>-01.json` row for `small`, `medium`, `large-v3-turbo` includes a one-time download into `~/.cache/huggingface/hub/`. Per-model "warm load" (samples 2..5, post-cache) is the production-relevant number — see Findings table below.

## Findings & post-hoc analysis

### 1. "Warm load" (post-download) is what production sees

`load_ms` mean is bloated by the first-sample cold-cache download. Recomputed mean across samples 2..5 (post-download):

| model | first-sample load (incl. HF download) | warm load mean (samples 2..5) | model size on disk |
|---|---:|---:|---|
| `tiny` | 1162 ms (already cached pre-bench) | ~1192 ms | ~75 MB |
| `small` | 46670 ms (download dominates) | ~1278 ms | ~480 MB |
| `medium` | 137899 ms (download dominates) | ~1470 ms | ~1.5 GB |
| `large-v3-turbo` | 1685 ms (already cached from prior tinkering) | ~1227 ms | ~1.5 GB |

**Implication:** in production with model pre-cached, **all four models load in ~1.2–1.5s cold from disk** — fast enough for app startup. Phase 1 onboarding should pre-download the chosen model during the install wizard so users don't see a 1–2 minute wait on first meeting.

### 2. `large-v3-turbo` triggers Whisper's silence-hallucination loop on padded audio

Sample 1 `large-v3-turbo` finished in 2436 ms (rtf=0.041); samples 2–5 took 13254–15344 ms (rtf=0.221–0.256). Investigating `out/raw_text/large-v3-turbo-02.txt` reveals a runaway `Good Good Good ...` token sequence after the legitimate questions. Cause: `gen_samples.sh` uses `apad,atrim=0:60` to pad/trim every sample to exactly 60 s; when `say` produced <60 s, the trailing silence triggers the well-documented Whisper failure mode where the decoder doesn't emit EOS and runs to max-tokens. `tiny`/`small`/`medium` are robust to this; `large-v3-turbo` is not.

This is NOT a benchmark artifact to "fix" — production audio also has silence (long pauses in meetings). It is a **finding for the spike memo**: any production deployment of `large-v3-turbo` MUST add VAD-based silence trimming (per ARCH §2.4 "30s sliding window + VAD (Silero) để cắt utterance") or the runaway will inflate compute cost ~6× per silent chunk. `medium` is the safer pick if VAD isn't yet wired.

The 0.256 RTF figure for `large-v3-turbo` includes the runaway. The "no-runaway" RTF for sample 1 (0.041) is the true compute cost on this hardware. Memo (T-0.6) should record both numbers.

### 3. RTF headroom on M1 Max → on M1 Pro 16 GB target

Conservative scaling factor (1.7×) applied to the worst observed RTF per model:

| model | M1 Max rtf max | scaled M1 Pro est (×1.7) | margin to 1.0 |
|---|---:|---:|---:|
| `tiny` | 0.017 | ~0.029 | 34× |
| `small` | 0.037 | ~0.063 | 16× |
| `medium` | 0.061 | ~0.104 | 9.6× |
| `large-v3-turbo` | 0.256 | ~0.435 | 2.3× |

Even with the runaway, `large-v3-turbo` clears the bar by 2.3×. With VAD added (Finding #2), expect the worst-case M1 Pro RTF to drop to ~0.10 (matching `medium`).

### 4. Memory profile

Peak RSS ranges:
- `tiny`: ~437 MB (fits easily on 16 GB target)
- `small`: ~1.3–1.8 GB (fine)
- `medium`: ~3.4 GB (~21% of M1 Pro 16 GB — fine, leaves room for Tauri + Claude streaming)
- `large-v3-turbo`: ~3.3 GB (same envelope as medium)

No model OOMs the 16 GB target. The first-sample peak for `medium` (4386 MB) reflects a transient during weight loading; subsequent samples settle to ~3.4 GB.

### 5. Recommended default (preliminary, pre-T-0.6 memo)

- **Phase 1 default: `medium`.** Reason: (a) zero hallucination risk pre-VAD; (b) RTF ~0.06 leaves ~16× headroom for the streaming wrapper (T-1.5); (c) memory profile fits 16 GB target; (d) accuracy is "good enough" for non-domain-specialized transcription per public WER comparisons (medium ≈ 9% WER on LibriSpeech vs large-v3 ≈ 7%).
- **Phase 2/3 upgrade: `large-v3-turbo`** once VAD silence-trimming is wired (per ARCH §2.4) and accuracy benchmarks justify the swap. The 0.256 RTF is acceptable but only with VAD.
- **Cloud fallback (per IMPLEMENTATION-PLAN.md line 38): `Deepgram Nova-2`.** Triggered if (a) user is on a non-Apple-Silicon device, or (b) cold-cache install latency is unacceptable for some users. Deepgram quote: ~$0.26/hour streaming.

The aggregator picked `large-v3-turbo` automatically because it iterated quality-first and `large-v3-turbo` was GO; the manual override above prefers `medium` until VAD lands. T-0.6 memo will make the final call.
