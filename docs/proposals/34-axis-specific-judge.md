# 34. 軸別 judge の集計（混合平均の禁止）

## 背景
retrieval（元5件 assembly 判定、expectedSkillUsed）、compose（提案31）、absent（提案32）は成功条件が異なる。判定器の選択は runFull で既に軸別に分岐しているが、`meanScore` は採点済み全件の単純平均だった。suite-3axis を混合で `--full` 実行すると、元5件の検索未到達 1 と compose / absent の 8 が一つの平均に混ざり、意味のない数になる。

## 対象
報告（集計）だけ。判定器・スキーマ・指示・`INSTRUCTION_VERSION`（`build.af6fa023…3623`）・判定 digest は変更しない。

## 方法
- `axisSpecificMeans(statuses, scores, complete)` を `scenario-runner.ts` に追加。
- `meanScore`: complete かつ実行内タスクがすべて同一軸のときだけ従来どおりの平均。複数軸を含むときは `null`。
- `axisMeans: { retrieval, compose, absent }`: その軸のタスクが実行内に1件以上あり、すべて `scored` のときだけ平均。それ以外は `null`（既存の complete / meanScore の規律と同じ）。
- `mixedAxes: boolean` を結果と報告に追加。identity は変更しない。
- `composeScores` / `absentScores` / `abstentionScores` は従来どおり。

## 検証
`examples/contextstill/test/axis-means.test.ts`：元5件 handle 再生 5件 / 4.2、absent-only 8、compose BM25 natural 単軸平均維持、元5件 + absent 4件の混合で `meanScore` null・`axisMeans` {4.2, null, 8}、未採点を含む軸の平均保留、トークン null 維持。既存の compose canary（handle 0/4、BM25 4/4）と builder 隔離テストは既存のまま通る。

## 採用しないとき
混合実行の平均を報告に使わないよう運用で避ける必要がある。

## リスク
軸の判定は `task.axis`（suite の型付き軸）に依存する。`comparison-slice` は retrieval 軸として扱う。提案33の対比判定（opt-in）は retrieval / compose タスクにも適用されるが、軸は task.axis のまま集計する。対比平均 8 は 4.2 を置き換えない（対比 on の実行は別記録）。

## 実装結果
報告側の変更のみ。新しい SKILL 本文や評点は作っていない。製品経路は判定器を混ぜないので、指示の変更は対象外。品質改善は主張しない。
