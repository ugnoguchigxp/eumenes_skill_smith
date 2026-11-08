"""Rebuild token accounting and frozen grading materials; never calls a model."""
import json
import re
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "artifacts/skill-grades-2026-11-08"
OUT.mkdir(parents=True, exist_ok=True)


def read(path):
    return json.loads(path.read_text())


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


suite = read(ROOT / "docs/quality/practical-suite.json")
by_goal = {t["goal"]: t for t in suite["tasks"]}
latest = {}
for line in (ROOT / "artifacts/practical-2026-11-08/costs.jsonl").read_text().splitlines():
    event = json.loads(line)
    latest[event["id"]] = event
events = list(latest.values())
# Successful records additionally preserve cached-input details, absent from the journal.
receipt_snapshot = OUT / "usage-receipts.json"
receipts = read(receipt_snapshot) if receipt_snapshot.exists() else {}
for path in (ROOT / "artifacts").glob("**/records.json"):
    data = read(path)
    if not isinstance(data, list):
        continue
    for record in data:
        response = record.get("response", record)
        if isinstance(response, dict) and response.get("receipt"):
            receipts[response["receipt"]] = {k: response[k] for k in ("inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens") if k in response}
save("usage-receipts.json", receipts)


def total(rows):
    result = {"physicalCalls": len(rows)}
    for key in ("inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"):
        values = []
        for row in rows:
            value = row.get(key)
            if value is None:
                value = receipts.get(row.get("responseId"), {}).get(key)
            values.append(value)
        result[key] = {
            "measuredSubtotal": sum(v for v in values if v is not None),
            "unknownCalls": sum(v is None for v in values),
        }
    result["knownCostUsd"] = sum(e.get("costUsd", 0) for e in rows)
    result["unsettledReservedUsd"] = sum(e["reservedUsd"] for e in rows if "costUsd" not in e)
    return result


batches = []
for name in ("practical-planning-final", "generation-rerun", "generation-scoped", "generation-headroom"):
    folder = ROOT / ("artifacts/" + name + "-2026-11-08")
    records = read(folder / "records.json")
    generation_records = {r["receipt"]: r for r in records if r["providerSettings"]["generation"]["sample"] in ("reformulation", "quality-build")}
    indices = [i for i, e in enumerate(events) if e.get("responseId") in generation_records]
    selected = [e for e in events[min(indices):max(indices) + 1] if e["purpose"] in ("reformulation", "quality-build")]
    assert sum(e["purpose"] == "reformulation" for e in selected) == 20
    grouped = {}
    task_id = None
    for e in selected:
        record = generation_records.get(e.get("responseId"))
        if e["purpose"] == "reformulation":
            task_id = by_goal[record["data"]["searchTask"]]["id"]
            assert task_id not in grouped
            grouped[task_id] = []
        grouped[task_id].append(e)
    per_task = []
    for task in suite["tasks"]:
        rows = grouped[task["id"]]
        phases = {}
        for e in rows:
            r = generation_records.get(e.get("responseId"))
            phase = "query" if e["purpose"] == "reformulation" else "semantic-review" if r and "originalTask" in r["data"] else "build-and-disclosure"
            phases.setdefault(phase, []).append(e)
        per_task.append({"taskId": task["id"], **total(rows), "phases": {k: total(v) for k, v in phases.items()}, "eventIds": [e["id"] for e in rows]})
    batches.append({"condition": name, **total(selected), "perTask": per_task})
save("generation-tokens.json", {"definition": "API-reported usage; reasoning is included in output and cached input is included in input. Unknown is not zero. Costs conservatively charge cached input at full rate.", "batches": batches, "global": total(events)})

folder = ROOT / "artifacts/generation-scoped-2026-11-08"
records = read(folder / "records.json")
skills = read(folder / "skills.json")
failed = list(read(folder / "failed-inputs.json").values())
incomplete = list(read(folder / "incomplete-responses.json").values())
materials = []
for task in suite["tasks"]:
    if task["id"] in skills:
        skill = skills[task["id"]]
        review = next(r for r in records if r["data"].get("originalTask", {}).get("goal") == task["goal"])
        item = review["data"]["untrustedReview"]["items"][0]
        artifact = {"status": "complete-artifact", "main": skill["content"], "files": skill["files"], "bundleDigest": skill["bundleDigest"]}
        sources = item["sources"]
        verification = "All self-contained reference code examples executed successfully in isolation; this proves fixture behavior only, not production operations."
    else:
        request = next((r for r in failed if r["data"].get("task", {}).get("goal") == task["goal"]), None)
        if request is None:
            continue  # Five deliberate needs_input decisions are not generated skills.
        assert task["id"] in ("permanent-queue", "queue-migration")
        provider_input = {key: request[key] for key in ("system", "data", "schema", "requestRef", "deadlineAt", "maxOutputTokens")}
        request_digest = hashlib.sha256(json.dumps(provider_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        fragment = next(i for i in incomplete if i["requestDigest"] == request_digest)
        def subtree(key):
            match = re.search(r'(?<!\\)"' + key + r'"\s*:', fragment["outputText"])
            assert match
            return json.JSONDecoder().raw_decode(fragment["outputText"][match.end():].lstrip())[0]
        artifact = {"status": "partial-envelope-body-only", "document": subtree("document"), "localizedInstructions": subtree("localizedInstructions"), "rawResponseId": fragment["responseId"], "limitation": "Outer JSON and final metadata are truncated; grade only the complete body and references, never treat this as a published/validated SkillArtifact."}
        sources = request["data"]["untrustedEvidence"]["items"]
        verification = "Body and references extracted as complete JSON subtrees only; no semantic approval or execution verification."
    materials.append({"taskId": task["id"], "taskContext": {"goal": task["goal"], "acceptance": task["acceptance"], "constraints": read(ROOT / "docs/quality/cloud-eval-generation-settings.json")["taskConstraints"]}, "acceptanceCriteria": task["withheldChecks"], "artifactToEvaluate": artifact, "sourceEvidence": sources, "verificationEvidence": verification})
assert len(materials) == 15
save("materials.json", materials)
print(json.dumps({"batches": [{k: v for k, v in b.items() if k != "perTask"} for b in batches], "materials": len(materials)}, ensure_ascii=False, indent=2))
