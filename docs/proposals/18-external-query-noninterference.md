# 外部再検索 query の非干渉と入力分離

## 目的

モデルが書いた再検索 query が、信頼された `searchTask` 境界を迂回して内部タスクを外部検索へ漏らさないようにします。再検索機能の追加ではなく、破れた情報境界の検証です。

## 現状の問題

事実: モデル生成の `re_search` query が trusted な `authority.searchTask` を迂回し、内部タスク文字列（検証用 canary `PRIVATE_CANARY_42`）を外部検索へ渡せることを再現しました。`build.ts` の再検索経路と `runSearch` が、一つの `turn.query` を local / external の両方へ流用します。これは design.md と integration-contract（外部 query は searchTask のみ）に反します。推定: 実運用では内部入力の流出リスクがあります。

## 提案

外部 query を考える処理へ、内部の task / constraints / 記憶を渡さず、既存の searchTask と外部公開可能な資料だけで作る隔離経路を、ローカル fixture で試します。今の一つの `turn.query` を local / external の両方に流用しません。安全な外部 query を用意できなければ local だけ再検索し、未実施理由を構造データで残します。新しい host API を仮定せず、まず既存 port を spy した実験に留めます。検証では searchTask と公開根拠を固定し、内部 canary だけを変える paired 試験で、外部 query と送出 payload が不変であることを確かめます。敵対本文からの query 指示も同様に監査します。

## 検証（採用 / 不採用）

採否は試験通過だけでは決めません。実 canary を外へ送る実験はしません。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

秘密 canary の流出が 0 であり、かつ公開情報による再検索の到達性を維持することです。

## 悪化したとみなす条件

内部情報が必要だとして境界を緩めること、すべての external を黙って止めて品質低下を隠すことです。

## やらないこと

keyword による PII 検出器を製品判定に使いません。モデルの「安全です」という自己申告を根拠にしません。実 canary を外へ送る実験をしません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts` の再検索と `runSearch`、design.md と integration-contract の外部 query 制約。論文: [Indirect Prompt Injection](https://arxiv.org/abs/2302.12173)。

## 依存・前提

fixture だけで開始できます。隔離に追加推論が必要なら提案 22 で使用量を測ります。host 統合は不要です。仮定: 公開入力だけでも役立つ再検索が可能であること。未測定: 安全分離後の達成率。
