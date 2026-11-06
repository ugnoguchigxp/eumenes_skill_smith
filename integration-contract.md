# SkillSmithとEumenesの接続契約

更新日: 2026-11-06  
状態: コアのport・schemaと固定試験を作成。本体の組込み試験は未実施。

## 1. 対象と変更境界

調査時のEumenes本体はac373175522dfdd22df99e2bff631b4810421484。作業ツリーは調査開始時点でcleanだった。Bunは1.4.4、TypeScriptは7.0.2、Zodは4.4.3、oxlintは1.86.0を本体と同じ版に固定した。本体・ContextStillの製品コード、設定、DB、稼働中サービスは今回変更していない。終了時点では本体に別作業のbundle・試験・spec差分があるため、組込み前に確定版を再照合する。

[公開schema](src/contracts/schema.ts)、[port](src/contracts/ports.ts)、[コア](src/service/index.ts)、[SQLite adapter](src/sqlite/index.ts)を実装した。コアは任意のTx型に対する同期repository操作を使い、SQLite固有型は./sqliteの入口に閉じる。

### 1.1 2026-11-06の再照合（読取りのみ）

`/workspace/eumenes` で `git fetch --depth=50 origin` を行い、origin/main `3eb6a54032cd54548df299f1a93ec5df2e2bdd64`（2026-11-06 15:56 JST）を `git show` で読んだ。作業ツリーは5bf5ca5のまま変更していない。ac37317はorigin/mainの祖先で、ac37317..3eb6a54のcapabilities・inference・queueの差分は13 files（+279/−12、bundle・codex/cloud-agent adapter・independent-control・試験）。

| 本体の操作（3eb6a54） | RegistryPortへの適合 |
| --- | --- |
| `capabilities.searchInTransaction(db, owner, intent, terms, deadline, limit)` | kind='package'だけを返し、card は candidateRef（5分の一時参照）。Skill単体の検索には使えない → **追加公開操作が必要** |
| `getDefinitionInTransaction(db, revisionId)` | 有効なrevisionのhash・kind・本文（skillのみ）。read の再利用候補。ただしscope・status・section IDは返さない |
| `instructionInTransaction(db, revisionId)` | profile/skill本文とhash。readの代替候補 |
| `validateInTransaction` | 定義の検証。版の現在性検査（current）には直接対応しない |
| knowledge domain | `api/domains/knowledge` は存在しない（0 files） |

結論: read は既存操作の再利用で足りる見込み。search（Skill単体のカード、scope・status付き）と current（revisionIdの有効・現行判定）はcapabilities所有の追加公開操作が必要で、本体側の作業（P4）。SkillSmith側では推測のAPIを作らない。

## 2. ホストで接続する操作

| 契約 | 現在のコアと検証 | 本体で必要な接続 |
| --- | --- | --- |
| 単一writer | submit／activate／prepare／reserve／settleを同期transactionで呼ぶ。途中失敗のrollbackをfixtureで確認 | SqliteStore.writeの同一DBをsqliteRepositoryとqueueに渡す |
| 開始予約 | parentRefがあればjob登録を行わず、activateで原子的に登録。二重解放・期限を検査済み | 親会話・担当の実行枠解放を既存commit通知・復旧から照合 |
| queue | payloadはrequestRefとepoch。新しいrunTokenで古い結果を拒否し、消費済み回数を保存 | knowledge.build.v1 handlerを登録。初期はmaxAttempts 1・recovery interruptとし、未知の完了から自動で意味上の推論を再実行しない |
| 推論 | InferencePortにschema・指示・期限・出所を渡す。receiptの失効を採用時に検査 | inferenceのcaptureUserControlInTransaction、route subagent、executeControl、usage照会・receipt検査・取消へ接続 |
| 正式Skill | RegistryPort.searchとreadを分離。取得した版と候補版の一致を確認 | capabilitiesにSkill単体のカード・本文・有効性の公開操作を追加。下位domainへknowledge依存を作らない |
| 外部検索 | SourcePort.search／get／validate。外部queryはTrustedContext.searchTaskだけから取得 | ContextStill公開MCPのsearch_knowledge／get_knowledgeへadapterを接続。管理API・DBは利用しない |
| 権限 | Authorityはモデル入力と分離。scope・principal・epoch・元の参照を再検査 | ホストで検証済みのscopeと各参照の有効性をAuthorityPortで照合。外部の申告で権限を増やさない |
| 共通方針 | PolicyPortの本文・版と受け手が既に持つ版を照合 | 既存の指示資産とcontext budgetへ接続し、二重注入しない |
| 配達 | settleは成果物と配達待ちを同時保存 | requestRefを既存workRefに対応付け、Host notice・再開を冪等配達。送信直前も検査 |
| 結果・候補 | bindUseでタスク適合を照合。結果の訂正・重複、振り返りの一回の予約、候補保存を実装 | 実行台帳・根拠・管理API／CLI、正式Skill公開・切戻しへ接続 |
| 忘却 | 元参照を先に失効し、依存閉包を有界に消去。残りをpendingで返す | Memory purgeとjournal再適用、配達先の所有domainの消去、既存queueでの継続消去 |
| lifecycle | importは通信・DB作成・listen・timerを行わない | buildServices、migration、recover／start／close、保守処理へ登録 |

本体queueのhandlerにはprepareInTransaction、execute、settleInTransaction、cancelInTransactionがある。コアの同名段階をその境界へ接続する。executeが投げた失敗はfailへ渡す際にPreparedのrunTokenを照合し、古いworkerの失敗で新しい試行を終了させない。

