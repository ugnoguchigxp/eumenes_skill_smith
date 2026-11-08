# -*- coding: utf-8 -*-
"""Summarize preregistered fresh generation, recorded timings, grading and byte failures."""
import hashlib
import json
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "docs/quality/evidence"
BASE = ROOT / "artifacts/novel-three-2026-11-08"


def read(path):
    return json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


suite = read(ROOT / "docs/quality/novel-three-suite-2026-11-08.json")
records = read(BASE / "records.json")
skills = read(BASE / "reviewed-skills.json")
delivery_skills = read(BASE / "skills.json")
timings = read(BASE / "timings.json")
api_timings = read(BASE / "api-timings.json")
generation_budget = read(BASE / "budget.json")
replay = read(BASE / "replay-and-bytes.json")
grades = read(ROOT / "artifacts/novel-three-grades-2026-11-08/records.json")
adjudication = read(EVIDENCE / "novel-three-adjudication.json")
pre = read(EVIDENCE / "novel-three-preregistration.json")
examples = read(BASE / "example-verification.json")
assert len(suite["tasks"]) == len(skills) == len(grades) == 3
for path, expected in pre["files"].items():
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, path
old_records = read(ROOT / "artifacts/generation-scoped-2026-11-08/records.json")
old_used = set()
for r in old_records:
    old_used.update(r.get("value", {}).get("sourceRefs", []))
    if "originalTask" in r["data"]:
        for item in r["data"]["untrustedReview"]["items"]:
            old_used.update(s["ref"] for s in item.get("sources", []))


def contains_private_key(v):
    if isinstance(v, dict):
        return "withheldChecks" in v or any(contains_private_key(x) for x in v.values())
    if isinstance(v, list):
        return any(contains_private_key(x) for x in v)
    return False


rows = []
all_used = set()
for task in suite["tasks"]:
    task_id = task["id"]
    calls = [r for r in records if r["taskId"] == task_id]
    assert len(calls) == 4 and all(not contains_private_key(r["data"]) for r in calls)
    for r in calls:
        assert all(c["text"] not in json.dumps(r["data"], ensure_ascii=False) for c in task["withheldChecks"])
    review = next(r for r in calls if "originalTask" in r["data"])
    assert review["value"]["approved"] is True
    grade = next(r for r in grades if r["id"] == task_id)
    assert "error" not in grade["validation"]
    original_grade = grade["response"]["value"]
    scores = {k: original_grade[k]["score"] for k in adjudication["rubricWeights"]}
    criteria = {r["id"]: r["status"] for r in original_grade["criteria"]}
    assert adjudication["sharedAdjustment"]["evidenceQuote"] in skills[task_id]["content"]
    scores["concision"] = min(scores["concision"], adjudication["sharedAdjustment"]["maximum"])
    adjustment = next((a for a in adjudication["taskAdjustments"] if a["taskId"] == task_id), None)
    if adjustment:
        assert adjustment["evidenceQuote"] in skills[task_id]["content"]
        scores.update(adjustment["dimensions"])
        criteria.update(adjustment["criterionStatuses"])
    actual = next(r for r in replay["results"] if r["taskId"] == task_id)
    all_used.update(actual["usedRefs"])
    events = [e for e in generation_budget["newEvents"] if e.get("responseId") in {r["receipt"] for r in calls}]
    assert len(events) == len(calls)
    phases = []
    for r in calls:
        event = next(e for e in events if e["responseId"] == r["receipt"])
        phase = "query" if r["providerSettings"]["generation"]["sample"] == "reformulation" else "semantic-review" if "originalTask" in r["data"] else r["value"]["kind"]
        phases.append({"phase": phase, "httpDurationMs": event["durationMs"], "clientDurationMs": next(t["durationMs"] for t in api_timings if t["receipt"] == r["receipt"]), "inputTokens": r["inputTokens"], "outputTokens": r["outputTokens"], "reasoningTokens": r["reasoningTokens"], "cachedInputTokens": r["cachedInputTokens"], "costUsd": event["costUsd"], "receipt": r["receipt"]})
    row = {"taskId": task_id, "name": skills[task_id]["name"], "artifactPath": "novel-skills/2026-11-08/" + skills[task_id]["path"], "bundleDigest": skills[task_id]["bundleDigest"], "durationMs": next(t["durationMs"] for t in timings["tasks"] if t["taskId"] == task_id), "apiDurationMs": sum(e["durationMs"] for e in events), "phases": phases, "inputTokens": sum(r["inputTokens"] for r in calls), "outputTokens": sum(r["outputTokens"] for r in calls), "reasoningTokens": sum(r["reasoningTokens"] for r in calls), "cachedInputTokens": sum(r["cachedInputTokens"] for r in calls), "costUsd": sum(e["costUsd"] for e in events), "delivery": actual, "rawModelTotal": grade["validation"]["total"], "scores": scores, "score": sum(scores[k] * w for k, w in adjudication["rubricWeights"].items()) / 10, "criteria": criteria, "example": next(e for e in examples["examples"] if e["taskId"] == task_id)}
    rows.append(row)
