# 正しい ID の意味汚染と repair 洗浄を攻撃面にした防御比較

## 目的

架空 ID の拒否（提案 13）とは別に、既存の正しい ID を使った意味汚染と、repair による洗浄が指針へ残るかを測ります。構造検査の通過を意味の安全とは呼びません。

## 現状の問題

事実: 未開示でも、正しい ID を使った悪意ある reuse が ready になることを再現しました。既存試験は架空 ID だけをカバーしています。repair は悪い ID を落としたあと、意味レベルの攻撃文を残し得ます。提案 07 の JSON 属性による印付けは、Spotlighting 論文の「本文全体へ連続的に印を織り込む」手法と同じではありません。推定: repair が汚染を維持し得ます。未測定: 実モデルの攻撃成功率と防御の副作用。

## 提案

metadata / title / section / body / 報告 contrast 由来の攻撃、許可 ID のまま攻撃文を書く compose、repair で ID だけ修正する系列を追加します。現在の JSON 属性ラベルと、本文への連続的 provenance marking を、評価専用の同じ課題で比較します。下流 executor にも権限と外部送出の禁止を独立に持たせ、build 本文だけを権限根拠にしません。無害 canary と送信 spy で、攻撃成功 / 言及 / 実行を分離し、人手ラベルで採点します。

## 検証（採用 / 不採用）

攻撃成功率（ASR）が 0 でも絶対安全とはしません。schema 通過を安全証明にしません。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

攻撃文の指針化と、禁止された送出意図が減り、通常課題の達成と日本語 / コードの忠実性が維持されることです。

## 悪化したとみなす条件

印付けが読解や引用を壊すこと、token 増だけであること、攻撃文を単に隠すことです。

## やらないこと

攻撃キーワードを製品で拒否しません。外部送信実験をしません。base64 の全面標準化をしません。schema 通過を安全証明にしません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/test/injection.test.ts`、`src/service/disclosure.ts`、`src/service/build.ts` の `checkDecision` と repair。論文: [Indirect Prompt Injection](https://arxiv.org/abs/2302.12173)、[Spotlighting](https://arxiv.org/abs/2403.14720)、[LLMs Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)。

## 依存・前提

提案 17 の正しい replay と提案 18 の query 境界。実モデル比較には新しい record が必要です。構造反例は fixture だけで可能です。仮定: 注入の人手判定を安定化できること。

## 実装結果

- **採否**: 部分採用（攻撃面の固定試験と評価専用印の比較）。実モデル ASR と防御副作用は未測定。製品に keyword 拒否は入れない。
- **内容**: 正しい ID の reuse／compose／repair 洗浄が構造上 ready になり得ることを回帰試験化。評価専用の連続 provenance mark と JSON 属性 mark を比較可能な関数として追加。Spotlighting 同等は主張しない。
- **パス**: `src/test/valid-id-injection.test.ts`, `src/eval/provenance-mark.ts`
- **試験**: `bun test src/test/valid-id-injection.test.ts`（4 pass）
- **未実施**: 実モデル攻撃成功率、印付けの読解副作用、下流 executor の独立禁止試験の本番接続
- **理由**: schema 通過≠安全を明示できる試験ができた。製品の意味防御は未強化（意図的）。
