# 開示の進捗と未使用情報を可視化し、1 回対 2 回を比較する

## 目的

段階的開示（提案 05）のあと、無進捗・未読 reuse・過剰開示・区分のない全文 fallback の代償を測り、同じ総上限で 1 回開示と 2 回開示を比較します。

## 現状の問題

事実: 開示と ready は切り離されています。`checkDecision` は取得済みなら未開示の evidence も選べます。モデル入力に進捗や残予算はありません。空の `sectionIds` は全 section へ広がり、区分のない資料は全文になります。`get()` は初回に document 上限まで先読みします。推定: 2 回開示が常に良いわけではありません。未測定: 最適 round 数と不要開示の削減量。

## 提案

disclosed の ref / section 集合、追加 byte、最終使用 section との対応、残り model / source 枠を実験 trace へ記録します。unknown / 空開示を明示的な失敗情報にして修正可能にします。重複開示は新情報なしと返します。evidence は取得済みでも、ready 時に何をモデルが見たかを記録します。現行の 1 回開示・2 回開示・必要部分の再選択を、同じ総上限で比較します。section なし資料には、元の ref / version に紐づく機械的な表示用 slice を評価専用で試せますが、正式な section ID や patch ID へは昇格しません。

## 検証（採用 / 不採用）

重要部分を先頭 / 中央 / 末尾へ入れ替える課題、未使用の長文、二段階で必要情報がわかる課題、空 / 重複 ID、`re_search` → disclose → repair を試します。単純な一回方式が勝てばそちらを残します。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

達成と誤適用を悪化させず、不要な開示 byte / token と無進捗の失敗が減ることです。

## 悪化したとみなす条件

二回目開示のために最終回答の枠がなくなること、未開示部分への依存を見落とすことです。

## やらないこと

無制限の disclose をしません。全文の自動切捨てをしません。LLM 要約を原文の正式 section として扱いません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/disclosure.ts`、`src/service/build.ts` の開示と `checkDecision`。論文: [Lost in the Middle](https://arxiv.org/abs/2307.03172)、[Self-RAG](https://arxiv.org/abs/2310.11511)。

## 依存・前提

提案 19 の round trace と提案 22 の使用量測定が有用です。制御動作は fixture、品質は実 record で見ます。P4 は不要です。仮定: 開示選択の record を取得できること。