assert not all_used & old_used
latest = {}
peak = 0
for line in (ROOT / "artifacts/practical-2026-11-08/costs.jsonl").read_text().splitlines():
    e = json.loads(line)
    latest[e["id"]] = e
    peak = max(peak, sum(x.get("costUsd", x["reservedUsd"]) for x in latest.values()))
judge_events = [e for e in latest.values() if e.get("responseId") in {g["response"]["receipt"] for g in grades}]
assert len(judge_events) == 3
fees = {"generationUsd": sum(r["costUsd"] for r in rows), "gradingUsd": sum(e["costUsd"] for e in judge_events), "knownCumulativeUsd": sum(e.get("costUsd", 0) for e in latest.values()), "unknownReservedUsd": sum(e["reservedUsd"] for e in latest.values() if "costUsd" not in e), "accountedUsd": sum(e.get("costUsd", e["reservedUsd"]) for e in latest.values()), "accountedPeakUsd": peak, "capUsd": 15}
summary = {"baseCommit": pre["baseCommit"], "bodyGenerated": 3, "semanticallyApproved": 3, "normalDeliveryReady": len(delivery_skills), "contentCriteriaFullyMet": sum(all(v == "met" for v in r["criteria"].values()) for r in rows), "meanContentScore": mean(r["score"] for r in rows), "preparationMs": timings["preparationMs"], "batchDurationMs": timings["batchDurationMs"], "meanTaskDurationMs": mean(r["durationMs"] for r in rows), "tokens": {k: sum(r[k] for r in rows) for k in ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]}, "gradingTokens": {"inputTokens": sum(e["inputTokens"] for e in judge_events), "outputTokens": sum(e["outputTokens"] for e in judge_events)}, "fees": fees, "novelty": {**pre["novelty"], "newActuallyUsedRefs": sorted(all_used), "newUsedIntersectionWithOldUsed": sorted(all_used & old_used)}, "integrity": {"preregisteredHashesMatch": True, "matchedReplayInputs": replay["matchedInputs"], "hiddenCriteriaInBuilder": False, "frozenBodiesAndReferencesMatchReview": True, "originalFailureStatusesRetained": True}, "rows": rows, "adjudication": adjudication}
save(EVIDENCE / "novel-three-results-2026-11-08.json", summary)

lines = [
    "# 新規3シナリオの生成・採点・時間計測",
    "",
    "新規3件とも本文・referenceの生成と内部意味レビューが完了した。**通常配達は1/3件**で、残る2件は最終応答の32,768バイト制限で拒否された。3件の凍結本文をファイルとして保存し、コード例と内容を検証した。初回結果を成功例へ置換していない。",
    "",
    "## 各件の結果",
    "",
    "生成時間はホスト開始から検索文作成・資料開示・本文生成・意味レビュー・保存・配達判定まで。失敗2件は拒否の確定までの時間。API時間はHTTP送信から応答受信までの合計であり、サーバー内の純粋な計算時間ではない。採点と例の実行は別工程。",
    "",
    "| SKILL本文 | 全処理 | API合計 | 本文生成API | 内容点 | 通常配達 |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
]
labels = {"timezone-daily-boundary": "タイムゾーンと日別集計", "asciidoc-opaque-roundtrip": "未対応AsciiDocの原文保持", "keyboard-ime-focus": "キーボード・IME・フォーカス"}
for r in rows:
    body = next(p for p in r["phases"] if p["phase"] == "ready")
    lines.append(f"| [{labels[r['taskId']]}]({r['artifactPath']}) | {r['durationMs']/1000:.2f}秒 | {r['apiDurationMs']/1000:.2f}秒 | {body['httpDurationMs']/1000:.2f}秒 | {r['score']:.1f} | " + ("成功" if r["delivery"]["deliveryAccepted"] else "容量超過で拒否") + " |")
