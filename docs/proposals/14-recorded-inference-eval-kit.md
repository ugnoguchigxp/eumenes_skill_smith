# recorded-inference 経由の品質評価キット

## 目的

実タスク、期待結果、推論 record を再現可能な形で管理し、全提案の採否判定に使います。

## 現状の問題

事実: 試験は固定値のモデルで、品質評価の仕組みはありません。

## 提案

タスク定義（目的・受入条件・期待結果）、条件、推論 record、判定を一式として保存するキットを作ります。推論は Grok Bot が recorded-inference 経由で行い、再実行時は record を再生します。

## 検証（採用 / 不採用）

キットで同じ record から同じ判定が出ることを確認します。

## よくなったとみなす条件

変更前後の比較が record の再生だけでできることです。

## 悪化したとみなす条件

record の形式が変更のたびに壊れ、比較できなくなることです。

## やらないこと

評価のためにモックを必要以上に拡張しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `examples/contextstill` の疑似環境、`src/contracts/ports.ts` の推論 port。論文: ARES https://arxiv.org/abs/2311.09476 。

## 依存・前提

前提: 提案 01 のタスク。

## 実装結果

- **採否**: 採用
- **内容**: `runEvalSuite` + `examples/contextstill/eval-kit.ts` + fixture suite。recorded-inference 継ぎ目を拡張。配線クエリ「検証」を品質スコア扱いしない注記あり。
- **パス**: `src/eval/kit.ts`, `examples/contextstill/eval-kit.ts`, `examples/contextstill/seed/eval-suite.fixture.json`
- **未実施**: 実ユーザー課題コーパス
