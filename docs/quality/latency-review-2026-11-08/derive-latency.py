"""Derive critical-path bounds from recorded measurements; no model calls."""
import json
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
study = json.loads((ROOT / "docs/quality/evidence/novel-three-results-2026-11-08.json").read_text())
rows = study["rows"]
phases = ["query", "disclose", "ready", "semantic-review"]
total = sum(r["durationMs"] for r in rows)
phase_ms = {phase: sum(p["httpDurationMs"] for r in rows for p in r["phases"] if p["phase"] == phase) for phase in phases}
body_tokens = sum(p["outputTokens"] for r in rows for p in r["phases"] if p["phase"] == "ready")
rate = body_tokens / (phase_ms["ready"] / 1000)
records = json.loads((ROOT / "artifacts/novel-three-2026-11-08/records.json").read_text())
size = lambda v: len(json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
field_rows = []
for r in records:
    if r.get("value", {}).get("kind") != "ready":
        continue
    value = r["value"]
    field_rows.append({"taskId": r["taskId"], "postDecodeValueBytes": size(value), "fieldBytes": {k: size(v) for k, v in value.items()}, "inputSystemBytes": len(r["system"].encode()), "inputSchemaBytes": size(r["schema"]), "inputDataBytes": size(r["data"])})
result = {
    "sampleCount": len(rows),
    "measurement": "Recorded client HTTP durations include provider processing, queueing and network; not a decode-only GPU benchmark. Tiny differences include local work, reservation and parsing.",
    "meanWallSeconds": mean(r["durationMs"] for r in rows) / 1000,
    "meanPhaseSeconds": {p: phase_ms[p] / len(rows) / 1000 for p in phases},
    "phasePercentOfWall": {p: phase_ms[p] / total * 100 for p in phases},
    "allApiPercentOfWall": sum(phase_ms.values()) / total * 100,
    "localAndOtherMeanSeconds": (total - sum(phase_ms.values())) / len(rows) / 1000,
    "meanBodyOutputTokens": body_tokens / len(rows),
    "effectiveBodyOutputTokensPerSecond": rate,
    "unchangedBodyOptimisticFloorSeconds": phase_ms["ready"] / len(rows) / 1000,
    "requiredSpeedupToThreeSeconds": total / len(rows) / 3000,
    "requiredSpeedupToTwoSeconds": total / len(rows) / 2000,
    "sameMeasuredRateThreeSecondOutputCeilingIgnoringAllOtherWork": rate * 3,
    "hypotheticalHalfOutputBodySecondsIgnoringAllOtherWork": phase_ms["ready"] / len(rows) / 2000,
    "readyWithinThreeSeconds": 0,
    "deliveryReady": study["normalDeliveryReady"],
    "newUsedBodyScoreMean": study["meanContentScore"],
    "cacheProbe": "cache-probe.json: local exact-goal reuse only; not a remote production SLO",
    "semanticCacheCoverageExample": {"equation": "P(ready_and_correct_within_3s) = H * P_fast + (1-H) * P_cold", "assumptions": "Hypothetical target arithmetic only: P_fast=0.99 and P_cold=0, both unmeasured in the actual host.", "desiredFraction": 0.95, "requiredH": 0.95 / 0.99},
    "fieldSizes": field_rows,
    "limits": "Output-rate extrapolation is illustrative, not a forecast for smaller outputs or another model. No TTFT or concurrency measurement. Post-decode JSON field sizes are byte counts, not token attribution or exact provider wire size.",
}
(OUT / "latency-analysis.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k: v for k, v in result.items() if k != "fieldSizes"}))
