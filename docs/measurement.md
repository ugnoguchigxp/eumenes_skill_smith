# 計測手順（ContextStill mock の SKILL 組み立て評価）

正式な計測の入口は次の 1 コマンドです。外部 LLM は呼ばず、記録済みの採点と検索のみの結果を集計します。

```
bun run context:scoreboard          # 表
bun run context:scoreboard -- --json  # JSON（digest や出典ファイルはこちらだけ）
```

## 区分（課題 61 件、suite-3axis）

| 区分 | n | 測るもの |
|---|---|---|
| retrieval/original | 5 | 当初の課題文で、該当 Skill を検索で引き当て、本文として使えるか |
| retrieval/exact | 16 | 題名どおりの問い合わせで、該当 Skill を検索で引き当て、本文として使えるか |
| retrieval/en | 16 | 英語言い換えでの検索的中 |
| retrieval/jp | 16 | 日本語言い換えでの検索的中 |
| compose | 4 | 複数 Skill を合わせた手順を組み立てられるか |
| absent | 4 | seed に該当が無い課題で、公式 Skill を捏造せず探索手順を出せるか |

retrieval 区分には hit@8（主）と hit@20（診断用）を出します。retrieval/original の SKILL 点は seed-skill-assembly の記録（scores.json / scores-bm25.json）を課題 ID で対応させています。

## 条件（2 列）

- handle: assembly baseline・evidence natural・言い換え off・棄権対比 off
- bm25: 検索だけ BM25、他は同じ

compact、oracle、言い換え on / multi、弃権対比は診断用で、この表には入れません。

## 製品既定（mock 例のみ）

`ContextStillFixture` と scenario-eval のフラグ省略時の既定は次のとおりです。本番 ContextStill の品質を示すものではありません。

- 検索 profile は `bm25`（`--search-profile handle` で従来の handle 順を明示指定できます）。
- 題名一致の固定: query（searchTask）と題名を NFKC 正規化・前後空白除去・ASCII だけ大文字小文字を同一視して完全一致した Skill を、同じ kind / space / type / searchable の絞り込みを通したうえで先頭に置きます（複数なら handle 順、重複なし）。あいまい一致や翻訳辞書は使いません。handle・bm25 の両 profile に効くため、現行コードの `--search-profile handle` は題名どおり課題で過去の `retrieval-exact-handle.json`（題名固定なし）を再現しません。
- 言い換え `--query-reformulation off|on|auto|multi` の既定は `auto`。searchTask にひらがな・カタカナ・漢字が含まれるとき（「APIキー」のような混在も含む）、または同じ絞り込みを通る題名と完全一致しないとき、既存の隔離言い換え（proposal 28）を通します。日本語を含まない題名完全一致は言い換えません。判定の正規化は題名固定と同じです。英語などではまず通常検索で公開カードの題名一致を調べるため、非一致時には検索が追加で 1 回発生します。補助モデルの入力は引き続き `{searchTask}` だけで、内部 goal・期待題名・期待 ref は渡しません。report の `queryReformulationMode` は指定値、`identity.queryReformulation` は実際に 1 件でも言い換えた run なら `on`、なければ `off` です。multi は従来どおり任意で既定オフです。

既定での検索のみ結果は `retrieval-{original|exact|en|jp|compose}-default.json` に置き、scoreboard の 2 列表とは別に「製品既定」として出します。SKILL 点は `scores-{exact|en|jp}-default.json` にあり、同じ欄で区分ごとに表示します（混ぜません）。当初 5 件と複合の既定 SKILL 点は未測定です。多様な言い回し 10 件は `suite-diverse.json` の別枠で、61 件には含めません。

## 点数の扱い

- SKILL 点は LLM 判定による 0〜10 の暫定値で、人手で較正していません。
- 平均は「区分 × 条件」ごとに、その区分の全課題が採点済みのときだけ出します。区分や軸をまたいだ平均は出しません。
- 品質改善を主張する資料ではありません。

## 未測定

- 製品既定での retrieval/original（5 件）と compose（4 件）の SKILL 点
- 歴史的 2 列における retrieval/exact の BM25、および retrieval/en・jp の handle / BM25 の SKILL 点
- absent の BM25 の SKILL 点
- provider の入出力トークン

## 検索結果の再生成

```
bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json \
  --axis retrieval --query-style {original|exact|en|jp} --search-profile {handle|bm25} --output-dir <dir>
```

過去の 2 列は言い換え off なので、再生成時は `--query-reformulation off` を付けます。出力を `examples/contextstill/scenarios/retrieval-{style}-{profile}.json` として置きます。製品既定はフラグなしで実行し、`retrieval-{style}-default.json` として置きます（既定は `reformulation-records-default.json` の記録を使います。既存の日本語・複合記録と、新しい英語・当初 5 件・多様プローブの記録を合わせたものです）。

## 英語言い換えの追加実験と auto 拡張

