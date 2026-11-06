# mock 検索の handle 順と lexical BM25 を選択して比較する

## 目的

提案26の同じ suite 上で、既存知識の検索到達を順位だけの変更で改善できるか測ります。任意 profile の測定基盤を追加し、SKILL 出力品質としての採用は親による full 実行 + LLM judge の評価後に判断します。検索到達だけを理由に既定検索を切り替えません。

## 現状の問題

一致集合が大きい場合、handle 順では期待知識が数百位以降になります。候補数を少し増やすだけでは届きません。一方、BM25 は語の意味や日本語の言い換えを理解する検索ではなく、退行も起こります。

## 提案

- `ContextStillFixture(path, searchProfile = "handle")`。`handle` は従来の handle 順、`bm25` は FTS5 既定 `bm25(items_fts)` 昇順、同点は handle 順。
- FTS に一致せず2文字部分一致だけで入った候補は FTS 一致候補の後に handle 順で置く。長い token が無い場合は全体が handle 順になる。
- token 化（日本語 Segmenter、NFKC、wordLike、2文字以上、従来どおり先頭24 token を取ってから重複除去）、3文字以上の FTS OR、2文字の title/search_text 部分一致 OR、active/searchable/global/space/type 等の絞り込みは変えない。
- `scenario-eval.ts` の `--search-profile handle|bm25` を、retrieval-only / full が共通で使う fixture に渡す。省略は `handle`。報告に `searchProfile` を入れる。
- BM25 full は既定の旧 `scores.json` を上書きしない。profile 間の報告保存には別々の `--output-dir` を使う。推論記録の不足時は既存どおり pending、採点は補完しない。

## 検証（採用 / 不採用）

`bun run verify`、提案26 baseline の再現、同一seed・suiteで BM25 の既知検索値を再現、旧 suite + 既存記録の既定 full 再生が平均4.2のまま、profile parse / 省略時 handle / 小fixtureで順序と一致集合 / CLI報告の profile を試験します。BM25 の係数や token 化を数字に合わせて調整しません。

## よくなったとみなす条件

英語 lexical 検索の到達率を改善し、baseline 再生を保ったまま比較できることは測定機構の採用条件です。製品の SKILL 出力として採用するには、実際の本文がLLMに役立つことを新しい full 実行 + LLM judge で別途確認する必要があります。

## 悪化したとみなす条件

baseline が変わる、一致集合や token 化が変わる、既存記録が再生できない場合は戻します。日本語を含む検索退行は隠さず、full 評価で誤適用や使えない本文が増えるなら既定化しません。

## やらないこと

既定検索のBM25化、提案28–36（35の残り含む）、LLM query 改革、title boost、辞書、埋込み、意味router、token予算変更、LLM評点・根拠の作成や移植。本番 ContextStill の検索改善を主張しません。提案01/16の実ユーザーpilotではありません。

## 依拠（コード）

`examples/contextstill/database.ts`、`scenario-eval.ts`、`scenario-runner.ts`、`test/search-profile.test.ts`、既存の `scenarios/suite.json` / `suite-3axis.json`。公開seedに基づく作為的なシナリオであり、代表性や未使用holdoutでの汎化は未検証です。

## 実装結果

- **採否**: 任意の比較 profile としての実装は採用。旧5件の SKILL 出力では BM25 が役立つ指針を出せた（平均 4.2 → 8.6）。**既定検索は handle のまま**（日本語の退行があるため切り替えない）。本番 ContextStill の検索改善は主張しない。`suite-3axis.json` の full + LLM judge は未実施。
- **retrieval-only**: 推論0、limit20、主指標@8。既知値とすべて一致。

| 旧5件 | handle rank@8 | BM25 rank@8 |
| --- | --- | --- |
| commit-no-secrets | 6 | 1 |
| test-production-clone | 1 | 1 |
| no-secrets-in-logs | null | 1 |
| no-hook-bypass | null | 1 |
| four-space-indent | null | 1 |

handle の全順位診断は順に6、1、371、736、968。`Use 4-Space Indentation` の本文は **Python限定** であり、言語未指定の旧goalで取得できても自動的に意味的正解とはなりません。

| 48 probe / compose | handle hit@8 | BM25 hit@8 | handle @20（診断） | BM25 @20（診断） |
| --- | --- | --- | --- | --- |
| exact | 2/16 | 16/16 | 4/16 | 16/16 |
| en | 3/16 | 13/16 | 3/16 | 14/16 |
| jp | 1/16 | 2/16 | 2/16 | 4/16 |
| compose（両根拠同時） | 0/4 | 4/4 | 0/4 | 4/4 |

compose の BM25 根拠順位は secure-commit-and-logs=[2,1]、fix-check-and-no-force=[2,1]、packed-offline-smoke=[1,2]、python-style=[2,1]。absent4件のrecallは両profileとも N/A です。探索SKILLの品質は未評価です。

**既知の退行（全順位診断。MCPのlimit20を超える値は通常報告ではnull）**:

| query / 期待知識 | handle | BM25 |
| --- | --- | --- |
| 「APIキーや環境設定ファイルをコミットに含めないようにする。」 / Never commit secrets… | 8 | 1134 |
| “When porting code to Go, rewrite it in the language native style.” / Prefer Idiomatic Go… | 392 | 2715 |

fixtureを直接読み取り、診断用にlimitを広げて確認しました（公開MCP capは20のまま）。上記2 queryの一致件数は両profileでそれぞれ6053、5533と同一です。

**結論（検索到達）**: 英語 lexical 検索の到達は改善、日本語はほぼ改善せず退行あり。旧 suite の既定 full 再生は5/5 scored・平均4.2を再現しました（handle profile、新規推論評価ではない）。

**SKILL 出力（旧5件 suite、`--search-profile bm25` の full + recorded LLM judge）**:

| 課題 | handle 評点 | BM25 評点 | BM25 の組み立て |
| --- | --- | --- | --- |
| commit-no-secrets | 9 | 9 | reuse、rank 1 |
| test-production-clone | 9 | 9 | reuse、rank 1 |
| no-secrets-in-logs | 1（needs_input） | 9 | reuse、rank 1 |
| no-hook-bypass | 1（needs_input） | 9 | reuse、rank 1 |
| four-space-indent | 1（needs_input） | 7 | reuse、rank 1。本文は Python 向けで、言語未指定の前提を残した |
| 平均 | 4.2 | 8.6 | |

記録は `examples/contextstill/scenarios/build-records-bm25.json`、`judge-records-bm25.json`、`scores-bm25.json`。既定の `scores.json` は handle の平均4.2のまま上書きしていません。4件は期待Skillの本文が目的に沿い、フィクスチャの JSON 包みをそのまま出すため 9（10ではない）。`four-space-indent` は期待Skillを使っているが、本文が「Indent Python code with 4 spaces…」であり「このリポジトリ」の言語が無いため 7。題名一致だけで任意言語へ4スペースを課していません。

`suite-3axis.json` の full + LLM judge（compose・日本語言い換え・欠落時の探索SKILL）は未実施です。日本語退行を隠さず、既定を BM25 に切り替えません。

**verify**: `PATH=/home/box/.bun/bin:$PATH bun run verify` 成功。core 141件、examples 31件、typecheck / lint / format / build / pack 成功。旧 `scores.json` は既存記録の再生結果に `searchProfile: handle` を付け、formatterに合わせたものです。評点・根拠は変更していません。
