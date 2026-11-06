# Eumenes SkillSmith 実装計画

更新日: 2026-11-06  
状態: コア・SQLite adapterの実装とfixture検証を進行中。本体組込み・live受入は未実施。

2026-11-06の追加依頼により、ContextStillの公開範囲をread-onlyでコピーする独立試験基盤を `examples/contextstill` に追加した。元DBを変更せず、コピーしたローカルDBだけで検索・取得・SourcePort接続・固定モデルによる保存結合を確認する。これはP4/P8の実接続・実LLM評価を完了したことを意味しない。使い方と制限は[単体試験基盤](examples/contextstill/README.md)、引継ぎは[Grokbot向け手順](GROKBOT_HANDOFF.md)を参照する。

続く公開許可に基づき、MIT LICENSE、README、知識のみの公開seedと `context:seed` を追加する。経験・設定・認証情報・生成SQLiteは公開seedへ含めない。clone先で元DBなしに初期化・検索・保存結合できること、seedの改変・公開範囲・参照切れ・無断上書きを拒否すること、コア配布物にLICENSEとREADMEを含めることを完了条件とする。

## 1. 目的と文書の役割

Eumenesの会話エージェントとサブエージェントが、既存Skillと経験を検索し、現在の目的・制約・能力に合う実行用Skillを受け取れるようにする。SkillSmithを独立したTypeScriptライブラリとして開発し、本体のknowledge domainから同一プロセスで利用する。

動作・責務・データ契約の正本は[設計書](design.md)。本書は作業単位、依存、検証、完了条件を管理する。[レビュー記録](review.md)は文書の改善履歴であり、製品試験の結果ではない。2026-11-05の立上げ計画にあった仮API・未決事項の一覧は、現在の設計と以下の作業に統合した。

最終MVPには、ContextStillとRegistryからの検索、実行用本文のビルド、Eumenesへの組込み、Claude Code／Codex SDKへのMCP配布、結果報告、条件付き振り返り、改善候補を含む。正式採用と切戻しは権限付き管理操作とする。コア単体やEumenes内の部分受入だけを最終MVP完成とはしない。

## 2. 作業範囲と進め方

利用者の実装開始指示により、以下の計画に沿って実装を進める。現在の進捗・検証・残作業は[実装記録](implementation.md)に記録する。製品DB・設定・稼働サービスは、この実装開始だけで直接変更しない。設計の変更が必要なら、実装で先行せず設計へ反映して合意する。

- SkillSmith側は公開契約、検索・ビルド、保存adapter、結果・候補、fixtureと評価、配布物を担当する。
- Eumenes側はknowledge domain、各公開portへの接続、追加のRegistry契約、会話・担当、HTTP・認可・lifecycleを担当する。
- ContextStillの利用は公開MCPの検索・取得に限定し、そのコード・DBは本計画で変更しない。候補はEumenesに保存する。
- 実行判断は既存のエージェント、意味の判断はLLM、強制可能な契約はコードが担う。発話・語句・個別事例による専用の判断分岐を作らない。
- 専用プロセス、ポート、LLMサービス、Memory、実行engine、UI、外部DB、ORM、新しいagent frameworkは追加しない。
- 本体のmainと進行中の変更を保全する。別チャットへの送信、無許可のサービス停止・起動・再起動を検証経路に含めない。

実装と検証の入力は各単位で固定する。部分 → 結合 → fixture通し → liveの順に進め、未実装の後段を通すための再実行はしない。同じ目的の3ラウンド、または新しい根拠のない反復が続けば、証拠・残作業・仮説を見直して次の一手を通知する。

## 3. 段階と依存

| ID | 作業単位 | 前提 | 完了判定の範囲 |
| --- | --- | --- | --- |
| P0 | 接続契約と入力の固定 | 設計案の合意 | 現行版と不足、変更対象、確認方法を固定 |
| P1 | packageと公開schema | P0 | 検証可能な骨格と契約。ビルド機能完成は要求しない |
| P2 | 検索・再利用・動的ビルド | P1 | 外部依存をfixtureにした実行用本文 |
| P3 | 永続化・queue接続契約・結果と候補 | P2 | 再起動・再送・取消・予算を含む保存結合 |
| P4 | 本体の基盤と外部知識adapter | P3、P0の本体契約 | 同一プロセスの直接呼出しと復旧・失効 |
| P5 | 会話・担当・Pursuitへの受渡し | P4 | pendingから本文利用・結果報告まで |
| P6 | 正式採用・範囲・切戻し・消去 | P4、P3の候補 | 正式公開の管理操作。範囲・消去確認まで無効 |
| P7 | 同一HTTP上のMCPと外部利用側 | P5、P6 | 3種類の利用側のfixture受入 |
| P8 | live受入と比較評価 | P0〜P7のfixture通過 | 製品要件と効果の採否を分けて判定 |