lines += [
    "",
    f"逐次3件の経過時間は **{timings['batchDurationMs']/1000:.2f}秒**、1件平均 **{summary['meanTaskDurationMs']/1000:.2f}秒**。準備（設定取得・モデル一覧・seed DB作成）は別に{timings['preparationMs']/1000:.2f}秒。単発3件であり、速度の分散やp95、初回トークン待ち時間は測っていない。DBはローカルの公開seedで、実ContextStillサーバーの検索遅延を含まない。",
    "",
    "## 内容の採点",
    "",
    "前回と同じ正確35・具体25・網羅20・簡潔10・形式10。独立gpt-4.1の採点を原文と照合して補正した暫定値で、配達成功率や実環境の正答率ではない。",
    "",
    "| 課題 | 正確/10 | 具体/10 | 網羅/10 | 簡潔/10 | 形式/10 | 合計/100 | 固定条件 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
]
for r in rows:
    lines.append(f"| {labels[r['taskId']]} | " + " | ".join(str(r["scores"][k]) for k in adjudication["rubricWeights"]) + f" | **{r['score']:.1f}** | " + ("2条件充足" if all(v == "met" for v in r["criteria"].values()) else "1充足・1一部不足") + " |")
lines += [
    "",
    f"本文の平均は{summary['meanContentScore']:.1f}点。原文・改行・Unicode保持、HTMLを解釈しない表示、DSTの日境界、入力・IMEの抑止は具体的に計画されていた。3コード例は内容確認後にpython3 -Iで実行し、すべてexit 0だった。zoneinfoの23/25時間日、原文のCRLF/空行、修飾キー・入力・IME等の合成判定を確認した。実DOM、実parser/editor、実集計APIの成功とはしない。",
    "",
    "キーボードは、固定条件にあるkey利用・keyCode/whichへの新規依存回避が本文にない。判定済みのmatchedを渡すfixtureも実キー選択を検証しない。採点モデルの『key利用が明記されている』という説明を退け、網羅性8・内容条件一部不足へ補正した。全3件の完成条件にある計画限定の長文再掲は、前回と同じ簡潔性8の基準で評価した。本文自体を書き換えて採点していない。",
    "",
    "## 配達失敗の原因",
    "",
    "LLMのAPI応答は12呼出しすべてcompletedで、max_output_tokensによる途中終了はない。意味レビューも3件ともapproved。失敗は、内部buildと描画済みSKILLを両方含む最終JSONがoutputBytesを超えたことによる。内部buildにも本文と意思決定文書が含まれ、最終応答で重複する。",
    "",
    "| 課題 | 内部応答 | 最終応答 | 本文＋reference実体 | 上限超過 |",
    "| --- | ---: | ---: | ---: | ---: |",
]
for r in rows:
    d = r["delivery"]
    lines.append(f"| {labels[r['taskId']]} | {d['innerReplyBytes']:,} B | {d['finalReplyBytes']:,} B | {d['mainBytes']+d['referenceBytes']:,} B | {max(0,d['finalReplyBytes']-d['outputLimitBytes']):,} B |")
