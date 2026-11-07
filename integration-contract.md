# SkillSmithとEumenesの接続契約

更新日: 2026-11-07  
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

検索、各本文取得、外部再検査ごとにsourceCallsを予約する。モデルは入力容量を検査した後にmodelCallsを予約し、必要時の構造修復も同じ総予算で行う。source.validateには選択元をまとめて渡す。metered adapterは各getを共有予算へ予約する（legacy adapterの論理一回計量とは区別）。本体adapterで複数の通信を隠して上限を迂回しない。

### 3.1 検索全体の通知（2026-11-06追加）

SourcePort.searchは `SourceSearch = { cards, warnings: {kind, refs}[], degraded: string[], truncated }` を返す（`sourceSearchSchema`）。旧来のEvidenceCard配列は受け付けない。コアは構造だけを検査する: schema違反、external=falseのカード、返却カードにないrefを指すwarningは推論前に `source_contract_violation` で拒否する。kind・degradedは64字以内の識別子（`[a-z0-9_.:-]`）に限り、自由文を推論入力へ流さない。

推論入力の `search.external` には、候補に残ったカードだけを指すwarnings、候補外を指したwarningの件数 `omittedWarnings`、degraded、truncatedをそのまま渡す。通知の意味（競合が必須条件に関わるか、縮退で不足が生じるか）はコードで判定せずLLMが判断する。当時の履歴ラベルは `build.v2`（失効済み）。現行版は指示本文と意味検証指示のdigest由来のINSTRUCTION_VERSIONを使う。

ホスト側の未確定事項: 実ContextStillのsearch_knowledgeが返すwarningsの実schemaとkindの語彙、degradedの語彙は未照合（疑似APIは `{kind:"unresolved_conflict", handles}` と `mock_lexical_only` 等）。実adapterはhandle→refの変換と語彙の検査を製品接続前に確定する。

### 3.1b 再検索の外部query境界（2026-11-06追加）

モデルが返す `kind=re_search` の `query` はローカル RegistryPort.search にだけ渡す。SourcePort.search へ渡す外部queryは、初回と同様に TrustedContext.searchTask のみとする。モデルquery・task.goal・constraints・記憶・未信頼本文を外部へ流用しない。searchTask が無い／SourcePort が無い場合は外部再検索を行わず、ローカル再検索だけを実施し、`search.reSearch[].externalQuery` は null とする。keyword による PII 検出はこの境界の代用にしない。

### 3.1a 撤回済み資料の後継（2026-11-06追加）

EvidenceCard／Evidenceは任意の `supersededBy`（同じ取得元のref）を持てる。コアは取得したsupersededの文書に後継があれば、同じ取得元から documents上限とsourceCalls予算の内で取得する。結果は推論入力の `search.successors` に `{ref, successor, outcome}` として渡す。outcomeは fetched／unavailable（取得失敗・ref不一致・scope外）／cycle／limit。予算超過・中断・コアの拒否は従来どおりビルド失敗とする。後継が今回の目的に合うか、不足を補えるかはLLMが判断する。当時の履歴版は `build.v3`（失効済み、現行はdigest版）。ContextStill疑似adapterは `item.supersededBy` のhandleをrefへ変換する。実ContextStillでの後継の公開性は未照合。

### 3.1c 評価キットの負例監査（2026-11-06追加）

`examples/contextstill/eval-kit.ts` は比較の前に `auditEvalSuite` を行う。同一 task の A/B/C 条件欠け・重複、`--require-records` 時の空 record、および companion の `*.expected-digests.json` と一致しない `inputDigest` 改竄は失敗とする。補助指標の token overlap は `lexicalOverlap`（字面一致）と呼び、意味的 faithfulness とは扱わない。評価結果 JSON と推論 record は別物であり、CLI の整形出力を品質スコアとしない。

### 3.1d 使用量台帳（2026-11-06追加）