各行は次段階へ進むためのgateである。fixture完了、live完了、効果確認を同じ「完了」にまとめない。外部接続の不足はP0で所有先と有効化条件を記録し、未確認のままP7／P8を完了にしない。

## 4. P0 接続契約と入力を固定する

本体HEAD、未コミット差分、Bun・依存版、domain階層、queueのhandlerと終端、推論のcontrol request、会話のtool一回の契約を再照合する。Pursuitは既に調査用途で接続済みという前提で扱う。

成果物は、対象版・差分・公開schema・所有者・確認方法を記録したintegration-contract.mdと、影響対象一覧とする。文書はP0実施時に作る。tokenや個人情報の実値を記録しない。

| 確定する契約 | 所有者と具体的な確認 |
| --- | --- |
| Skill単体検索・適用metadata・公開範囲 | capabilities公開操作と既存索引を確認。従来のpackage検索をそのまま流用しない |
| 要求と開始予約／jobの原子受付、settleの成功確認 | 親会話終了前は開始予約、終了後はqueue登録と予約消費を同一transactionで行えることをfixtureで確認 |
| 独立した推論requestと絶対期限 | inferenceのroute: subagentとreceipt、予算、取消の契約を確認 |
| pendingのworkと配達 | dialogueの出所・work制御・Host noticeを確認。配達IDと冪等受付を定義 |
| scopeと忘却 | 検証可能なホストscope、Memory journal／purge、capabilities消去の追加点を確定 |
| ContextStill | 対象版、tools/schema、契約版、公開scope、省略・失効・後継を確認。現行は読取りのみ |
| MCPと利用側 | ホストのMCP依存、認可方式、対象クライアント版、本文入力、非同期受取、結果報告の確認項目を固定 |

完了条件は、各契約に再利用する公開操作、追加操作、担当場所、対応するfixtureがあること。外部SDKやMCPの仕様が不明なら、公式資料と実際の対象版を確認する調査をP7の前提に残す。製品接続・認証が未実施であることを、開発用MCPの利用で埋めない。

## 5. P1 packageと公開契約を作る

Bun 1.4.4、TypeScript strict／ESM／ES2022、Zod 4系を本体と合わせる。型境界はJSONと構造的な型に限定する。コア、./sqlite、指示資産の配布範囲を分離する。Gitはmainで初期化済み。配布前にソース版を固定できる管理単位を整える。remote作成・公開・pushは含めない。

公開schemaには、入力とTrustedContextの分離、ready／pending／needs_input／unavailable／rejected／cancelled／expired、ビルド、依存、結果、候補、再送、継続参照を含める。設計書6章・15章の契約を共有し、MCPと直接呼出しで別schemaを作らない。

次のコマンドを定義する。package.json に実装済みで、`bun run verify`（Bun 1.4.4）からまとめて実行できる。

| コマンド | 対象 |
| --- | --- |
| bun run typecheck | 公開型と実装の型 |
| bun run lint／format:check | 本体と整合する静的検査 |
| bun test src/test | network・サービス起動なしのfixture |
| bun run build | 配布用JavaScript・型宣言と指示資産 |
| bun run pack:core | tgzとmanifest、内容の許可リスト検査 |
| bun run verify | 型・lint・format・fixture・build・pack検査をまとめる |

完了条件は、不正schemaと非互換版の拒否、対応する互換版の受理、exportの読込み、import時の副作用なし、配布物への開発資料・設定・秘密の非混入を確認すること。実行用本文を生成する機能はP2で検証し、P1のgateへ前倒ししない。

## 6. P2 検索とビルドを実装する

RegistryPort、SourcePort、InferencePort、PolicyPort、保存・job用fixtureを注入し、get_guidanceの全返却kindを通す。まず同一要求の再送と検証済みの直接再利用、その後に候補取得、単一Skillの差分、複数Skillの合成、未知タスクの暫定構成を接続する。

