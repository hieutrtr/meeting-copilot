#!/usr/bin/env python3
# experimental, not for prod — T-0.4 spike: aggregate JSONL → results.{md,json}
"""
Reads out/runs/all.jsonl (one JSON line per (model, sample) bench run, both ok=true and ok=false).
Writes:
  results.json — { host, generated_at, runs: [...], by_model: { short: {pass_count, samples_ok, ...} }, verdict }
  results.md   — human-readable comparison table + verdict line

argv: aggregate.py <jsonl_path> <n_samples_expected>
"""
from __future__ import annotations

import json
import platform
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: aggregate.py <jsonl_path> <n_samples_expected>", file=sys.stderr)
        return 2
    jsonl_path = Path(sys.argv[1])
    n_samples_expected = int(sys.argv[2])

    if not jsonl_path.is_file():
        print(f"FATAL: jsonl not found: {jsonl_path}", file=sys.stderr)
        return 3

    runs: list[dict] = []
    with jsonl_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                runs.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"WARN: skip malformed jsonl line: {e}", file=sys.stderr)

    by_model: dict[str, list[dict]] = defaultdict(list)
    for r in runs:
        short = r.get("model_short") or r.get("model", "unknown")
        by_model[short].append(r)

    summary: dict[str, dict] = {}
    overall_any_eligible_go = False

    for short, rows in by_model.items():
        ok_rows = [r for r in rows if r.get("ok")]
        fail_rows = [r for r in rows if not r.get("ok")]
        rtfs = [r["rtf"] for r in ok_rows]
        pass_rtf = [r for r in ok_rows if r.get("rtf", 1e9) < 1.0]
        pass_count = len(pass_rtf)
        # Per-model verdict (matches task plan AC-5):
        #   5/5 GO ; 3-4/5 CAVEAT-GO ; 0-2/5 NO-GO
        if pass_count == n_samples_expected and len(ok_rows) == n_samples_expected:
            verdict = "GO"
        elif pass_count >= 3:
            verdict = "CAVEAT-GO"
        else:
            verdict = "NO-GO"

        summary[short] = {
            "model": rows[0].get("model") if rows else None,
            "n_runs": len(rows),
            "n_ok": len(ok_rows),
            "n_fail": len(fail_rows),
            "pass_rtf_count": pass_count,
            "pass_rtf_n_of": n_samples_expected,
            "verdict": verdict,
            "rtf_min": round(min(rtfs), 4) if rtfs else None,
            "rtf_max": round(max(rtfs), 4) if rtfs else None,
            "rtf_mean": round(statistics.fmean(rtfs), 4) if rtfs else None,
            "rtf_median": round(statistics.median(rtfs), 4) if rtfs else None,
            "load_ms_mean": round(statistics.fmean([r["load_ms"] for r in ok_rows]), 1) if ok_rows else None,
            "transcribe_ms_mean": round(statistics.fmean([r["transcribe_ms"] for r in ok_rows]), 1) if ok_rows else None,
            "peak_rss_mb_max": round(max(r["peak_rss_mb"] for r in ok_rows), 1) if ok_rows else None,
            "errors": [r.get("error") for r in fail_rows],
        }
        # "production-eligible" = quality ≥ small per ARCH §2.4.
        if short in ("small", "medium", "large-v3", "large-v3-turbo") and verdict in ("GO", "CAVEAT-GO"):
            overall_any_eligible_go = True

    # Pick recommended default model: smallest model with verdict GO; fallback CAVEAT-GO.
    quality_order = ["large-v3", "large-v3-turbo", "medium", "small", "base", "tiny"]
    recommended = None
    for q in quality_order:
        s = summary.get(q)
        if s and s["verdict"] == "GO":
            recommended = q
            break
    if recommended is None:
        for q in quality_order:
            s = summary.get(q)
            if s and s["verdict"] == "CAVEAT-GO":
                recommended = q
                break
    fallback = "Deepgram Nova-2 (cloud)" if not overall_any_eligible_go else "Deepgram Nova-2 (cloud, optional cloud-burst)"

    overall_verdict = "GO" if overall_any_eligible_go else "NO-GO"

    payload = {
        "task": "T-0.4",
        "title": "MLX whisper RTF benchmark",
        "host": {
            "uname": platform.uname()._asdict(),
            "machine": platform.machine(),
            "python": sys.version.split()[0],
        },
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z") or time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "n_samples_expected": n_samples_expected,
        "runs": runs,
        "by_model": summary,
        "overall_verdict": overall_verdict,
        "recommended_default_model": recommended,
        "fallback_recommendation": fallback,
    }

    out_root = Path(__file__).parent
    (out_root / "results.json").write_text(json.dumps(payload, indent=2))

    # ---------- markdown ----------
    md = []
    md.append("# T-0.4 — MLX whisper RTF benchmark — Results\n")
    md.append(f"> Generated: `{payload['generated_at']}`")
    md.append(f"> Host: `{platform.uname().node}` — {platform.machine()} — Python {sys.version.split()[0]}")
    md.append("> See `T-0.4-mlx-whisper-rtf.md` for AC + approach. Per-run JSON in `out/runs/*.json`. Raw transcripts in `out/raw_text/`.\n")
    md.append("## Headline\n")
    md.append(f"- **Overall verdict for UNKNOWN #2 (MLX whisper RTF < 1.0):** **{overall_verdict}**")
    md.append(f"- **Recommended default model:** `{recommended}`" if recommended else "- **Recommended default model:** none (NO-GO across the board)")
    md.append(f"- **Fallback (per IMPLEMENTATION-PLAN.md line 38):** {fallback}\n")

    md.append("## Per-model summary\n")
    md.append("| model | runs ok / total | pass rtf < 1.0 | rtf min | rtf median | rtf mean | rtf max | mean load (ms) | mean transcribe (ms) | peak RSS (MB) | verdict |")
    md.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for short in quality_order:
        s = summary.get(short)
        if not s:
            continue
        cells = [
            f"`{short}`",
            f"{s['n_ok']}/{s['n_runs']}",
            f"{s['pass_rtf_count']}/{s['pass_rtf_n_of']}",
            f"{s['rtf_min']:.3f}" if s['rtf_min'] is not None else "—",
            f"{s['rtf_median']:.3f}" if s['rtf_median'] is not None else "—",
            f"{s['rtf_mean']:.3f}" if s['rtf_mean'] is not None else "—",
            f"{s['rtf_max']:.3f}" if s['rtf_max'] is not None else "—",
            f"{s['load_ms_mean']:.0f}" if s['load_ms_mean'] is not None else "—",
            f"{s['transcribe_ms_mean']:.0f}" if s['transcribe_ms_mean'] is not None else "—",
            f"{s['peak_rss_mb_max']:.0f}" if s['peak_rss_mb_max'] is not None else "—",
            f"**{s['verdict']}**",
        ]
        md.append("| " + " | ".join(cells) + " |")
    md.append("")

    md.append("## Per-run detail\n")
    md.append("| model | sample | audio (s) | load (ms) | transcribe (ms) | rtf | rtf+load | peak RSS (MB) | text chars | ok |")
    md.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for r in sorted(runs, key=lambda x: (quality_order.index(x.get('model_short','tiny')) if x.get('model_short') in quality_order else 99, x.get('sample_idx', 0))):
        if r.get("ok"):
            md.append(
                "| `{m}` | {i} | {a} | {l} | {t} | {rtf:.3f} | {rwl:.3f} | {p:.0f} | {tc} | ok |".format(
                    m=r.get("model_short"),
                    i=r.get("sample_idx"),
                    a=f"{r.get('audio_seconds', 0):.2f}",
                    l=f"{r.get('load_ms', 0):.0f}",
                    t=f"{r.get('transcribe_ms', 0):.0f}",
                    rtf=r.get("rtf", 0),
                    rwl=r.get("rtf_with_load", 0),
                    p=r.get("peak_rss_mb", 0),
                    tc=r.get("text_chars", 0),
                )
            )
        else:
            md.append(
                "| `{m}` | {i} | — | — | — | — | — | — | — | **FAIL: `{e}`** |".format(
                    m=r.get("model_short", "?"),
                    i=r.get("sample_idx", "?"),
                    e=r.get("error", "?"),
                )
            )
    md.append("")

    md.append("## Verdict line (numeric)\n")
    if recommended:
        s = summary[recommended]
        md.append(
            f"`{recommended}` passed RTF < 1.0 on **{s['pass_rtf_count']}/{n_samples_expected}** samples "
            f"(rtf median = **{s['rtf_median']:.3f}**, mean load = **{s['load_ms_mean']:.0f} ms**, peak RSS = **{s['peak_rss_mb_max']:.0f} MB**) "
            f"→ {s['verdict']}. UNKNOWN #2 overall: **{overall_verdict}**."
        )
    else:
        md.append(
            f"No production-eligible model met the RTF < 1.0 bar. UNKNOWN #2 overall: **{overall_verdict}**. "
            f"Pivot: switch Phase 1 default to {fallback}."
        )
    md.append("")

    md.append("## Caveats\n")
    md.append("- **Host vs target spec.** Bench host is M1 Max / 64 GB; target spec is M1 Pro / 16 GB. Estimate ~1.3–1.7× slower on target. CAVEAT-GO on this host should re-measure on M1 Pro before Phase 1 commit. NO-GO on this host ⇒ definitely NO-GO on target.")
    md.append("- **Batch vs streaming gap.** This bench runs `transcribe()` over a complete WAV. Streaming wrapper (Phase 1 T-1.5) will add chunk overhead and window-seam re-decode — expect 1.2–1.5× slower in streaming mode.")
    md.append("- **TTS audio is easier than real meetings.** `say`-generated audio has no overlap, no background noise, single speaker — RTF here is a *best-case* number. Production audio may push RTF up by 5–15 % per anecdotal MLX whisper threads.")
    md.append("- **Cold-start `load_ms` includes mlx_whisper module import.** First model in a process has the heaviest load; subsequent loads in the same process amortize. Per-row `load_ms` reflects cold-start because each row is a fresh subprocess.")
    md.append("")

    (out_root / "results.md").write_text("\n".join(md))
    print(f"wrote results.md ({sum(len(l) for l in md)} chars) and results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
