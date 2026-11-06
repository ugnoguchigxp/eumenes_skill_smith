# SkillSmith 実装と検証の記録

更新日: 2026-11-06

## 1. 今回実装した範囲

独立package、公開schemaとport、LLMへ適用・差分・合成判断を渡すビルド、SQLite保存adapter、開始予約・冪等受付・予算・取消・結果採用・配達待ち、結果の訂正と改善候補の生成・検証状態を実装した。

意味を判断するためのキーワード分岐や固定応答は追加していない。reuse／adapt／compose／provisionalは注入されたLLMの構造化出力と、明示的な同条件キャッシュによって選ぶ。コードは参照、版、能力、必須前提、schema、予算、権限、保存を検査する。

初回のコア実装はSkillSmith内のコアと一時fixtureに限定した。その後の追加依頼により、5章の公開範囲のDBコピーと単体試験基盤を追加した。Eumenes本体のコード、設定、サービス、別のチャットは変更・操作していない。

## 2. 追加したもの

- 公開schemaとversion付き返却契約、ホストが付与するAuthority
- 任意のTxへ接続するportと、独自にDBを開かないSQLite adapter
- 検索カードと必要な本文取得の分離
- 同条件再利用、Skill全文再利用、section IDへの差分、合成、暫定生成
- 開始予約、出所・epoch・runToken、絶対期限と消費台帳、取消と遅延結果の拒否
- 読取りだけのgetと、外部再検査付きのgetValidated
- task・environmentを照合した利用先の結付け、結果の冪等報告・訂正
- 振り返りの永続予約、一回の推論予算、改善候補、管理者による検証状態
- 推移的な失効と有界消去、DB再オープンの固定試験
- 型・lint・format・試験・build・tgz検査のコマンド

## 3. 検証

部分試験から保存結合へ進め、最後にbun run verifyで型・lint・format・全固定試験・build・配布物の内容確認と配布物からのimportを確認する。最終の通過結果は次のとおり。

| 確認 | 最終結果 |
| --- | --- |
| bun run typecheck | 21ファイル、型エラー0 |
| bun run lint | 通過 |
| bun run format:check | 26ファイル通過 |
| bun test src/test | 6ファイル、45件成功・0件失敗、108 assertions |
| bun run build | JavaScriptと型宣言の生成に成功 |
| bun run pack:core | 21ファイルの内容・hash・展開・importを確認 |

最終点検では読取り権限、元要求のprincipal、振り返りの権限変更も検査し、回帰試験を追加した。コードの分岐は契約・参照・権限・状態・予算に限定され、特定の発話や題材を判定する処理はない。検証終了後の変更は文書の結果追記だけとし、試験したコードを変更していない。

モデル、検索、queue、時計、権限は固定fixture。一時SQLite DBを使い、networkとBun.serveは禁止した。固定モデルで確認したのは契約・状態・接続であり、実LLMの意味判断や効果の評価ではない。

配布物はartifacts/eumenes-skill-smith-0.1.0.tgzとmanifest.json。Git初期化はmainで行い、commit・remote作成・pushは行っていない。sourceGitCommitはnullで、sourceDigestと配布ファイルhashを記録する開発用成果物である。本体への正式な取り込み版はまだ固定していない。

## 4. 残作業

| 計画 | 現在の位置 |
| --- | --- |
| P0 | 本体版・既存操作・コアportを調査してintegration-contract.mdに記録。本体側の追加公開操作と結合fixtureは未実施 |
| P1 | package、schema、型・静的検査、開発用build／packを実装。正式な取り込み元commitの固定は未実施 |
| P2 | 検索・再利用・差分・合成・未知タスクのコアをfixture確認。管理された適用関係、実Registry／ContextStillとの接続と実LLM評価は未実施 |
| P3 | SQLite、開始予約、再送・取消・予算、結果・振り返り・候補をfixture確認。保持の保守と実queueの終端照合は本体接続待ち |
| P4 | knowledge domain、公開Registry操作、実queue・推論・検索adapter、lifecycle、忘却journalへ未接続 |
| P5〜P8 | 会話・担当・Pursuit、正式公開管理、MCP、外部利用側、live受入、効果評価は未実施 |

コアや開発用配布物の完成を最終MVPの完成とは扱わない。次の実装単位は、本体の追加公開操作と、同一writer・queue・独立control requestへの接続である。

## 5. ContextStillの独立試験基盤

追加依頼に基づき、`examples/contextstill/` に次を実装した。

- read-only transactionでWALを含む整合した公開範囲を取り出すPython標準ライブラリのコピー処理。設定・認証情報・鍵・raw source・personal・repo限定の行は複製しない。
- 独自SQLite形式、公開知識・経験の本文・条件・例外・手順、公開事例参照・後継・競合ペア、role/sourceKindに限定した出典情報。
- Bun/TypeScriptによるread-only取得、文字列検索、引数・公開範囲・byte上限、プロセス内Request/Responseの疑似MCP。
- `_fixture` の版・本文ハッシュ・省略フラグを使うSourcePort接続例と、一時DB・固定モデルでの保存結合例。
- 合成データから作る固定試験、コピー済み実データの通し確認、Grokbot向け手順書。

ローカルコピーは `data/contextstill/snapshot.sqlite`。対象ソース版は `dd365e96115903626254a3d445ed5e097210a194`、取得時刻は2026-11-06T02:11:38Z、知識6,957件・経験843件、42,860,544 bytes。元DBの丸ごとコピーではない。全7,800件の投影本文がschemaを満たし、SQLite integrity_checkはok。コピー処理は元DBに書き込まない。保存先は0700、DBは0600で、Gitとコア配布物から除外している。

最終の検証結果は以下のとおり。3章の値は初回コア実装時の記録である。

| 確認 | 結果 |
| --- | --- |
| 型・lint・format | 31型検査ファイル・36整形対象、すべて通過 |
| コア固定試験 | 45件成功、0失敗、108 assertions |
| examples固定試験 | 17件成功、0失敗、74 assertions。うちコピー処理のPython内部試験2件を含む |
| build・pack | JavaScript・型宣言・21ファイルの内容hashと展開importを確認。examplesと実データの混入なし |
| コピー済み実データ | context:checkで検索8件、ready、依存1件、固定モデル1回、source port呼出し6回、通信・listenなし |

試験では、更新検知の対象レコードを誤って別の経験にしていた点と、既存契約の拒否kindを取り違えていた期待値を修正した。変更検知の条件や製品要件は弱めていない。最後にコピー全件、ソースと配布物の内容、無関係の変更を点検した。製品の意味判断への専用分岐は追加していない。文字列検索は候補取得だけで、固定モデルは接続確認専用の例に閉じている。

実データ確認はDBの差し替え完了後に実施した結果を採用した。稼働サービスは起動・停止していない。ContextStillのソース作業ツリーに変更がないことも確認した。

実ContextStillとの相違は[基盤のREADME](examples/contextstill/README.md)、次の担当への注意点は[Grokbot引継ぎ](GROKBOT_HANDOFF.md)に記載した。特に実APIには `_fixture` がなく、SourcePortには検索全体のwarnings/degradedを渡す契約が不足する。実adapterの版固定・省略検知・競合情報の受渡しは未実装であり、この基盤でP4/P8の実接続・実LLM品質を完了とは扱わない。
