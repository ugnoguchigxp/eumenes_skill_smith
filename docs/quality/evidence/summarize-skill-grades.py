# -*- coding: utf-8 -*-
"""Produce a reviewable scorecard from frozen model grades and explicit adjudication."""
import hashlib
import json
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "docs/quality/evidence"
RAW = ROOT / "artifacts/skill-grades-2026-11-08"


def read(path):
    return json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


tokens = read(RAW / "generation-tokens.json")
suite = read(ROOT / "docs/quality/practical-suite.json")
skills = read(ROOT / "artifacts/generation-scoped-2026-11-08/skills.json")
materials = {x["taskId"]: x for x in read(RAW / "materials.json")}
records = {x["id"]: x for x in read(ROOT / "artifacts/skill-grades-v2-2026-11-08/records.json")}
review = read(EVIDENCE / "skill-grade-adjudication-2026-11-08.json")
adjustments = {x["taskId"]: x for x in review["taskAdjustments"]}
weights = {"correctness": 35, "actionability": 25, "coverage": 20, "concision": 10, "format": 10}
rows = []
export = ROOT / "docs/quality/graded-skills/2026-11-08"
for task in suite["tasks"]:
    task_id = task["id"]
    if task_id not in records:
        continue
    record = records[task_id]
    assert "error" not in record["validation"]
    model = record["response"]["value"]
    scores = {k: model[k]["score"] for k in weights}
    status = "complete-artifact" if task_id in skills else "partial-envelope-body-only"
    if task_id in skills:
        skill = skills[task_id]
        assert review["sharedAdjustment"]["evidenceQuote"] in skill["content"]
        scores["concision"] = min(scores["concision"], review["sharedAdjustment"]["maximum"])
        for f in [{"path": skill["path"], "content": skill["content"], "digest": skill["digest"]}, *skill["files"]]:
            path = Path(f["path"])
            assert not path.is_absolute() and ".." not in path.parts
            assert hashlib.sha256(f["content"].encode()).hexdigest() == f["digest"]
            target = export / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f["content"])
        artifact_path = str((export / skill["path"]).relative_to(ROOT / "docs/quality"))
    else:
        target = export / ("partial-bodies/" + task_id + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        save(target, materials[task_id]["artifactToEvaluate"])
        artifact_path = str(target.relative_to(ROOT / "docs/quality"))
    adjustment = adjustments.get(task_id)
    if adjustment:
        assert adjustment["evidenceQuote"] in skills[task_id]["content"]
        scores.update(adjustment["dimensions"])
    rows.append({"taskId": task_id, "status": status, "artifactPath": artifact_path, "modelScores": {k: model[k]["score"] for k in weights}, "modelTotal": record["validation"]["total"], "adjudicatedScores": scores, "adjudicatedTotal": sum(scores[k] * weights[k] for k in weights) / 10, "criterionStatus": adjustment["criterionStatus"] if adjustment else model["criteria"][0]["status"], "gradeReceipt": record["response"]["receipt"], "bundleDigest": skills.get(task_id, {}).get("bundleDigest")})
complete = [r for r in rows if r["status"] == "complete-artifact"]
summary = {"rubricWeights": weights, "completedArtifacts": len(complete), "completeMean": mean(r["adjudicatedTotal"] for r in complete), "completeModelMean": mean(r["modelTotal"] for r in complete), "dimensionMeans": {k: mean(r["adjudicatedScores"][k] for r in complete) for k in weights}, "criteriaMet": sum(r["criterionStatus"] == "met" for r in complete), "criteriaPartial": sum(r["criterionStatus"] == "partial" for r in complete), "rows": rows, "adjudication": review, "limits": review["limits"]}
save(EVIDENCE / "skill-content-scores-2026-11-08.json", summary)
save(EVIDENCE / "generation-tokens-2026-11-08.json", tokens)
# Keep scoring overhead separate from generation, but include it in the global cap.
latest = {}
peak = 0
for line in (ROOT / "artifacts/practical-2026-11-08/costs.jsonl").read_text().splitlines():
    e = json.loads(line)
    latest[e["id"]] = e
    peak = max(peak, sum(x.get("costUsd", x["reservedUsd"]) for x in latest.values()))
grading = [e for e in latest.values() if e["purpose"].startswith("skill-grade.")]
groups = {
    "initial-invalid": [e for e in grading if e["purpose"].startswith("skill-grade.v1:")],
    "calibration": [e for e in grading if e["purpose"].startswith("skill-grade.v2:calibration-")],
    "revised-artifacts": [e for e in grading if e["purpose"].startswith("skill-grade.v2:") and not e["purpose"].startswith("skill-grade.v2:calibration-")],
}
assert sum(len(v) for v in groups.values()) == len(grading)
overhead = {
    "calls": len(grading),
    "inputTokens": sum(e["inputTokens"] for e in grading),
    "outputTokens": sum(e["outputTokens"] for e in grading),
    "knownCostUsd": sum(e["costUsd"] for e in grading),
    "byPurpose": {p: {"calls": len(v), "inputTokens": sum(e["inputTokens"] for e in v), "outputTokens": sum(e["outputTokens"] for e in v), "costUsd": sum(e["costUsd"] for e in v)} for p, v in groups.items()},
    "accountedUsd": sum(e.get("costUsd", e["reservedUsd"]) for e in latest.values()),
    "accountedPeakUsd": peak,
    "capUsd": 15,
}
save(EVIDENCE / "skill-grading-usage-2026-11-08.json", overhead)

lines = ["# 生成SKILLの内容採点とトークン使用量", "", f"採用版で完成した13件を本文・全reference・課題条件と照合した。補正後の平均は **{summary['completeMean']:.1f}/100**（最低{min(r['adjudicatedTotal'] for r in complete):.1f}、最高{max(r['adjudicatedTotal'] for r in complete):.1f}）。独立モデルの一次評点は平均{summary['completeModelMean']:.1f}だったが、実在する重複と要件不足2件をCodexが原文照合して補正した。これは文書内容の暫定採点で、正答率、実タスク成功率、プロジェクトの技術点ではない。", "", "## 方法と観点", "", "正確性35、具体性25、網羅性20、簡潔性10、形式10。各観点0〜10を重み付けして100点へ換算した。gpt-4.1に凍結済み本文・全reference・依頼・非公開採点条件・実際に渡された資料を提示し、課題名やready件数から点数を推測させていない。根拠は実在する段落IDで指定し、ID・条件の全件性・得点範囲を検証した。全15件の応答と判断根拠を保存した。モデルの点数を人手較正済みと呼ばない。", "", "初回の自由引用形式では15件中11件に引用不在または条件IDの不一致があり、確定採点に使用しなかった。改訂後は15件全件が根拠IDの検査を通過した。正しい排他呼出計画100点／二重呼出しを正しいとする文書34点の確認例2件は、基本的な識別の確認だけであり、点数尺度全体の較正ではない。", "", "完成13件のコード例は別途実行して全件exit 0。合成例の実行成功であり、DB・API・実機の成功ではない。採点資料にはこの範囲を明示した。", "", "## 13件の評点", "", "観点列は各10点満点、合計は100点。合否の点数閾値は追加せず、固定した内容条件の充足を別列に示す。", "", "| 課題／本文 | 正確 | 具体 | 網羅 | 簡潔 | 形式 | 合計 | 内容条件 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
for r in complete:
    lines.append(f"| [{r['taskId']}]({r['artifactPath']}) | " + " | ".join(str(r["adjudicatedScores"][k]) for k in weights) + f" | **{r['adjudicatedTotal']:.1f}** | " + ("充足" if r["criterionStatus"] == "met" else "一部不足") + " |")
lines += ["", f"固定した内容条件は **{summary['criteriaMet']}件充足／{summary['criteriaPartial']}件一部不足**。納品完了13件すべてが内容条件まで合格したとは報告しない。", "", "## 原文照合で残った改善", "", "- **sandbox-review：93.5点。** productionのtyped confirmationが「対象版で要求される場合」と条件付き。固定採点条件の必須確認を保証していない。確認機構がない版では止め、承認された代替確認へ進む条件を明示する。モデルの充足判定を一部不足へ補正した。", "- **permission-boundary：91.5点。** 空キー拒否・window別許可・障害時拒否は具体的。一方、不要plugin permissionの棚卸し・除去・実効権限の確認がない。API境界のallow-setだけで配布権限の整理完了としない。具体性9／網羅性8へ補正した。", "- **全13件：簡潔性8点。** 計画限定・権限確認の説明が目的／安全性／完成条件で重なり、完成条件の1項目には同じ長い制約文が再掲される。必須条件を残しながら重複を統合できる。", "- **診断・再試行・移行の例：検証範囲の拡充余地。** 合成fixtureは本物の秘匿化処理、worker取得、DBの原子的制約を呼んでいない。この制約は本文が明示しているため誤実行と減点しないが、対象実装と接続した効果検証は残る。", "", "採点モデルの説明にも誤りが残った。migration-readonlyの「今日はbackup/counts確認」という説明は採用しない。本文と現在の制約は文書作成だけであり、正しく制限している。retry-controlへの推奨数値追記は任意案で、制限値やSLOなしに本番初期値を発明する修正は採用しない。", "", "## 末尾が途切れた2件", "", "この2件は本文・reference・標準ワークフローが最後まで存在する。外側のJSONと末尾管理情報が未完了のため、正式なSKILL成果物としては確定できていない。完全に読めるJSON部分木だけを抽出し、補完せず参考採点した。", "", "| 課題／抽出本文 | 本文の参考点 | 入力 | 出力 | うち推論 | API時間 | 切れた箇所 |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |", "| [permanent-queue](graded-skills/2026-11-08/partial-bodies/permanent-queue.json) | 99.0 | 13,718 | 4,000 | 100 | 49.8秒 | nonSourceAdditions |", "| [queue-migration](graded-skills/2026-11-08/partial-bodies/queue-migration.json) | 98.0 | 12,320 | 4,000 | 48 | 54.8秒 | interactions |", "", "原因は双方ともAPIが返した **max_output_tokens**。4,000は当方の評価設定の上限で、接続断や120秒の時間切れ、内容の採点不合格ではない。本文、参照コード、要約・監査情報を一つの応答で返す量が上限に収まらなかった。推論100／48は4,000に含まれ、本文に使える出力枠も消費する。生出力はそれぞれ7,386／7,019文字で、後者には文字列外の整形空白が0文字だったため、JSONの整形だけが共通原因とはいえない。出力上限到達の件数と内容精度を混同していた報告を訂正する。", "", "情報不足5件（backup-actual、unknown-sdk、payment-unknown、migration-counts、private-authority）はSKILL未生成なので点数の平均から除外する。0点や合格SKILLへ変換していない。", "", "## 採用版20課題の使用トークン", "", "検索文作成・資料開示の判断・生成・意味レビューを含むAPI使用量。表の各行は最後の生成応答だけでなく、その課題の全呼出しの合計。推論は出力の内数。キャッシュ入力は入力の内数であり、二重加算しない。", "", "| 課題 | 呼出し | 入力 | 出力 | うち推論 | 結果 |", "| --- | ---: | ---: | ---: | ---: | --- |"]
selected = next(b for b in tokens["batches"] if b["condition"] == "generation-scoped")
for row in selected["perTask"]:
    task_id = row["taskId"]
    outcome = "完成" if task_id in skills else "外側JSON未完了" if task_id in records else "情報不足"
    lines.append(f"| {task_id} | {row['physicalCalls']} | {row['inputTokens']['measuredSubtotal']:,} | {row['outputTokens']['measuredSubtotal']:,} | {row['reasoningTokens']['measuredSubtotal']:,} | {outcome} |")
lines += [f"| **合計** | **{selected['physicalCalls']}** | **{selected['inputTokens']['measuredSubtotal']:,}** | **{selected['outputTokens']['measuredSubtotal']:,}** | **{selected['reasoningTokens']['measuredSubtotal']:,}** | 13完成・2外側未完了・5保留 |", "", f"合計 **{selected['inputTokens']['measuredSubtotal'] + selected['outputTokens']['measuredSubtotal']:,}トークン**、既知料金推計 **{selected['knownCostUsd']:.6f} USD**。キャッシュ入力は測定済み小計101,153トークンだが、上限到達2呼出し分の内訳が残っていないため完全な総量は不明。入力・出力の総量と推論量は68呼出しすべて取得済み。", "", "## 不採用・失敗も含む履歴", "", "| 条件 | 呼出し | 入力 | 出力 | 既知料金推計 USD |", "| --- | ---: | ---: | ---: | ---: |"]
for b in tokens["batches"]:
    lines.append(f"| {b['condition']} | {b['physicalCalls']} | {b['inputTokens']['measuredSubtotal']:,} | {b['outputTokens']['measuredSubtotal']:,} | {b['knownCostUsd']:.6f} |")
g = tokens["global"]
lines += ["", f"今回の採点は、無効となった初回15呼出し、確認用2呼出し、改訂採点15呼出しの **{overhead['calls']}呼出し**。入力 **{overhead['inputTokens']:,}**／出力 **{overhead['outputTokens']:,}**、料金推計 **{overhead['knownCostUsd']:.6f} USD**。生成の20課題の値に混ぜていない。", "", f"保存済み全履歴（生成・旧回答比較・採点・失敗・不採用をすべて含む）は **{g['physicalCalls']:,}呼出し**。API使用量を取得できた呼出しの小計は入力 **{g['inputTokens']['measuredSubtotal']:,}**／出力 **{g['outputTokens']['measuredSubtotal']:,}**。**{g['inputTokens']['unknownCalls']}呼出しの使用量が不明なので、これは完全な総量ではない**。推論・キャッシュの過去内訳にも欠測があり、JSONに測定小計と欠測呼出し数を保存した。", "", f"既知料金推計 **{g['knownCostUsd']:.6f} USD**＋費用未確定予約 **{g['unsettledReservedUsd']:.6f} USD**＝累計計上 **{overhead['accountedUsd']:.6f} / 15 USD**。既知トークンに設定単価を掛けた推計で実請求照合ではない。キャッシュは保守的に通常入力単価で計上し、料金不明を0としていない。", "", "## 証拠と再現", "", "[点数・全観点・原文照合の補正](evidence/skill-content-scores-2026-11-08.json)、[全課題・工程別トークン](evidence/generation-tokens-2026-11-08.json)、[採点の使用量](evidence/skill-grading-usage-2026-11-08.json)を保存した。上の13本文とreferenceは生成物のSHA-256一致を確認してそのまま出力し、採点しやすく書き直していない。", "", "[採点証拠アーカイブ](evidence/skill-quality-evidence-2026-11-08.tgz)と[ファイル指紋](evidence/skill-quality-evidence-files.json)に、生の採点入力・出力・manifest・未採用評点・確認例・費用journalを保存した。展開先に既存記録がなければ、旧生成証拠と合わせて `python3 docs/quality/evidence/measure-generation.py`、`python3 docs/quality/evidence/summarize-skill-grades.py` で集計を再生できる。集計自体は通信しない。", "", "ここでのトークン・費用は検証用LLM APIの台帳であり、Codexの会話自体の使用トークンは含まない。その会話使用量はこの台帳から取得できない。実運用での有効性、未知課題、採点尺度の人手較正は未測定。プロジェクトの技術評価85点達成とは判定していない。"]
(ROOT / "docs/quality/skill-content-scores-2026-11-08.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"mean": summary["completeMean"], "met": summary["criteriaMet"], "partial": summary["criteriaPartial"], "overhead": overhead}, ensure_ascii=False))
