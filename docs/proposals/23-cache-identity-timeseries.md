# deadline と生成器互換性を分離した cache 時系列実験

## 目的

内容の同一性と、受付 ID / deadline などの実行上の制約を分け、安全な再利用 hit と更新・失効時の漏れを確かめます。提案 11 の外部依存キャッシュと、指摘修正 03 の指示 digest とは別の実験です。

## 現状の問題

事実: deadline は cache key に入っており、1ms の変更で miss になります。古い build の delivery で、`usable()` は現行の指示 / 生成器版との互換を見ていません。inference / model / schema の版も key にありません。推定: 実 hit 率は低い可能性があります。未測定: 実 hit 率と、新しい資料の効用。

## 提案

同一 task / 環境の内容同一性と、受付 ID / deadline など実行上の制約を分離できるかを実験 branch で試します。既存 build のサイズ / 認可 / 失効検査は維持します。instruction だけでなく schema / disclosure / 生成器設定の互換 manifest を評価記録に残し、旧 request の replay を許す場合と、安全修正後に止める場合の方針を明文化します。試験は deadline 更新だけ、受入変更、policy / capability 変更、instruction upgrade、旧 requestId の再取得、外部資料の失効 / 改訂、新しい資料追加、re_search 由来 build の再利用を時系列 fixture で比較します。

## 検証（採用 / 不採用）

効果がないなら key を複雑化しません。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

安全な変更で旧 build が漏れず、同内容の正常な再利用 hit が増えることです。

## 悪化したとみなす条件

異なる受入 / 権限 / 版を取り違えること、古い検索結果の有効性を鮮度保証と呼ぶことです。

## やらないこと

指示 digest を外しません。scope を緩めません。TTL を無限化しません。未確認の model registry API を作りません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/index.ts` の cache と `usable()` / `getValidated`、`src/instructions/build.ts` の `INSTRUCTION_VERSION`。論文: [Gorilla](https://arxiv.org/abs/2305.15334)、[FreshLLMs](https://arxiv.org/abs/2310.03214)。

## 依存・前提

提案 19 の依存 / round 追跡と、提案 22 の cold / warm 使用量が有用です。ローカルで完結します。仮定: 互換 manifest を安定化できること。
