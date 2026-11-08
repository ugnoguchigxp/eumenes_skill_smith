"""Summarize every frozen attempt. Pending is never a fast-ready success."""
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
raw = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "artifacts/approved-selection-v1"
load = lambda name: json.loads((raw / name).read_text())
rows, records = load("attempts.json"), load("records.json")
suite = json.loads((Path(__file__).parent / "selection-suite.json").read_text())
assert len(rows) == len(suite["cases"]) * suite["repetitions"] == len(records)
assert len({r["attempt"] for r in rows}) == len(rows)

def stats(group):
    durations = sorted(r["durationMs"] for r in group)
    return {
        "attempts": len(group),
        "correct": sum(r["correct"] for r in group),
        "ready": sum(r["kind"] == "ready" for r in group),
        "usableReadyWithin3000Ms": sum(r["usableWithinTarget"] for r in group),
        "meanMs": statistics.mean(durations),
        "medianMs": statistics.median(durations),
        "p95Ms": durations[math.ceil(len(durations) * .95) - 1],
        "maxMs": max(durations),
    }

def usage(key):
    known = [r[key] for r in records if isinstance(r.get(key), int)]
    return {"knownTotal": sum(known), "knownCalls": len(known), "missingCalls": len(records) - len(known)}

for r in rows:
    assert r["correct"]
    assert r["usableWithinTarget"] == bool(r["expected"] and r["kind"] == "ready" and r["durationMs"] <= 3000)
    if r["kind"] == "ready":
        packet = r["reply"]
        assert packet["contractVersion"] == "skillsmith.delivery.v1"
        assert "build" not in packet
        for f in [packet["skill"], *packet["skill"]["files"]]:
            assert hashlib.sha256(f["content"].encode()).hexdigest() == f["digest"]
    assert sum(c["kind"] == "modelCalls" for c in r["calls"]) == 1

latest = {}
for line in (root / "artifacts/practical-2026-11-08/costs.jsonl").read_text().splitlines():
    item = json.loads(line)
    latest[item["id"]] = item
known = sum(r.get("costUsd", 0) for r in latest.values())
held = sum(r["reservedUsd"] for r in latest.values() if "costUsd" not in r)
assert known + held <= 15
assert math.isclose(known + held, load("budget.json")["accountedUsd"])
summary = {
    "complete": load("complete.json")["complete"],
    "implementationCommit": "f455f97314f72617c6c04424216994e0a62e83e8",
    "model": "gpt-4.1-mini",
    "allAttempts": stats(rows),
    "compatible": stats([r for r in rows if r["expected"]]),
    "incompatible": stats([r for r in rows if not r["expected"]]),
    "tokens": {k: usage(k) for k in ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]},
    "cost": {**load("budget.json"), "knownPriceEstimateUsd": known, "heldUnknownReservationsUsd": held, "unknownCalls": sum("costUsd" not in r for r in latest.values())},
    "deliveryRegression": load("delivery-regression.json"),
    "scope": load("complete.json")["scope"],
    "limitations": ["Three development artifacts; six task cases repeated ten times, not sixty independent topics.", "Pending is 30/60 overall; only 30/60 overall requests received a usable skill.", "Prior generation and review were performed before measurement. Cold detailed generation remains unproven at three seconds.", "Source version I/O is local fixture only. Production owner approval, source and host integrations are not exercised.", "Reference content remains the exact previously graded 98/98/94 artifacts; no new body-quality grade is invented.", "p95 uses nearest rank on thirty positive attempts; no population-wide SLO or load-capacity guarantee.", "Cached input and reasoning tokens are already included in input/output; do not add them again."],
}
(Path(__file__).parent / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
