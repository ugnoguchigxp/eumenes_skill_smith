# Eumenes SkillSmith

Eumenesの会話・作業担当へ、今回の目的と制約に合う実行用Skillを渡すTypeScriptライブラリです。正式Skill・経験の検索、LLMによる適用・差分・合成、保存済みの開始予約、実行結果と改善候補を扱います。

コアとSQLite adapterを実装し、Eumenesのジョブと永続ストアに一時DBで接続する試験を行っています。[疑似ContextStillの試験基盤](examples/contextstill/README.md)と[登録数別の実クラウド測定](docs/quality/catalog-improvement-2026-11-09/results.md)があります。Eumenesの本体サービス、ContextStillの実接続、会話・担当、MCPへの製品組込みは未完了です。

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

verifyは型、lint、format、固定試験、JavaScript・型宣言のbuild、tgz内容と配布物からのimportを検査します。試験は公開seedから専用の一時DBを作るため、既存の作業用DBに依存しません。networkとBun.serveを禁止し、注入したモデルを使います。macOSでもTMPDIRの追加指定は不要です。

`context:seed` は [公開seed](examples/contextstill/seed/README.md) のハッシュ・件数・参照を検査し、`data/contextstill/seed.sqlite` と検索索引を作成します。seedには知識だけを含め、経験、経験由来の事例、設定、認証情報、raw sourceは含めません。生成したSQLiteはGitとコア配布物から除外しています。

`context:check` は疑似ContextStillと固定モデルによる接続確認です。`context:eval` は固定fixtureの完全性検査です。実LLMによる品質・実課題の効果は別に検証します。

検索の現行既定は `bm25`、言い換えは `auto` です。`--search-profile handle|bm25` と `--query-reformulation off|on|auto|multi` で条件を明示できます。autoでは文字種や題名一致を使って経路を切り替えず、公開searchTaskの言い換えをLLMに委ねます。ホストが検索文を用意する場合はoffを指定できます。旧autoは凍結済み評価の再生に限って使用します。

`bun run context:eval-scenarios` は生成・採点の記録がなければ、未実施の推論タスクを書き出して待ちます。`--retrieval-only` は検索順位だけを測り、生成品質点を出しません。`bun run context:scoreboard` は記録のidentityと失効状態を照合します。手順と条件の履歴は[単体試験基盤](examples/contextstill/README.md)と[計測手順](docs/measurement.md)を参照してください。

旧schemaのDBには再生成方法を示して停止し、自動上書きしません。内容を確認したうえで `bun run context:seed --replace` または `bun run context:snapshot --replace` を使います。コピー済みDBの確認は `bun run context:check data/contextstill/snapshot.sqlite` です。

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

受付・保存・配達の原子性には、呼出元のwriter transactionが必要です。SQLite adapterは渡された接続にSQLを実行し、独自にcommitしません。[試験用consumer](src/test/fixture-host.ts)と各保存結合試験に実行例があります。結果報告・候補管理も元requestのprincipal・scope・epochと対象executionの権限を照合します。report-onlyは許可されますが、同scopeの別principalへの暗黙の委譲は行いません。

## 配布

`bun run build` の後に `bun run pack:core` を実行します。ビルド入力・lockfile・生成出力のdigestを照合し、古いビルド、出力の改変、不要ファイル、symlinkを拒否します。`artifacts/` のtgzとmanifestには、基準commit、未コミット変更の有無、実ソース・ビルド入力・各ファイルのhashが付きます。未コミットの実装を基準commitそのものと表示しません。

JavaScript、型宣言、package metadata、LICENSE、READMEだけを梱包します。examplesと公開seedはGitリポジトリから利用し、コアtgzには含めません。別consumerから配布物を読み込み、生成・結果報告・通知確認を通す固定試験があります。公開は行っていません。

依存の更新・脆弱性確認・移行・切戻しと手動の配布判断は[保守手順](docs/quality/manual-release.md)を参照してください。CIの追加は行いません。

## ライセンス

[MIT License](LICENSE)。コード、ドキュメント、同梱の公開知識seedをMITで提供します。

## 設計と進捗

- [設計書](design.md)
- [実装計画](plan.md)
- [本体接続契約](integration-contract.md)
- [実装と検証の記録](implementation.md)
- [文書レビューの記録](review.md)

### 最終SKILLの受け渡し

推奨する公開入口は`service.getSkillDelivery(ref, authority, read, signal, context)`です。`skillsmith.delivery.v1`は本文を一度だけ返し、内部Buildは別途認可される監査参照へ分離します。readyの`skill`に主ファイルと全references、digest、bundleDigestが届きます。承認済みSKILLの保存・LLM選択・タスク結付けは[利用契約](docs/approved-skills.md)を参照してください。既存get系は互換入口として保持します。

```ts
// リポジトリの例で提供するwriter。コアtgzには同梱しない。
import { writeSkillArtifact } from "./examples/contextstill/skill-output.js";
const reply = await service.getSkillDelivery(ref, authority, read, signal, context);
if (reply.kind === "ready") {
  const mainFile = writeSkillArtifact(outputDir, reply.skill);
  // mainFileと同じSkillディレクトリに全referencesが保存される。
}
```

writerは主ファイル・参照・bundleのdigestと出力先を先に検査し、symlink/hardlinkを拒否します。出力先は書込み権限を持つホストが用意し、同時のパス変更を防いでください。ファイル一式の保存は原子的ではないため、必要なら新しい専用ディレクトリへ保存後にホスト側で切り替えます。検査は形式と整合性を保証し、内容の品質評価を代替しません。

`bun run context:task DB QUERY RECORDS OUTPUT_DIR` とシナリオ評価は、このwriterで主ファイルと全referencesを出力します。生成物にはsource・制約・未検証の仮説を含め、利用前に確認します。下流タスクでの効果は未測定です。