既存Skillにはsection IDがある場合だけ型付き差分を適用する。ない場合は全文に基づく再構成とする。受入条件・制約のIDと原文は保持する。検索順位は候補削減にだけ用い、適合・矛盾の判断はLLMに渡す。

部分試験は src/test/build.test.ts を中心に実装済み。検索通知は source-notices.test.ts、後継取得は successors.test.ts。当初案の reuse.test.ts / sources.test.ts / context.test.ts は独立ファイルとしては作らず、build 系へ統合した。

通過条件は次のとおり。

- 条件を満たす直接再利用はLLM呼出し0回。タスク・scope・依存・指示版の違いでは誤再利用しない。
- 候補なしと検索障害を区別し、必須の欠落・矛盾・省略をprovisionalで隠さない。
- get_guidanceのready本文だけで最初の行動と検証が分かり、利用側が候補を再合成しない。
- 資料中の命令、未提示参照、存在しない能力、条件を削った短縮を採用しない。
- 検索・取得・修復を含む総予算を守り、段階を変えて上限を戻さない。

## 7. P3 永続化と改善候補を実装する

ホストから渡されたSQLite接続で動く保存adapterと追加migrationを作る。本体DBを自分で開かない。queue payloadには参照とepochを入れ、本文を複製しない。

要求と開始予約／jobの原子受付、親の解放後の予約消費とenqueue、readyと配達待ちの原子保存、取消・期限・job中断の終端、同じ入力の再送と異入力衝突、継続用の新要求を実装する。queue進捗はqueueを正本とし、確定結果・receiptはqueueの保持期限に依存させない。

report_resultは認可済みbuildRefとexecutionRefに結び付け、同じ実行をreportId違いで二重集計しない。訂正は結果版で扱う。新規性の判断を再利用し、必要時だけ改善候補を作る。候補・検証・採用の区別を保存する。

保存結合は src/test/sqlite.test.ts、requests.test.ts、results.test.ts、proposals.test.ts、forget.test.ts として実装済み。各試験は一時DBと固定時計・固定依存を使う。

完了条件は、受付・成果物・配達の途中失敗で部分保存が起きないこと、再起動しても消費予算を戻さないこと、取消後の遅延結果を採用しないこと、間接的な依存閉包を失効・消去できること。ここでのqueueは注入fixtureであり、本体の実queueとの結合はP4で行う。

## 8. P4 Eumenesの基盤へ組み込む

固定したtgzとmanifestをvendor/skill-smith/に置き、file依存とlockfileを更新する。knowledgeをtier 1として登録し、inference・Memory・World・dialogueはapplicationのportから接続する。既存domainの階層は引き上げない。

capabilitiesへホスト共通Skillの検索・本文・依存確認の公開操作を追加する。個別範囲の生成物はknowledge内のビルド／候補として扱い、正式公開はP6まで無効とする。ContextStill adapterは公開MCPの読み取りに限定し、searchTaskと内部の本人情報を分離する。

queue handlerの登録、migration順序、recover／start／close、開始予約からjobへの原子的移行、忘却journalの再適用、配達処理を接続する。開始予約の解放は既存commit通知・復旧・保守で照合し、通知の欠落・二重通知・親の取消・待機期限も検査する。会話が補助推論を待つ同期経路を追加しない。

本体側の新設結合試験はapi/application/knowledge/composition.test.ts、queue.test.ts、source-adapter.test.ts、lifecycle.test.ts、forget.test.tsを予定する。Honoはapp.request相当のプロセス内呼出しで検査し、serverは起動しない。

完了条件は、直接呼出しで保存・検索・ビルド・取得できること、実queueとcontrol requestが既存制限に従うこと、失効・忘却後に本文を返さず、終了時に依存を先に閉じないこと。live接続はまだこのgateに含めない。

## 9. P5 会話と担当への受渡しを接続する

会話はget_guidanceを常設host toolとして利用し、一回のtool枠を維持する。同期readyは局所的な再利用だけとし、新規生成・外部再検査はpendingで保存workへ結び付ける。knowledge所有のworkRefとrequestRefを対応付け、既存のTaskLifecyclePort相当の照会・取消・制御をapplicationのadapterで接続する。元会話の呼出しが終了した後に生成し、同じ配達IDで本文を再開／通知へ渡す。

