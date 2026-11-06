# 改善案（proposals）

このディレクトリは改善の検討課題（アジェンダ）です。2026-11-06 のコードレビューで見つかった問題への修正は `docs/review-fixes/` に分けてあり、ここには含めません。各案は実装と検証で、よくなれば採用、悪化すれば不採用とします。

- `01-real-task-evaluation.md`: 実タスク 3 条件評価（Skill なし / Agent Skills 型 / SkillSmith ビルド）
- `02-agent-skills-baseline.md`: Agent Skills 型を評価の基準線にする
- `03-retrieval-recall.md`: 検索 recall を合成とは別に測る
- `04-corrective-re-search.md`: degraded / truncated 時に再検索するかをモデルが判断する
- `05-progressive-disclosure.md`: 本文全文ではなく card → section 単位の段階的開示
- `06-grounded-improvement-proposals.md`: 改善候補に build 本文と成否の対比を渡す
- `07-spotlighting-untrusted.md`: untrustedEvidence への datamarking
- `08-freshness-signals.md`: 取得時刻・superseded / successors をモデルへ明示する
- `09-execution-verified-promotion.md`: 実行で検証できたものだけを候補へ進める
- `10-calibrated-judge.md`: 少数の人手ラベルで LLM judge を較正する
- `11-auxiliary-eval-metrics.md`: faithfulness / context relevance の補助指標
- `12-workflow-from-trajectories.md`: 過去軌跡から再利用できる手順候補を誘導する
- `13-injection-regression-tests.md`: 取得文書への注入が構造検査で壊れることの回帰試験
- `14-recorded-inference-eval-kit.md`: recorded-inference 経由の品質評価キット
- `15-poor-retrieval-early-gap.md`: 検索品質が低いとき早期に不足へ落とす