Request の `usage` は modelCalls／sourceCalls に加え、観測済みの inputTokens／outputTokens、および提供元が返す場合のみの reasoningTokens／cachedInputTokens（欠測は null、0 にしない）を持つ。ビルド中は ExecutionContext.noteUsage で試行ごとの累計をコミットし、失敗で settle に至らなくても観測値を残す。評価用の per-call 台帳は `src/eval/usage-ledger.ts` に置き、reasoning が output に内包される場合は二重加算しない。token 数を金額へ換算するゲートは設けない。

### 3.1e workflow の snapshot 保存（2026-11-06追加）

製品の workflow 誘導は reflection と同様に `prepareWorkflow`（同期）→ `induceWorkflow`（transaction 外の推論）→ `saveWorkflow`（同期・再照合）に分ける。推論中に authority 失効・report 訂正・根拠失効があれば保存しない。観測付き trajectories／failedSummaries は任意入力であり、品質優位は未測定のまま候補を proposed に留める。

### 3.1f 候補検証と元build成功の分離（2026-11-06追加）

`executionVerified` は元buildの succeeded 報告由来であり、候補本文の実行証明ではない。報告が succeeded 以外へ訂正されるとクリアする。候補本文 digest・report revision に束縛する `candidateVerification` は別証跡で、本文変更や report 訂正で invalidated になる。boolean 印だけで検索優先度を上げず、自動 promotion もしない。

### 3.1g 再検索の作業集合入替（2026-11-06追加）

`re_search` では新規カードを候補枠の先頭へ入れ、文書枠が満杯なら prior-only の本文を追い出して新規本文を取得できる。`cardsAdded`／`cardsAdmitted`／`documentsFetched` を分離記録する。残した資料の初回 warnings／degraded は `sourceNotices` として蓄積し、最新 round の空応答で消さない。無制限 top-k 拡張はしない。

### 3.1h cache 内容同一性（2026-11-06追加）

ビルド cache key の内容同一性から `deadlineAt` を除く（実行上の期限は受付時に別検査）。Build は `generator.instructions`（INSTRUCTION_VERSION）と contractVersion を保持し、`usable` が現行と不一致なら ready を返さない。指示 digest 自体は外さない。

### 3.2 推論providerの注入

本ワークフローのlive推論providerは親チャットのGrok Botである。コアはInferencePortだけに依存し、LLM clientを持たない。`examples/contextstill/recorded.ts` は、意味入力IDと実行条件ID（token cap・provider/model/generation設定）を分けたexecution.v2課題を書き出す。providerが返した構造化出力はその名前空間付きdigestに一致する場合だけ再生する。旧 `{system,data,schema}` digest は明示legacy専用。記録がない・入力が異なる場合は `inference_record_missing` で失敗する。`bun run context:task [db] [query] [records.json]` は課題を `data/contextstill/inference-task.json`（Git対象外）へ出力する。fixed_wiring_stubと試験用の記録は接続確認であり、意味品質の評価ではない。

完成後のgetValidatedは読み取り用の短い期限で外部の参照版を再検査し、生成を再開しない。現行metered配布にはExecutionContextが必要で、reserveDeliveryが元requestの残sourceCallsへ各getを予約する。頻度制限・本体の追加計量は本体接続側で強制する。コア単体の試験でその本体側計量まで実証したとはしない。

## 4. 保存形式と未実装の有効化条件

追加migrationはknowledge/0001-init。要求、ビルド、依存、失効、利用先、配達、結果、報告receipt、振り返り予約、候補を保存する。適用済みのmigrationを変更せず、本体へ取り込んだ後の変更は新migrationにする。

現在のコアは通常の同条件キャッシュを再利用する。管理者が検証した適用関係の永続的な登録とパラメータ契約、正式Skillのscope・公開・切戻し・消去はP6で接続する。保持期限の保守・job終端との照合・本体の忘却journal再適用はP4で接続する。これらの管理契約が未検証の間、正式公開を有効にしない。

