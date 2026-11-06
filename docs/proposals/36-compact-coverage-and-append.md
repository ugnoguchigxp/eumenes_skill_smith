# 検索結果から探索要否を判断し、差分追記と探索フォーマットで出力トークンを抑える

## 目的

検索カードを見た時点で、モデルが「既存 Skill で足りるか / 差分追記で足りるか / 探索が必要か」を判断します。足りる場合は本文の書き直しをせず再利用または部分追記だけを出し、探索が必要な場合は長い暫定 Skill を一から書かず、短い探索フォーマットを土台にして穴を埋めます。目的は出力トークン（reasoning を含む）を抑えることと、LLM が実際に使える SKILL を出すことの両立です。短いだけの空疎な出力は成功としません。

## 現状の問題

事実: 現行指示は「使える既存 Skill を再利用し、不足だけを補う」と書いています（`src/instructions/build.ts`）。`reuse` は本文をコピーし `sections` / `patches` を空にします。`adapt` は単一 Skill への `patches` か再構成 `sections` の一方です。`compose` / `provisional` はモデルが `sections` を書き、コードはそれを連結します。`provisional` は参照ゼロでも構造上 `ready` にできます。

事実: 検索直後に渡るのは `evidenceIndex`（題名・状態・section ID）だけです。探索が要るか、探索フォーマットを土台にするかを表す専用の出力欄はありません。提案 15 は検索不良時に `needs_input` / `unavailable` への早期落としを許しますが、短い探索 SKILL を出す経路ではありません。

推定: 使える Skill があっても `compose` / `provisional` で本文相当を書き直すと出力トークンが増えます。専用知識が無いときに長文の暫定手順を一から書く場合も同様です。未測定: 現行 5 件および 3 軸スイートでの call 別 `outputTokens` / `reasoningTokens`。提案 22 の台帳は欠測を 0 にせず集計できます。

事実: `modelCalls` 上限は 4 です。判定専用の追加 turn は予算を 1 消費します。判定が冗長なまま本文化も長いと、トークンは増えます。

## 提案

意味判断はモデル（InferencePort / recorded-inference）が行います。コードは語句で探索要否を決めず、出力の形と予算だけを検査します。

検索カード（必要なら開示後の本文）を見たモデルは、次のいずれかを選びます。

- **再利用**: 既存 Skill が目的に足りる。`reuse` のみ。sections / patches は空。題名だけで適用範囲を確定しません（例: 「Use 4-Space Indentation」は Python 限定）。
- **部分追記**: 既存 Skill を土台にし、足りない条件・手順・例外だけを `adapt` の patches、または土台本文の後へ足す短い sections として出す。開示済み本文を sections へ書き直すことは拒否します。
- **探索フォーマット**: 専用の公式 Skill が無い、または根拠が探索開始にしか使えない。長い独自 Skill を発明せず、固定の短い欄だけを埋めます。欄は対象と版の確認、公式資料の当たり方、最初の安全な観測、隔離した小実験、合格／中止条件、未解決前提です。最終作業の成功や専用コマンドの発明を検証済みとは書きません。無関係な近い候補を公式根拠として採用しません。
- **棄権**: 探索開始自体に必須の対象・権限・能力が無い。`needs_input` / `unavailable` を維持します。必須前提を外して ready 率を上げません。
- **未確定**: 題名だけでは判断できないが、当たっていそうなカードがある。先に `disclose` し、探索フォーマットへ飛びません。検索集合に無くても「世界に存在しない」とはみなしません。その場合は再検索または不足であり、不在時の探索とは分けます。

実装は小さくします。判定専用の巨大な新サービスは作りません。既存の decision schema を拡張するか、同じ loop の小さな coverage 欄（`sufficient` / `partial` / `absent` / `unclear` と `explore`）を足し、本文化は必要なときだけにします。判定 turn の `maxOutputTokens` は本文化 turn より小さくしてよいです。追加 turn の入出力と reasoning は提案 22 の台帳へ必ず計上します。1 source call や 1 model call に見せかけません。

探索フォーマットの欄は指示と schema で固定し、モデルは値だけを返します。コードがキーワードで手順を合成するのではありません。

## 検証（採用 / 不採用）

提案 26 の 3 軸 runner と提案 22 の使用量台帳で、変更前後を同じ課題で比較します。品質点は LLM judge が毎回出し、固定 fixture の点数を品質値にしません。欠測 token は 0 にしません。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

