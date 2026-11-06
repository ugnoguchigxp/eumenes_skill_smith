# Eumenes SkillSmith

Eumenesの会話・作業担当へ、今回の目的と制約に合う実行用Skillを渡すTypeScriptライブラリです。正式Skill・経験の検索、LLMによる適用・差分・合成、保存済みの開始予約、実行結果と改善候補を扱います。

現在はコアとSQLite adapterの実装・固定試験段階です。[疑似ContextStillの単体試験基盤](examples/contextstill/README.md)と、[Grokbot向け引継ぎ](GROKBOT_HANDOFF.md)を用意しています。Eumenesの本体サービス、ContextStillの実接続、会話・担当、MCPへの製品組込みは未完了です。固定モデルの試験は、実LLMによる意味判断の性能を証明するものではありません。

## 開発

Bun 1.4.4を使います。

    bun install --frozen-lockfile
    bun run verify

verifyは型、lint、format、固定試験、JavaScript・型宣言のbuild、tgz内容と配布物からのimportを検査します。試験ではnetworkとBun.serveを禁止し、一時DBと注入したモデルを使います。

コピー済みの実データでも確認する場合は `bun run context:check` を実行します。DBは `data/contextstill/snapshot.sqlite` に置き、Gitとコア配布物から除外します。再生成・別環境での準備は上記の単体試験基盤を参照してください。

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

bun run pack:coreはartifacts/へtgzと内容manifestを作ります。現在は未コミットの開発版なのでsourceGitCommitはnullで、sourceDigestとファイルhashを記録します。本体へ正式に取り込む前にソース版と配布物を固定します。remote作成・公開・pushは自動実行しません。

## 設計と進捗

- [設計書](design.md)
- [実装計画](plan.md)
- [本体接続契約](integration-contract.md)
- [実装と検証の記録](implementation.md)
- [文書レビューの記録](review.md)