lines += [
    "",
    "通信禁止で元の12推論入力を再生し、通常配達の成功1・拒否2、全3本文・referenceを一致確認した。拒否された2本文は承認済み内部buildから診断用に取り出し、意味レビューに渡った原文・全referenceとの一致を検証して保存した。通常配達成功へは変更せず、上限も緩めていない。例の成功や本文点数で配達失敗を相殺しない。",
    "",
    "## 使用量と費用",
    "",
    "下表は各課題の4呼出し（検索文・開示判断・本文・意味レビュー）の合計。4,000トークンは1呼出しの出力上限。推論は出力の内数、キャッシュは入力の内数である。",
    "",
    "| 課題 | 入力 | 出力 | うち推論 | うちキャッシュ入力 | 料金推計USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
]
for r in rows:
    lines.append(f"| {labels[r['taskId']]} | {r['inputTokens']:,} | {r['outputTokens']:,} | {r['reasoningTokens']:,} | {r['cachedInputTokens']:,} | {r['costUsd']:.6f} |")
t = summary["tokens"]
lines += [
    f"| **生成計12呼出し** | **{t['inputTokens']:,}** | **{t['outputTokens']:,}** | **{t['reasoningTokens']:,}** | **{t['cachedInputTokens']:,}** | **{fees['generationUsd']:.6f}** |",
    "",
    f"独立採点3呼出しは入力{summary['gradingTokens']['inputTokens']:,}／出力{summary['gradingTokens']['outputTokens']:,}、{fees['gradingUsd']:.6f} USD。今回の追加計は **{fees['generationUsd']+fees['gradingUsd']:.6f} USD**。失敗2件も計上した。累計は既知料金推計{fees['knownCumulativeUsd']:.6f}＋未確定予約{fees['unknownReservedUsd']:.6f}＝ **{fees['accountedUsd']:.6f} / 15 USD**。実請求照合ではなく、キャッシュは保守的に通常入力単価で計上している。旧履歴の使用量不明23呼出しを0扱いしていない。Codex会話自体の使用量は含まない。",
    "",
    "## 過学習について言える範囲",
    "",
    "前回個別掲載のバックアップ・sandbox・permissionKeyは除外し、前回20課題と題材を変えた。事前に固定した対象4ref、実際に使った5refのどちらも、前回の実採用・review資料17refと交差しなかった。生成モデルには詳細採点条件を渡さず、oracle注入や対象refの強制もしていない。生成指示・モデル・各上限を事前固定し、実行後の指示調整や同じ課題の有料再生成は0回。入力分離の読込み修正は最初のモデル呼出し前で、journal件数不変を記録した。",
    "",
    "新しい3題材でも本文は生成できた一方、通常配達は1/3へ低下した。したがって、前回の高い本文点数だけから安定した汎用性を主張できない。今回も同じ公開seed・計画文書という範囲内の3単発であり、過学習なしとは断定しない。プロジェクトの技術85点達成とも判定しない。",
    "",
    "## 残る改善と証拠",
    "",
    "最優先は、最終応答での内部buildとSKILLの重複を共通契約として減らすこと。既存利用側の互換性、権限・版の再確認、監査証跡、32KB上限の維持を含む設計が必要で、今回の検証中に応答契約を変更して成功へ置換していない。次に、資料の具体的条件を一般的な『後で確認』へ落とす欠落と、採点モデルが資料の記述を本文へ誤帰属する問題を改善する。個別シナリオ名による製品分岐は追加しない。",
    "",
    "[事前固定条件](novel-three-protocol-2026-11-08.md)、[課題と採点条件](novel-three-suite-2026-11-08.json)、[全観点・工程別時間・使用量](evidence/novel-three-results-2026-11-08.json)、[原文照合の補正](evidence/novel-three-adjudication.json)を保存した。生の入力・応答・API/全体時間・費用journalは[証拠アーカイブ](evidence/novel-three-evidence-2026-11-08.tgz)と[全ファイル指紋](evidence/novel-three-evidence-files.json)に保存する。DB・credentialは含めない。",
    "",
    "依存導入済みの同じcheckoutの新しい作業先に証拠を展開し、`bun docs/quality/evidence/replay-novel-three.mjs` で通信せず再生できる。`python3 docs/quality/evidence/summarize-novel-three.py` で集計を再作成できる。時間は保存済み実測値を読むもので、再生速度を生成時間と置き換えない。",
]
(ROOT / "docs/quality/novel-three-results-2026-11-08.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"rows": [{k: r[k] for k in ["taskId", "score", "durationMs", "inputTokens", "outputTokens"]} for r in rows], "fees": fees}, ensure_ascii=False))