比較スライスは旧 5 件、複合 4 件、不在 4 件を基本にします。検索順位を変える提案 27 の前後では別々に測り、検索改善の効果と本提案の効果を混ぜません。

## よくなったとみなす条件

次をすべて満たすことです。

- 届いている適切な Skill については、LLM が使える指針（再利用または差分追記）が残り、誤適用や適用範囲の無視が増えない。
- 専用知識が無い課題では、確認・観測・停止条件のある探索 SKILL が出る。空の一般論や、無関係な Skill を公式根拠とする出力にならない。
- 全 call 合計の出力トークン（reasoning が output に含まれない場合はそれも加算）が、同じ課題で減る。判定 turn を足しただけで本文が同じ長さなら採用しません。
- 旧 rubric の比較スライスで、有用な SKILL が出なくなった課題が増えない。

## 悪化したとみなす条件

トークン削減のために誤った Skill を reuse すること、探索が必要なのに空の ready を出すこと、使える Skill があるのに探索テンプレートへ逃がして公式手順を捨てること、判定 turn の追加で総トークンが増えること、必須未解決前提を外すことです。

## やらないこと

語句辞書やキーワードで探索要否を決めません。費用上限のゲートは入れません。本番の ContextStill へ接続しません。未確認の Eumenes host API を作りません。思考本文を保存しません。欠測 token を推定で埋めません。提案 01/16 の実ユーザー pilot とは呼びません。

## 依拠（コード・論文）

コード: `src/instructions/build.ts`、`src/service/build.ts` の reuse / adapt / compose / provisional、`src/eval/usage-ledger.ts`。論文への新規依拠はありません。出力トークンと reasoning の測定は既存の方針に応えます。

## 依存・前提

前提: 提案 26 の測定（検索と組み立てを分け、未完了 run の平均をごまかさないこと）、提案 22 の使用量台帳。推奨: 提案 27 の検索順位改善のあと、またはそれとは独立に before/after を分けること。検索で届かない公式 Skill を「不在」と誤ると、探索フォーマットが誤採用されます。

## 実装結果

opt-in として実装（`--assembly-mode compact` / `ExampleHostOptions.assemblyMode: "compact"`）。**既定にはしない**。選択経路として残す。品質は同じ検索 profile の比較スライスで下がらなかったが、provider の出力トークン削減は未測定で、探索フォーマット経路も旧 5 件では使われていない。

- 既定 `baseline` の指示・schema・`INSTRUCTION_VERSION` はバイト一致のまま。compact は別指示（`compactBuildInstructions` / `COMPACT_INSTRUCTION_VERSION`）と `compactModelTurnSchema`（`coverage` + 任意の `exploration` 欄）。
- 意味判断はモデル側。コードは形・予算と、開示本文の丸写し拒否（構造）だけを見る。語句辞書ルーティングは入れていない。
- eval `identity` に `assemblyMode` を含め、baseline 記録と compact 記録の黙った混用を防ぐ（提案 35）。
- 旧 5 件の compact 評点（recorded-inference、旧 rubric）: handle 平均 4.2（9、9、1、1、1）、BM25 平均 8.6（9、9、9、9、7）。同じ profile の baseline と同じ。記録は `examples/contextstill/scenarios/{build,judge,scores}-records-compact.json` および `*-compact-bm25.json`（既存の `scores.json` / `scores-bm25.json` は上書きしていない）。
- handle の 3 件の検索漏れは needs_input のまま。公式 Skill が集合に無いことを世界に無いとして探索テンプレートへは流していない。BM25 では期待 Skill を開示のあと reuse（four-space-indent は coverage `partial` と Python 範囲の前提）。
- 制限: 本文だけの Skill に対する adapt の sections は本体を置き換える（部分追記にならない）。four-space-indent はそのため reuse + coverage `partial` に留めた。
- 呼び出し回数は同じ（handle は build 8 + judge 5、BM25 は build 10 + judge 5）。`usage.inputTokens` / `outputTokens` は null のまま。token 削減は未測定であり、主張しない。
- 決定 JSON の UTF-8 バイト数（トークンではない）: handle 2476 → 2797（主に needs_input の説明文）、BM25 4141 → 3938（reuse 本文の書き方の差が大きく、削減機構の効果とは言えない）。
- 複合 4 件・真の不在 4 件での探索 SKILL 品質と実測 token は、このスライスでは未測定。
