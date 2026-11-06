# 改善候補に build 本文と成否の対比を渡す

## 目的

改善候補の生成を、報告文だけでなく実際の build 本文と成功・失敗の対比に根拠づけます。

## 現状の問題

事実: `src/service/results.ts` の `propose`（108 行）は報告の入力だけからモデルに候補を作らせ、build 本文も元の Skill も渡していません。

## 提案

`propose` の入力に、対象 build の本文、元 Skill の版、同じ Skill の成功報告と失敗報告の要約を加えます。候補はあくまで proposed 状態に留めます。

## 検証（採用 / 不採用）

採用判定は、提案 01 の固定タスク集合（未整備なら提案 14 の評価キット）で変更前後を同じ record から比較し、下の条件で決めます。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。 候補の質は人手で「根拠のある具体的な修正か」をラベルします。

## よくなったとみなす条件

人手評価で具体的・妥当な候補の割合が上がることです。

## 悪化したとみなす条件

入力が増えて候補が冗長になる、または根拠のない一般論が増えることです。

## やらないこと

候補を自動で正式採用しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/results.ts` の `propose`。論文: ExpeL https://arxiv.org/abs/2308.10144 、Agent Workflow Memory https://arxiv.org/abs/2409.07429 、Reflexion https://arxiv.org/abs/2303.11366 。

## 依存・前提

前提: 成否付きの報告が蓄積されていること（仮定）。提案 10。



## 実装結果

- **採否**: 採用
- **内容**: `prepareReflection` が build 本文・sourceRefs・版・成否要約対比を `grounding` として付け、`propose` がモデルへ渡す。候補は proposed のまま。
- **パス**: `src/service/results.ts`, `src/contracts/ports.ts`, `src/contracts/types.ts`, `src/sqlite/index.ts`, `src/instructions/build.ts`, `src/test/grounded-propose.test.ts`
- **試験**: `bun test src/test/grounded-propose.test.ts`
- **未実施**: 人手での候補品質ラベル比較
- **理由**: 報告文だけの根拠づけを解消。正式公開はしない。