サブエージェントはbuildRefとexecutionRefを結び付けて本文を受け取る。親子で能力が同じでも依頼の意味が異なれば直接再利用しない。on_demand／on_start等の方針は登録定義に置き、既存tool-runtimeへの追加はbundle＋adapterで行う。

Pursuitと作成アシストにも同じportを接続する。on_startは担当の最初の推論前、on_demandのpendingは既存の非同期operationとしてrequestRefと再開位置を保存し、呼出元の実行枠を解放してからビルドを進める。動的Skillをruntime欄へ入れ、既存の必須境界・出力schema・実行済み操作を保持する。

新設結合試験はapi/application/knowledge/conversation.test.ts、worker.test.ts、pursuit.test.ts、delivery.test.tsを予定する。bundle追加時は本体のbundle検査も行う。

完了条件は、会話のpending → 本文配達、担当の本文利用 → 実行 → 検証 → 結果報告 → 候補までのfixture通しが成立すること。配達の重複、途中終了、取消、訂正、別話題の進行を検査する。指針完成と実作業完了を混同しない。

## 10. P6 正式採用と利用範囲を実装する

capabilities所有のscope metadata、範囲付き取得、Skillのcompare-and-set公開・切戻し・本文消去を追加する。従来のscopeなし取得、依存閉包、bundle import、検索、既存の履歴参照から個別Skillを迂回取得できないことを検査する。

管理API／CLIで候補、差分、根拠、検証、scopeを確認できるようにする。採用は候補版、expectedActiveRevisionとexpectedGenerationを照合し、候補とRegistryを同じtransactionで確定する。適用関係の登録・撤回も管理操作に限定する。

正式Skillの新版を作っても既存packageの固定revisionは自動変更しない。既存担当へ必須適用する改訂は通常のbundle／package変更として扱う。

新設結合試験はapi/application/knowledge/publication.test.ts、scope.test.ts、erasure.test.tsを予定する。既存の組込みSkillとpackageの動作も回帰確認する。

完了条件は、権限・競合・採用／棄却・ABA競合・切戻し・推移的忘却・古いDB復元後の再失効が成立すること。scopeと消去が未検証なら正式公開を無効のままにし、この段階を完了にしない。

## 11. P7 MCPと外部利用側を接続する

本体の既存Honoへ/mcp/knowledge/:connectionを登録する。接続ごとの認可scope、token失効epoch、Host／Origin、サイズ、頻度・並行数の上限を検査する。MCPの具体的なHTTPメソッド、初期化、応答・取消方式は対象実装の契約を確認して固定する。

外部adapterは本文の受渡し、最小利用規則、環境能力の申告、状態取得、結果報告を担当する。Claude Code／Codex SDKの対象版と実際の入力経路を確認し、MCP接続だけで自動Skill登録されるとは扱わない。外部の能力と成功報告は自己申告として区別する。

pushが使えないクライアントは、pendingのrequestRefに対してretryAfterMsとdeadlineAtを守ってget_buildする。ホスト負荷を抑える間隔を設定し、期限到達時は最後の状態照会を一度だけ行って停止する。readyが確定済みなら生成期限後でも取得でき、本文の有効性と保持期限は別に検査する。通知を使う場合も切断後はget_buildで照合する。30日の再送保証期間外は不明な結果を自動再実行しない。頻回取得や無期限待機を仕様にしない。

新設結合試験はapi/application/knowledge/mcp.test.ts、clients.test.tsを予定する。直接呼出しとMCPで、同じビルド本文・構造化情報・認可の結果になることを確認する。

完了条件は、Eumenes、検証用Claude Code、検証用Codex SDKの各経路をfixtureで通せること。最終live受入に使う接続・入力・期待結果・費用上限が揃うこと。既存の別Codexチャットを検証先に使わない。

## 12. P8 live受入と効果を測定する

fixture通過後に、実ContextStill・Registry・保存済み推論設定と各利用側を接続する。必要なサービス操作は明示許可の範囲で行い、実行ID、対象版、入力digest、結果、失敗、使用量を記録する。秘密・本文の実値を通常ログへ出さない。

既知・類似・未知・条件違いを各利用側で受け渡し、本文利用から結果報告・候補まで確認する。取消、失効、能力不足、外部検索障害も分けて記録する。外部の即時失効は現在のsnapshot保証と区別し、追加通知／lease契約が必要な運用では未達のgateとして扱う。