MCPの認可、Claude Code／Codex SDKの対象版と本文読込、実接続受入はP7／P8で確認する。開発会話のMCPが利用できることを、製品接続の成立とは扱わない。強い外部即時失効は現在のsnapshot保証とは別の依存として残す。

## Final SKILL.md contract — current (2026-11-07 review)

Current builds use meaningful model-generated name/title/description/language and instructions-only Markdown. The host assembles canonical body once from structured data; acceptance, constraints, checks, assumptions and provisional status never depend on free-text inclusion. Optional localizedHost values preserve every host ID and keep originals auditable. Only the instruction section is Markdown-capable; host text and provenance are escaped plain text.

`getSkillValidated` rechecks authorization and external dependencies, validates the canonical body, and returns `{name,path,content,digest,rendererVersion,sourceExtractorVersion}` beside the internal Build. Byte limits remain unchanged. Non-ready outcomes emit no artifact. `sourceMarkdown` applies only to explicit legacy reuse; extraction failures are coded, not raw exceptions.

Historical note (superseded 2026-11-07): the first renderer used goal slugs and decoded policy/main/bodyTail from persisted JSON. Those are retained only in the explicit legacy assembly/rendering modules for archival regression replay. They are not current naming rules, instruction format, judge identity or quality claims. Historical build.v2/v3 labels are replaced by digest-based INSTRUCTION_VERSION. The format contract is pinned in docs/skill-format.md; format validity does not establish semantic or execution success.

## Localized build artifacts (2026-11-07)

The builder, not the deterministic renderer, owns a concise meaningful `name`
(ASCII kebab-case, at most 64 characters), a short human `title`, a useful
`description` (what + when, without copied source titles), `language` (the request
language tag), and `localizedInstructions`. The latter contains only faithful instructions in the request language. Host-owned conditions, verification, assumptions and provisional status are rendered separately; optional localizedHost entries supply checked per-ID translations with originals. Reuse faithfully
restates the disclosed source body, not its transport envelope; original evidence
and handles remain provenance, never instruction authority. Sections/patches and
strategy/source-completeness/capability checks retain their existing meaning.
The original host policy is retained verbatim when not already present.

Current terminal ready turns require all five fields. Stored legacy decisions may
omit all five, enabling deterministic historical rendering only; partial metadata
is invalid. Language validation checks structural field presence, not keywords or
semantic language guesses. Faithfulness and language quality remain model/judge
responsibilities, not a claimed deterministic guarantee. New rendering uses the
model title, description, and Markdown; source titles occur only in the appended
`出典` provenance block. No new goal-slug/hash defaults on current builds.

The build instruction digest changes. The initial disclosure instruction/schema constants remain archived, but current metadata trust markings and execution.v2 replay identities change the actual input. Only explicit legacy runs preserve archived full payload digests. A terminal answer on this legacy
initial turn is not accepted as a current ready build: the next budgeted turn
uses current instructions/schema (without copying the old answer into model
context). After a successful disclose, all subsequent turns use current fields.
Legacy-shaped terminal needs_input/unavailable answers remain valid. Current ready builds additionally require a budgeted semantic review, and auxiliary search inference shares the same limits. Existing model-call and byte/token limits are not raised; exhaustion fails closed.

Re-recording uses only InferencePort/recorded-inference, with missing tasks and
builder-only packets under /tmp/p-rebuild. No executor-written builder or judge
values. All current builds must be rejudged; no historical score is relabeled as
current. Gold labels remain judge/host-only. Historical snapshots are evidence of
the prior instruction version, not current complete evaluations.


Historical regression replay uses an explicit `legacy` assembly profile, carrying
the archived instruction/schema/digest. It is never the default or a fallback for
failed current generation. This keeps old complete/score/auth/limit regression
assertions intact without inventing replacement model outputs. `compact` current
turns also require localized presentation fields; its digest changes separately.
The source-only provenance heading is intentionally the requested `出典`; no
source title is added to generated descriptions. Host policy is not translated
by the renderer or demoted to untrusted model text.


