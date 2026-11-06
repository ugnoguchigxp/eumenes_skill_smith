# Eumenes SkillSmith

Eumenesの会話・作業担当へ、今回の目的と制約に合う実行用Skillを渡すTypeScriptライブラリです。正式Skill・経験の検索、LLMによる適用・差分・合成、保存済みの開始予約、実行結果と改善候補を扱います。

現在はコアとSQLite adapterの実装・固定試験段階です。[疑似ContextStillの単体試験基盤](examples/contextstill/README.md)と、[Grokbot向け引継ぎ](GROKBOT_HANDOFF.md)を用意しています。Eumenesの本体サービス、ContextStillの実接続、会話・担当、MCPへの製品組込みは未完了です。固定モデルの試験は、実LLMによる意味判断の性能を証明するものではありません。

## はじめに

Bun 1.4.4を使います。全試験を実行する場合はコピー処理の試験用にPython 3も必要です。公開知識6,957件のseedを同梱しているため、ContextStill本体・元DB・APIキーなしでSQLiteを初期化して試せます。seed初期化と接続確認はBunだけで動きます。

```sh
git clone https://github.com/ugnoguchigxp/eumenes_skill_smith.git
cd eumenes_skill_smith
bun install --frozen-lockfile
bun run context:seed
bun run context:check
bun run verify
```

verifyは型、lint、format、固定試験、JavaScript・型宣言のbuild、tgz内容と配布物からのimportを検査します。試験ではnetworkとBun.serveを禁止し、一時DBと注入したモデルを使います。

`context:seed` は [公開seed](examples/contextstill/seed/README.md) のハッシュ・件数・参照を検査し、`data/contextstill/seed.sqlite` と検索索引を作成します。seedには知識だけを含め、経験、経験由来の事例、設定、認証情報、raw sourceは含めません。生成したSQLiteはGitとコア配布物から除外しています。

`context:check` は疑似ContextStillと固定モデルによる接続確認です。文字列検索を使い、実LLMの品質評価は行いません。`context:eval` は固定fixtureの完全性検査であり、組み立て品質の評点ではありません。タスクシナリオで期待Skillが組み上がったかをLLMが評点するのは `bun run context:eval-scenarios` です。記録が無い呼び出しは推論タスクを書き出して待ち、記録がある呼び出しは毎回評点を出します。`--retrieval-only` は推論を一切呼ばず検索順位だけを測り、0〜10 の評点は出しません（提案 26）。`--search-profile handle|bm25` で mock 検索の順位だけを比較できます（既定は `handle`、提案 27）。旧5件の SKILL 組み立てでは BM25 が平均 4.2 から 8.6 になりましたが、日本語退行があるため既定は切り替えず、本番 ContextStill の検索改善を意味しません。評価報告には suite/seed と指示・schema の identity が付き、未採点を含む平均は出しません（提案 35）。既存のseed DBを作り直す場合は `bun run context:seed --replace` を使います。コピー済みの知識・経験DBを調べる場合は `bun run context:check data/contextstill/snapshot.sqlite` を指定します。詳しい手順は[単体試験基盤](examples/contextstill/README.md)を参照してください。

## ホストからの利用

通常の公開入口はcreateSkillSmith、SQLite用はeumenes-skill-smith/sqliteです。ホストがDB、writer transaction、Registry、推論、queue、権限、時計を渡します。ライブラリ自身はDBを開かず、server、timer、LLM通信を起動しません。

- submitはホストのtransaction内で受付、開始予約またはjob登録を保存します。
- 親に結び付く予約は、解放を確認したactivateでqueueへ移します。
- prepareとreserveをtransactionで確定し、executeだけをtransaction外で実行します。
- settleは出所・権限・epoch・receipt・依存を再検証し、本文と配達待ちを原子的に保存します。
- getは読取りだけです。外部根拠のある本文はgetValidatedで再検査します。
- bindUseには利用先の目的と環境を渡し、reportResultはその実行との結付けを検査します。
- prepareReflection／reserveReflectionを保存してからproposeし、saveProposalは正式公開せず候補を保存します。
- forgetは依存元を先に失効させ、残りの消去参照を返します。ホストはpendingを既存queueで消去し続けます。

受付・保存・配達の原子性には、呼出元のwriter transactionが必要です。SQLite adapterは渡された接続にSQLを実行し、独自にcommitしません。手順はsrc/test/fixture.tsと各保存結合試験を参照できます。

## 配布

`bun run pack:core` は `artifacts/` へtgzと内容manifestを作ります。JavaScript、型宣言、package metadata、LICENSE、READMEを含め、ソース版、sourceDigestとファイルhashを記録します。examplesとseedはGitリポジトリから利用し、コアtgzには含めません。現在は開発段階で、パッケージの公開は行っていません。

## ライセンス

[MIT License](LICENSE)。コード、ドキュメント、同梱の公開知識seedをMITで提供します。

## 設計と進捗

- [設計書](design.md)
- [実装計画](plan.md)
- [本体接続契約](integration-contract.md)
- [実装と検証の記録](implementation.md)
- [文書レビューの記録](review.md)
