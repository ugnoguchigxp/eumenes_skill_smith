# 過去軌跡から再利用できる手順候補を誘導する

## 目的

成功した実行の軌跡から、再利用できる手順を候補として抽出します。

## 現状の問題

事実: 現在の経験は報告文として残るだけで、手順の誘導はしていません。

## 提案

成功報告が複数ある課題群について、モデルに共通手順を候補として書かせ、proposed として保存します。

## 検証（採用 / 不採用）

採用判定は、提案 01 の固定タスク集合（未整備なら提案 14 の評価キット）で変更前後を同じ record から比較し、下の条件で決めます。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

誘導した候補を使った条件で受入達成が上がることです。

## 悪化したとみなす条件

過剰な一般化で誤適用が増えることです。

## やらないこと

候補を自動で正式 Skill にしません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/results.ts`。論文: Agent Workflow Memory https://arxiv.org/abs/2409.07429 、ExpeL https://arxiv.org/abs/2308.10144 。

## 依存・前提

前提: 提案 06、09。成功軌跡の蓄積（仮定）。

## 実装結果

- **採否**: 採用
- **内容**: InferencePort 経由で成功要約から手順候補を誘導。`induceAndSaveWorkflow` は proposed のみ保存。キーワード採掘なし。
- **パス**: `src/eval/workflow.ts`, `src/service/results.ts`, `src/instructions/build.ts`, `src/test/workflow-product.test.ts`, `src/test/eval-kit-workflow.test.ts`