Current judges receive final artifacts and judge-only reference bodies in an untrusted data envelope; retrieval fidelity dimensions are separate from name selection. Judge instruction/schema digests and artifact bindings are versioned. Explicit archival runs retain their original judge body and legacy replay digests. Gold remains judge/host-only. Human calibration, independent-provider evaluation and downstream execution gains remain unmeasured.

## Review H1 — host-owned invariants (2026-11-07)
Current artifacts always render acceptance, constraints, verification, assumptions and provisional status outside model-authored instructions. Optional localizedHost entries cover every stable host ID exactly once; originals remain in Build and in the artifact for audit. A separate semantic review via InferencePort must confirm meaning preservation, source fidelity and non-contradiction, within the existing shared model/input/output budget. Unreservable or invalid review fails closed. Legacy archival replay is isolated and is not current validation. Semantic review is not human calibration or execution authorization.

## Review H2 — reference data boundary (2026-11-07)
Source titles and refs render as single-line escaped plain text, never Markdown/HTML structure. Source notices and all candidate/index metadata are explicitly marked untrusted. The host always labels sources as reference data, not authority or execution evidence.

## Review H3 — model Markdown grammar (2026-11-07)
Current model instructions are parsed with a pinned CommonMark AST parser. No H1, reserved host heading at any depth, raw HTML, thematic-break/frontmatter blocks, unsafe URL schemes or unclosed fenced code is allowed. Titles must be a single line. Failures have structural codes; this is not a word-based semantic detector. The budgeted semantic gate remains necessary, and execution-side approval remains external.

## Review H4 — disclosure coverage (2026-11-07)
Current reuse/adapt require the selected current body and every source section to have been disclosed to the builder. Current section disclosure includes the source body; partial section access is insufficient for whole-source reuse/adapt. Coverage compares actual bytes, not merely ref presence. Legacy archival replay preserves its old transport shape and is not a current success.

## Review M1 — historical vs current scores (2026-11-07)
Historical snapshots retain their exact identities and numbers. Current scores require a complete match of suite and seed bytes, all instruction/schema identities, renderer version, profile, assembly, evidence and reformulation conditions. Missing identity is stale, never current. Score snapshots reject duplicate/missing task IDs and non-integer/out-of-range scores. Historical files are not rewritten.

## Review M2 — judge-only fidelity evidence (2026-11-07)
Current retrieval judges receive full reference bodies/sections only after builder completion, plus the final artifact rather than internal JSON. Generated artifacts, search metadata and source material are enclosed as untrusted judge data. Retrieval name selection, constraint preservation, source fidelity and execution evidence are separately recorded; executionOutcome is unmeasured without an actual execution. Archival judge inputs remain explicitly legacy. Independent-provider evaluation, human calibration, multi-run variance and actual worker improvement remain unmeasured; no provider values are fabricated.

## Review M3 — physical adapter budget accounting (2026-11-07)
SourcePort may declare meteredCalls and accept a shared ExecutionContext. Such adapters reserve every physical search/get before I/O, including validate's per-ref gets; wrappers propagate the same context and reserve auxiliary inference as modelCalls. Per-call observations remain separate from cumulative provider usage. Current full runs capture core search results instead of doing an unbudgeted preview. Auxiliary queries are memoized only within a source/run by public searchTask and instruction digest; rejected promises are not cached. Legacy snapshots preserve old inputs. No budget limits are raised; public searchTask noninterference (proposal 18) is unchanged.
Current metered delivery also requires an ExecutionContext. reserveDelivery commits each revalidation get against the original request sourceCalls limit after completion (generation deadline is not reapplied). Missing context fails closed. Retrieval-only and explicit legacy paths are offline diagnostics, not billable-budget claims.