比較評価の試行数、基準、初回費用と再利用、冷状態と温状態の条件は設計書18章に従う。実行前に評価manifestを固定し、途中で学習データ・候補・受入条件を更新しない。予算不足による未実行や費用不明を成功へ換算しない。

完了条件は、最終MVPの全要件について実装・fixture・live・効果を別々に報告し、残る制約を明示できること。製品要件が成立しても効果基準を満たさなければ、効果未達として改善または採用見送りを判断する。

## 13. 検証の実行範囲

| gate | 実行内容と注意 |
| --- | --- |
| SkillSmith部分 | 各段階の新設試験ファイルを指定。LLM・HTTP・時計・保存を注入し、外部networkとserver起動は使わない |
| SkillSmith全体 | P1で定義するbun run verify。後段未実装の通しを途中gateへ混ぜない |
| 本体domain | bun run verify -- --domain knowledgeと、変更・影響があるcapabilities／queue／inference／dialogue／agent-runtime／pursuit／tool-runtime／memoryを個別選択 |
| application結合 | 各段階に示したapi/application/knowledge/配下の実装済みファイルをbun testで指定。domain指定だけで代替しない |
| bundle | 追加・改訂したbundleにbun run toolchain:bundle -- checkを適用し、seedの冪等性と既存revisionの不変性を確認 |
| 配布・更新 | fresh DB、既存DBへの追加migration、二重適用、manifest／lockfile／importの一致、機能無効化後の取消・消去を検査 |
| live | 対象と費用上限を固定したP8だけで実行。fixtureと結果を分ける |

新規UIは対象外なのでブラウザE2Eを必須にしない。既存画面への影響が実際に生じた場合だけ、対象ファイルを明示して追加する。文書だけの現在のレビューでは、参照・依存・状態・要件対応を検査し、製品試験は実行しない。

## 14. 要件と受入の対応

| 要件 | 実装単位 | 主な受入 |
| --- | --- | --- |
| 検索・再利用・動的生成・未知タスク | P2、P4 | 適用条件、本文、意味判断、誤適用 |
| 会話と担当の共通サービス | P4、P5 | 同一本文・契約、親子再利用、実行結果 |
| 同一プロセスと既存技術スタック | P1、P4 | import副作用、配布、lifecycle、追加listenなし |
| 正式Skillと候補の分離 | P3、P6 | 管理採用・棄却、競合、切戻し |
| scope、取消、失効、忘却 | P3〜P7 | 取得・採用・配達・派生閉包、復旧 |
| 3種類の利用側とMCP | P5、P7、P8 | fixtureと実接続で本文利用・結果報告 |
| 結果からの条件付き改善 | P3、P5、P6 | 自己申告／検証、重複集計なし、振り返り回数 |
| 成功率・時間・総費用 | P2から記録、P8で比較 | 初回・再利用・失敗を含む同条件評価 |

## 15. 現在の進捗

- [x] 目的、知識domainの責務、技術スタック、動作契約の設計案を作成
- [x] 設計・実装計画の文書レビューと参照・整合確認
- [x] 設計案に基づく実装開始の指示
- [ ] P0の本体接続fixtureを含む契約の固定（SourcePortの検索通知とprovider注入の契約は2026-11-06に固定。本体の公開操作は未照合）
- [x] P1〜P3のコア・SQLite adapter・結果・候補の初期実装とfixture
- [x] 公開範囲のDBコピー、疑似ContextStill、単体試験・実データ確認・Grokbot引継ぎ基盤
- [x] MITライセンス、README、公開知識seedとSQLite初期化・検証
- [ ] P1〜P3の残契約と正式配布版の固定
- [ ] P4〜P6の本体・利用側・正式採用
- [ ] P7のMCP・外部利用側fixture受入
- [ ] P8のlive受入と比較評価

## 16. 参照

- [実装と検証の記録](implementation.md)
- [本体接続契約](integration-contract.md)
- [知識ドメイン設計](design.md)
- [文書レビュー記録](review.md)
- [Eumenes作業規則](../eumenes/AGENTS.md)
- [ツールチェーンの登録と拡張](../eumenes/docs/toolchain-extension.md)
- [検証手順](../eumenes/docs/toolchain-extension-verification.md)
- [記憶の責務と忘却](../eumenes/docs/memory.md)