submit等の入力・権限・競合違反は、transactionをrollbackするための例外として返る。ホストのtransportはwriterの外で安全な理由コードへ変換し、未信頼の入力やZodの詳細本文・生の例外をログ／MCPへ流さない。読取りの拒否はReplyのrejected等として返す。

## 3. 検索と予算の実装上の契約

検索は本文を持たないEvidenceCard、読取りはEvidenceを返す。Registryと外部の候補は各検索元の順位を保って交互に並べ、候補・本文の上限内だけを取得する。順位は適合判定を代行しない。

検索、各本文取得、外部再検査ごとにsourceCallsを予約する。モデルは入力容量を検査した後にmodelCallsを予約し、必要時の構造修復も同じ総予算で行う。source.validateにはビルド中は一件ずつ渡す。本体adapterで複数の通信を隠して上限を迂回しない。

### 3.1 検索全体の通知（2026-11-06追加）

SourcePort.searchは `SourceSearch = { cards, warnings: {kind, refs}[], degraded: string[], truncated }` を返す（`sourceSearchSchema`）。旧来のEvidenceCard配列は受け付けない。コアは構造だけを検査する: schema違反、external=falseのカード、返却カードにないrefを指すwarningは推論前に `source_contract_violation` で拒否する。kind・degradedは64字以内の識別子（`[a-z0-9_.:-]`）に限り、自由文を推論入力へ流さない。

推論入力の `search.external` には、候補に残ったカードだけを指すwarnings、候補外を指したwarningの件数 `omittedWarnings`、degraded、truncatedをそのまま渡す。通知の意味（競合が必須条件に関わるか、縮退で不足が生じるか）はコードで判定せずLLMが判断する。指示は `build.v2` に更新し、キャッシュキーも変わる。

ホスト側の未確定事項: 実ContextStillのsearch_knowledgeが返すwarningsの実schemaとkindの語彙、degradedの語彙は未照合（疑似APIは `{kind:"unresolved_conflict", handles}` と `mock_lexical_only` 等）。実adapterはhandle→refの変換と語彙の検査を製品接続前に確定する。

### 3.1b 再検索の外部query境界（2026-11-06追加）

モデルが返す `kind=re_search` の `query` はローカル RegistryPort.search にだけ渡す。SourcePort.search へ渡す外部queryは、初回と同様に TrustedContext.searchTask のみとする。モデルquery・task.goal・constraints・記憶・未信頼本文を外部へ流用しない。searchTask が無い／SourcePort が無い場合は外部再検索を行わず、ローカル再検索だけを実施し、`search.reSearch[].externalQuery` は null とする。keyword による PII 検出はこの境界の代用にしない。

### 3.1a 撤回済み資料の後継（2026-11-06追加）

EvidenceCard／Evidenceは任意の `supersededBy`（同じ取得元のref）を持てる。コアは取得したsupersededの文書に後継があれば、同じ取得元から documents上限とsourceCalls予算の内で取得する。結果は推論入力の `search.successors` に `{ref, successor, outcome}` として渡す。outcomeは fetched／unavailable（取得失敗・ref不一致・scope外）／cycle／limit。予算超過・中断・コアの拒否は従来どおりビルド失敗とする。後継が今回の目的に合うか、不足を補えるかはLLMが判断する。指示版は `build.v3`。ContextStill疑似adapterは `item.supersededBy` のhandleをrefへ変換する。実ContextStillでの後継の公開性は未照合。

### 3.1c 評価キットの負例監査（2026-11-06追加）

`examples/contextstill/eval-kit.ts` は比較の前に `auditEvalSuite` を行う。同一 task の A/B/C 条件欠け・重複、`--require-records` 時の空 record、および companion の `*.expected-digests.json` と一致しない `inputDigest` 改竄は失敗とする。補助指標の token overlap は `lexicalOverlap`（字面一致）と呼び、意味的 faithfulness とは扱わない。評価結果 JSON と推論 record は別物であり、CLI の整形出力を品質スコアとしない。

### 3.2 推論providerの注入

本ワークフローのlive推論providerは親チャットのGrok Botである。コアはInferencePortだけに依存し、LLM clientを持たない。`examples/contextstill/recorded.ts` は、送信する `{system, data, schema}` のdigestを付けた課題を書き出し、providerが返した構造化出力をそのdigestに一致する場合だけ再生する。記録がない・入力が異なる場合は `inference_record_missing` で失敗する。`bun run context:task [db] [query] [records.json]` は課題を `data/contextstill/inference-task.json`（Git対象外）へ出力する。fixed_wiring_stubと試験用の記録は接続確認であり、意味品質の評価ではない。

完成後のgetValidatedは読み取り用の短い期限で外部の参照版を再検査し、生成を再開しない。配布のI/O使用量とリクエスト頻度の制限は、本体の取得API／MCP接続で記録・強制する。コア単体の試験でその本体側計量まで実証したとはしない。

## 4. 保存形式と未実装の有効化条件

追加migrationはknowledge/0001-init。要求、ビルド、依存、失効、利用先、配達、結果、報告receipt、振り返り予約、候補を保存する。適用済みのmigrationを変更せず、本体へ取り込んだ後の変更は新migrationにする。

現在のコアは通常の同条件キャッシュを再利用する。管理者が検証した適用関係の永続的な登録とパラメータ契約、正式Skillのscope・公開・切戻し・消去はP6で接続する。保持期限の保守・job終端との照合・本体の忘却journal再適用はP4で接続する。これらの管理契約が未検証の間、正式公開を有効にしない。

MCPの認可、Claude Code／Codex SDKの対象版と本文読込、実接続受入はP7／P8で確認する。開発会話のMCPが利用できることを、製品接続の成立とは扱わない。強い外部即時失効は現在のsnapshot保証とは別の依存として残す。