## Review M4 — unknown reasoning billing totals (2026-11-07)
If any separately billed reasoning count is unknown, billableOutputTokens is null even when output is known. observedBillableOutputTokens reports only the sum of observed output and observed separate reasoning (a lower bound, never a complete total). Included reasoning is never counted twice. Build reasoning/cache totals remain observed-only, not claims of complete provider usage.

## Review M5 — semantic vs execution replay IDs (2026-11-07)
Default replay uses execution.v2: semanticInputId hashes system/data/schema and host replay context; executionConditionId hashes token cap and explicit provider/model/generation settings (unknown values stay null). inputDigest binds both IDs in a versioned namespace. Deadline/requestRef are intentionally excluded as transient routing. Changing cap/settings cannot reuse a current answer. Old digest semantics are available only via explicit legacy namespace (legacy assembly selects it); current runs never silently fall back. Unknown provider model/settings are not proof of independent or identical live execution.

## Review M6 — artifact byte identity (2026-11-07)
SkillArtifact carries SHA-256 of exact UTF-8 content, rendererVersion and sourceExtractorVersion. Current per-task artifact digests are bound into RunIdentity, judge data/provenance and score rows. A renderer/extractor or byte change creates a new artifact, never inherited score success. Current scoreboards require matching artifact bindings across ready score rows, run identity and judge provenance; historical rows without them stay stale. File writers check artifact integrity. Authorization/source validation still occurs on each delivery.

## Review L1 — indexed title equality (2026-11-07)
Snapshot/seed writers persist normalized title_key (NFKC, ECMAScript trim, ASCII case fold) and a (title_key,handle) index. Pin queries bind the key and visibility filters in SQL with LIMIT before reading document_json. Old snapshots without the normalized column/index must be rebuilt offline; no read-time full scan or silent write migration is used.

## Review L2 — pinned frontmatter format (2026-11-07)
The supported frontmatter contract is pinned to the Agent Skills specification snapshot retrieved 2026-11-07 from https://agentskills.io/specification (no numeric upstream version is published). See docs/skill-format.md for the exact supported contract. All six supported fields are type-checked, including string-only metadata values and compatibility length. validateSkillMarkdownFormat is explicitly structural format validation, not a safety/semantic/execution verdict; the compatibility alias validateSkillMarkdown remains available.

## Review L3 — one pure document assembly (2026-11-07)
Current Build.content.body is the host-assembled canonical Markdown body produced by assembleSkillBody, not a second model body plus a legacy tail. Rendering checks canonical equality then adds frontmatter; no independently maintained host-tail representation exists on the current path. Legacy execution-body construction/extraction lives in legacy-content.ts and is selected only by complete absence of presentation fields. All host typed text is rendered as plain text; only instructions may contain model Markdown. Extractor exceptions/empty output become coded final unavailable replies. Earlier sections explicitly marked historical are not current contracts.

H2 final boundary audit: freshness entries and the entire current search/successor subtree are also explicitly marked untrusted, not just candidate/index titles and external notices. Archival shapes remain unchanged.

M3 final accounting audit: disclosureProgress.modelCallsUsed includes committed auxiliary reservations and the about-to-be-reserved builder call, so the builder sees the actual remaining shared allowance. Model-call audit rows retain the provider's per-call receipt and nullable token fields; cumulative build usage merges observed auxiliary reasoning/cache counts without inventing omitted values.

L3 delivery isolation audit: current execution requires a positive matching generator instruction stamp and complete current presentation; unversioned or legacy-shaped stored builds are usable only in the explicit archival profile, never through the current final delivery API.


## 品質改善 v5（実装前設計）