BM25 と題名固定を維持し、隔離言い換えを英語にも `on` で適用してから既定 auto の対象を拡張しました。記録は公開 searchTask のみに忠実な単一クエリを一度作成し、検索結果を見て再調整していません。英語記録は `reformulation-records-en.json`、当初 5 件は `reformulation-records-original.json` に分離して保存し、既存日本語ファイルは上書きしていません。結果は検索のみで、SKILL の生成・意味判定の改善を示しません。

| 区分 | 旧 auto hit@8 (hit@20) | 言い換え on / 新 auto hit@8 (hit@20) |
|---|---|---|
| original | 5/5 (5/5) | 5/5 (5/5) |
| exact | 16/16 (16/16) | 16/16 (16/16)、auto は全件言い換えなし |
| en | 13/16 (14/16) | 14/16 (15/16) |
| jp | 15/16 (16/16) | 15/16 (16/16) |
| compose（両方必須） | 4/4 (4/4) | 4/4 (4/4) |

exact は on ではなく auto の非発火確認です。original と compose を維持し、英語の既存 13 ヒットに脱落がなかったため拡張しました。英語の順位変化は `retrieval-4pfru3-en` が 3→1、`retrieval-2jrkfp-en` が 8→7、`retrieval-2o2vt6-en` が 13→1、`retrieval-4eev36-en` が圏外→18 です。`retrieval-4f7bhy-en` は引き続き 20 位圏外。日本語の `retrieval-4f7bhy-jp` は 16 位のままです。複合の `packed-offline-smoke` は packed artifact が 1→1、live-provider 防止が 2→3 で、両方 hit@8 を維持しました。他の課題の正解順位は不変です。検索漏れを真の不存在とは扱いません。

## 多様な言い回しの別枠プローブ

`suite-diverse.json` は口語・疑問文・日英混在・短文・自然な長文の 10 件です。意図的な seed 由来の評価プローブであり、実ユーザー課題でも無作為標本でもありません。`suite-3axis.json` と 61 件の scoreboard には追加していません。schema / query-style の許容値は変更せず、en / jp と `diverse-probe` タグを使用します。

既定の検索のみで hit@8 = 10/10、hit@20 = 10/10 でした。順位は次のとおりです。全タスクの top-8 題名は `retrieval-diverse-default.json` に保存しています。

| task | 正解 ref の順位 |
|---|---|
| diverse-23jihz-informal | 1 |
| diverse-224yjd-question | 1 |
| diverse-4pfru3-mixed | 1 |
| diverse-b2qt6s-informal | 1 |
| diverse-4f7bhy-natural | 4 |
| diverse-4eev36-natural | 1 |
| diverse-2o2vt6-mixed | 1 |
| diverse-fmgsj5-short | 1 |
| diverse-2jrkfp-informal | 1 |
| diverse-6tvplq-question | 1 |

既定での SKILL 点は 10/10、平均 9（いずれも 9）です。記録は `scores-diverse-default.json` です。題名どおり・英語・日本語の既定点は `scores-{exact|en|jp}-default.json` です。区分をまたぐ平均や本番品質の主張には使いません。ビルド指示・judge・INSTRUCTION_VERSION は変更していません。

## Review M1 — historical vs current scores (2026-11-07)
Historical snapshots retain their exact identities and numbers. Current scores require a complete match of suite and seed bytes, all instruction/schema identities, renderer version, profile, assembly, evidence and reformulation conditions. Missing identity is stale, never current. Score snapshots reject duplicate/missing task IDs and non-integer/out-of-range scores. Historical files are not rewritten.

## Review M2 — judge-only fidelity evidence (2026-11-07)
Current retrieval judges receive full reference bodies/sections only after builder completion, plus the final artifact rather than internal JSON. Generated artifacts, search metadata and source material are enclosed as untrusted judge data. Retrieval name selection, constraint preservation, source fidelity and execution evidence are separately recorded; executionOutcome is unmeasured without an actual execution. Archival judge inputs remain explicitly legacy. Independent-provider evaluation, human calibration, multi-run variance and actual worker improvement remain unmeasured; no provider values are fabricated.

## Review M5 — semantic vs execution replay IDs (2026-11-07)
Default replay uses execution.v2: semanticInputId hashes system/data/schema and host replay context; executionConditionId hashes token cap and explicit provider/model/generation settings (unknown values stay null). inputDigest binds both IDs in a versioned namespace. Deadline/requestRef are intentionally excluded as transient routing. Changing cap/settings cannot reuse a current answer. Old digest semantics are available only via explicit legacy namespace (legacy assembly selects it); current runs never silently fall back. Unknown provider model/settings are not proof of independent or identical live execution.

## Review M6 — artifact byte identity (2026-11-07)
SkillArtifact carries SHA-256 of exact UTF-8 content, rendererVersion and sourceExtractorVersion. Current per-task artifact digests are bound into RunIdentity, judge data/provenance and score rows. A renderer/extractor or byte change creates a new artifact, never inherited score success. Current scoreboards require matching artifact bindings across ready score rows, run identity and judge provenance; historical rows without them stay stale. File writers check artifact integrity. Authorization/source validation still occurs on each delivery.