1. 出典は正しさの保証ではない。現行 build は sourceReview（assessment と flaggedItems）を必須とし、LLM が API・手順・版条件を点検する。疑義は削除または「要確認」とし、host は flaggedItems の claim/reason/disposition を必ず描画する。意味検証は既存の予約済み呼出しを拡張し、新規呼出しや予算拡大はしない。点検不能は成功にしない。reuse は原文の誤りを正しいと断言する義務ではない。
2. 厳格採点 v2 は correctness/actionability/essentialCoverage を独立に 0–10 で測る。incorrectSteps に実行可能な誤りを列挙し、1 件以上なら総合点は最大 5。出典忠実性とは独立であり、実行結果は記録がなければ未測定。過去版の記録は再利用しない。
3. canonical acceptance/constraints/assumptions は保存を維持。入力の visibility は reader（既定）/environment/evaluation。reader の制約・受入条件と verification は必ず host が描画するが内部 ID は非表示。environment/evaluation は body から外し、build.content の canonical metadata に残す。visibility は caller が明示し、LLM は要求条件を降格できない。モデル由来の assumptions は visibility を付けられるが意味検証で課題上の必須条件の隠蔽を拒否する。モックの readonly は host が environment と指定。本文・手順にも評価事情を転載しない。キーワード削除は行わない。
4. compose は interactions（point/handling）を最低 1 件返す。構造検査は存在のみ、相互作用の妥当性と手順への反映は LLM の意味検証で判断し、無理な衝突を作らない。host がプレーンテキストで描画する。
5. provisional は domainAnchors（term/documentPointer）を最低 1 件返す。host は「未確認の手がかり」として描画。分野固有の探索語・公式文書の探し方であり、URLや確認済みの手順を捏造しない。根拠不足は世界的不存在としない。
6. 再評価は builder-only packets を先に生成し、build 答案確定後に別工程で judge packet を開く。同じ Grok Bot による作成・採点であり独立したモデル・人手評価ではない。gold を見る前に builder 記録を固定し、6 件の個別点と残欠陥を報告する。

旧保存形式は読めるが現行 terminal schema は品質欄を必須とする。H1–H4、complete、auth、入出力上限、既存の予算と fail-closed は維持する。

### v5 再評価時の文書取得条件

8 文書を先行取得すると、12 回の Source 共有予算内でも意味検証後の再配布時の検証が予約できず成果物が配布されない例があった。予算や再検証は緩めない。評価 CLI に --documents（1–8、既定8）を設け、文書取得数を減らす条件を明記して再試行できるようにする。旧条件の配布失敗を成功や採点済みと扱わない。答案そのものは採点用データを読む前の記録を固定し、条件変更後にも同一の答案を使ったことを digest で監査する。同じモデルが再試行するため独立盲検とは表現しない。


## 機能に集中した SKILL 出力 v6（実装前契約・v5の表示仕様を更新）

最終 SKILL.md は name/description の frontmatter、題名、手順、確認だけとする。出典・前提・受入条件・制約・要確認の出典記述・組合せの接点・未確認の手がかりの独立節、出典の題名/ID/方針説明、空の前提注記を本文に出さない。provisional の短い「暫定・未検証」と停止条件は手順内に置く。必要な注意、compose の接点、未確認の分野手がかりは LLM が手順へ統合する。意味判断や一般知識の正しさは辞書ではなく既存の予算付き意味検証で判定する。

H1 の表示契約は、課題に関係する canonical reader 制約と verification を host が確認欄へ必ず描画することへ更新する。課題に関わる適用条件も空でない確認項目として保つ。評価/環境専用の条件は記録に残す。受入条件そのものは本文の定型句にせず、意味検証が手順・確認の目的充足と非矛盾を照合する。canonical task、policy、dependencies、sourceRefs、sourceReview、flaggedItems、assumptions、interactions、domainAnchors は Build.content / 推論記録の監査データとしてそのまま保持し、本文から落としたことを情報喪失とはしない。H2–H4、complete/auth/予算/入出力上限は変更しない。

reuse は原則だけの出典に縛られて抽象論で止まらず、LLM が正しいと判断できる一般的な具体策を通常の手順として補ってよい。追加は nonSourceAdditions（practice/reason）に記録して、出典由来と区別する。新規 terminal schema ではこの配列を必須（追加なしは空）とし、旧保存形式は読める。疑わしい事項は断言せず短い注意として手順へ統合し、flaggedItems は監査専用。既存の意味検証は一般知識追加の妥当性、注意の保持、接点と分野手がかりの統合、canonical 制約との非矛盾を点検し、不明なら拒否する。新規の LLM 呼出しは増やさない。

renderer は skill-markdown.v6。参照IDが本文に残る場合は黙って削除せず構造違反として拒否する。quality-judge.v2 の採点軸と誤手順時最大5点は維持し、出典/監査節を表示しないことや一般知識の補足自体を減点しないよう明記して採点指示digestを更新する。実行結果は依然未測定。旧スコアは現行版へ流用しない。

評価器は本文とは別に skillAuditMetadata（canonical task/policy/dependencies/decision）を judge-only の未信頼データへ渡す。一般知識の追加や非表示条件を採点役が監査できるようにし、本文に出典節を復活させない。本文digestと監査metadata digestを別々に記録する。


## v7: System Estimation 型の機能別文書・段階的開示

作成LLMが依頼言語と題材から、目的・モード（必要時のみ）・必須原則・情報/ツール安全性・標準ワークフロー・完成条件・リソースの機能を選択する。ホストは語彙で題材/節の要否を分類しない。現在の terminal ready は document を要求する。document.sections は kind と依頼言語の heading/body の組であり workflow/completion は各1件必須、その他は任意・重複不可。localizedInstructions は workflow の本文として保持し、二重の手順を持たない。completion 本文に加え従来の reader 制約・必須の適用条件・verification をホストが決定的に描画する。出典・provenance・前提・受入条件の監査節を本文へ復活させない。canonical task/decision/依存資料と H1–H4 の監査記録を保持する。意味検証が欠落、矛盾、翻訳の意味、節の適否、追加実践を判定し、判定不能/失敗時は fail closed。既存の予約済み呼出しだけを使用し、予算・complete checks・認可は変更しない。

長い詳細は document.references の references/<安全な単一basename>.md に分離する。最大8ファイル、各本文上限は既存 text 上限、全体は既存 outputBytes/inputBytes に含む。パスはASCII lowercase kebab-caseの .md のみ（相対トラバーサル、絶対パス、重複、予約ファイル拒否）。スクリプト実行・任意ファイル書込は提供しない。リソース節の見出しはLLMが付け、ホストが既知ファイルだけの相対リンクを描画。各追加ファイルは digest で束縛し、完全性検査・意味検証・採点入力には本文と別ファイルをともに渡す。再配布/complete checksは文書全体に継続適用する。

SkillArtifact は既存 content/path/digest と返却種別を維持し、任意の files 配列を追加する。files は成果物rootからの相対path/content/digest。既存SKILL digest は従来通り当該文字列だけのdigestで、追加ファイルを偽って包含しない。保存側は全ファイルのパス・一意性・digestを検査してから書く。artifact metadata は document/references を含むcanonical decisionを保持する。古い記録の document 欠落は旧形式として読めるが、新規terminalには必須。名称は依頼言語の内容名（Unicode小文字/非大文字文字/数字と区切りハイフン、64文字以下）を許可し、パス区切り/ドット/制御文字を禁止する。ASCII名も引き続き許可し、言語の意味判断はLLMのみ。

回帰試験は最終文字列の任意節の有無、旧監査見出し不在、reader条件保持、reference同梱・リンク・digest・安全パス拒否、Unicode名、LLM意味検証への全ファイル入力を扱う。再生成は6件固定のbuilder-only packetsとrecorded-inferenceで行い、gold入力を作成者へ渡さない。既知の過去goldによる完全盲検不能は明記する。

補足: v7のbundleDigestはSKILL path/digestと全参照path/digestの順序付き集合を束縛する。保存・採点で別々に保持し、既存SKILL digestの意味を変えない。保存は全ファイル検査完了後に行い、既存symlinkを通る出力を拒否する。訳文があるreader条項は訳文だけを本文へ描画し、原文はcanonical監査へ保持する（意味保存は既存LLM検証）。


## v8 段階1: ASCII内容スラッグ
nameは英小文字・数字を単一ハイフンで繋ぐ64文字以下のスラッグだけに戻す。見出し/description/本文の依頼言語は変えない。Unicode/大文字/末尾改行/パスは生成時と配送時に拒否する。rendererはv8、既存ファイル返却/bundle/認可/完全性/予算/I/O制限は変更しない。6件について前段の総合・正確さ・具体性・網羅を個別比較し、いずれかが低下した段は採用しない。平均で劣化を隠さない。goldはbuilderに渡さず、答案とファイルを固定後だけjudge工程を開く。


## v8 段階2: 不確実性の局所化
API/コマンドの実在が確かとLLMが判断するものは通常の手順として扱う。全てを未確認の探索語へ降格しない。実在性、引数/版互換、対象構成への適合、実行済みかを区別し、不確かな引数・単位・構文だけ注記する。provisionalの全体未検証警告と停止は維持。domainAnchorsの構造/監査要件も維持し、語彙ルーティングや新規推論は追加しない。


## v8 段階3: 手順ごとの操作または判定
各番号付きworkflow手順には、実行可能なコマンド/コードか、観測量と合否・分岐が分かる判定基準を少なくとも1つ含める。未定義プレースホルダの実行や無関係なコマンドで埋めない。各手順の充足は既存の予約済み意味検証が判定する（ホストのキーワード検出なし）。詳細をreferencesに分けても主本文の着手・停止判断を失わない。


## v8 段階4: 本文と参照の整合照合・予算内修正
既存の意味検証は、主本文/referencesの対象範囲・停止/進行条件・版/経路ごとの合否を明示的に横断照合する。矛盾を検出した場合、approved=falseとcorrection（localizedInstructions/documentだけ）を返せる。ホストはtask、sourceRefs、verification、assumptions、capabilities等の変更を許可しない。修正を通常の構造/完全性/本文形式/I/O検査に再度通し、既存共有modelCalls枠を予約して再描画後の全ファイルを再検証する。修正は最大1回、再検証合格までreadyにしない。残予算が無ければ元の矛盾稿も修正稿も返さずfail closed。追加予算・source選択権・権限の拡張なし。


## v8 段階5: 最小実行例と実測記録
referencesに最低1つ、必要なimport/fixture/期待値/assert/終了条件が揃う最小実行例を含める。分野上実機が必要でもオフライン検査例と実機検証を混同しない。既存のLLM意味検証が実行可能性・対象範囲・期待値を審査する。サービス自身へ任意コード実行/ネットワーク/インストール権限を追加しない。許可された呼出側がローカル依存のある例を実行し、実行したコードと参照ファイルのSHA256、コマンド、依存版、exit/stdout/stderrをrun recordへ保存する。依存欠落/実機検証は未測定。実行結果を推測・捏造しない。今回の6件では無害なfixture/標準ライブラリ/既存pandas/Goのみ使い、外部通信と依存の自動取得は行わない。


## v8 段階6: 合否可能な完成条件
verificationとcompletion本文は観測対象・期待値/閾値・合格条件と未達時の停止を明記し、「確認する/十分/適切」だけで完了にしない。各reader制約を弱めず、実行例の合格と実タスク/実機の合格を分け、未測定を合格に数えない。条件付き経路/モードごとに異なる判定を明示し、適用範囲と矛盾させない。意味の判定は既存のLLM検証のみ。新しい呼出し/実行権限/予算は追加しない。
