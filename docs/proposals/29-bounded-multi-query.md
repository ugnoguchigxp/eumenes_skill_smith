# 上限つき複数 query と複合 subgoal の根拠回収

## 目的

1 本の書き換え query では届かない複合の根拠や、近傍に埋もれる単一根拠を、公開 `searchTask` だけを入力とする隔離した補助推論で、上限つきの複数 query に分けて回収する。提案 28 の単一 query を拡張する。提案 18 の境界は維持する。

## 現状の問題

事実: 提案 27 の BM25 だけで複合 4 件は allRequiredHit@8 が 4/4 になる。提案 28 の単一書き換えと BM25 では日本語 16 件の hit@8 が 2/16 から 15/16 になった。残り 1 件 `retrieval-4f7bhy-jp` は期待「Validate Hook Changes End-to-End」が 16 位で、上位はフック検証の近傍 Skill だった。

事実: handle 順では複合の同時到達は 0/4、日本語 hit@8 は提案 28 後も 2/16 に留まる。

未測定: 複数 query を足したときの複合 4 件と日本語残差、false-friend 使用、補助推論の増加。単一 BM25 / 単一書き換えに対して組み立て品質が上がるかは未測定。

## 提案

提案 28 の公開 query planner が、searchTask だけを見て複数の subgoal query を LLM で作る。例の数に依存する keyword 分岐は作らない。SourcePort 実装の bounded 探索で最大 2–3 query（提案値）、同一 version ref は dedupe する。融合は機械的（例: RRF）か、別の LLM 選択かを比較してよいが、最初は機械的 fusion と上限 2 本から始める。

既存 19 の入替と警告保持を使い、query 別の発見 → 候補 → 文書 → 開示 → 採用の trace を残す。core 契約の変更が必要なら fixture 検証後に別途設計する。`turn.query` を外部へ直結しない。生のモデル query を trusted として昇格しない。内部 task / constraints / memory は補助モデルへ渡さない。

既定は off。提案 28 の単一 query 経路を壊さない（複数 query は別の opt-in）。補助推論は提案 22 の台帳へ別計上する。欠測 token は 0 にしない。

## 検証（採用 / 不採用）

複合 4 件と、一方だけ必要な対照、および提案 28 で残った日本語 1 件を、同じ検索 profile の単一 query（28）および書き換えなしと比較する。allRequiredHit@8、false-friend、呼び出し回数とバイトを対で見る。

単一 BM25、または単一書き換え + BM25 に対して同時到達も組み立て品質も増えないなら、複数 query は不採用。新旧の警告と version を保ち、上限内で終わることを構造負例でも確認する。内包した全 query と補助推論を ledger へ記録する。内部情報の流出があれば不採用。

## よくなったとみなす条件

- 提案 18 を維持し、補助入力は searchTask だけである。
- 単一 query では届かない複合根拠または残差 1 件の到達が増える。
- false-friend の採用と誤意図 query が増えない。
- 上限（2–3）を超えず、全補助呼び出しが計上される。

## 悪化したとみなす条件

内部情報の流出、`turn.query` の外部直結、query 上限なし、単一経路の破壊、到達が増えず補助推論だけ増えること、警告や version の消失。

## やらないこと

語句辞書で subgoal を分岐しない。費用上限のゲートは入れない。本番 ContextStill へ接続しない。未確認の Eumenes host API を作らない。提案 18 を戻さない。提案 28 の単一経路を既定から外して複数だけにする変更は、単一より良いと測れるまでしない。提案 01/16 の実ユーザー pilot とは呼ばない。

## 依拠

提案 18、19、22、27、28。論文への新規依拠はない。

## 依存・前提

提案 28 が前提。検索順位の効果（27）と単一書き換え（28）と複数 query（29）は混ぜて採点しない。

## 実装結果

**opt-in のみ実装。採用判断は PENDING（親の recorded-inference と単一 query との対比較待ち）。既定は off のまま。**

- 選択: `scenario-eval.ts --query-reformulation multi`。省略 / `off` は従来の検索、`on` は提案 28 の単一 query のまま。未知値はエラー。multi の記録は `--reformulation-records`（既定 `data/contextstill/multi-query-records.json`）で指定し、28 の既存記録を変更しない。
- 実装: example の sibling wrapper `multi-query.ts`。固定 instructions / JSON schema と `data: { searchTask }` だけを補助 InferencePort に渡す。1–2 本、各 200 文字までを schema と runtime の両方で検証し、上限超過を黙って切り捨てず拒否する。語句 / 辞書 / 例数による意味分岐はない。
- fusion: 各 query を同じ内側の fixture search に送り、同一 ref + version の重複を除いて RRF（k=60、同順位は発見順）で機械融合。最終 limit を守り、元の warning / degraded / truncated を保持する。別 version は潰さない。warning の全保持と最終 limit が両立せず参照先が返却集合から落ちる場合、または notice の schema 上限を超す場合は fail closed（`multi_query_fusion_contract_violation`）。契約を緩めたり warning を捨てたりしない。追加の LLM 選択ターンはない。`get` / `validate` は元の source へ委譲。
- trace: `searchTask`, `queries`, `queryToSource` のリスト、query 別の cards（version 含む）と全 notices、`fusionNote` を残す。途中の検索失敗でも送出済み query の trace を残す。生 query を authority へ昇格しない。
- 提案 18: core / host / Eumenes は未変更。SourcePort へは従来どおり `authority.searchTask`。`turn.query` は外部へ直結しない。paired canary 試験で内部 goal を変えても補助入力と DB query は同一、aux data は厳密に `{ searchTask }`。内部 task / canary / host constraints / acceptance は含まれなかった（補助推論は test double、実モデルの出力を捏造した試験ではない）。
- identity / usage: multi 専用の instructions / schema digest を提案 35 の identity に結合。提案 28 の digest と baseline / compact instructions は変更なし。全補助推論は既存の `reformulationInferenceTasks` に別計上、欠測 token は null。
- 欠測: full と retrieval-only の両方で `awaiting_reformulation_inference` / pending となる。DB 検索は 0、query は発明しない。親は pending の公開 searchTask-only prompt に対する推論記録を補う。未完了の ranks / score ファイルは書かない。
- 試験: cap（3 本・空・不正構造の拒否）、同一 version ref の dedupe、異なる version / warning の保持、limit、abort、委譲、paired canary、full / retrieval-only pending を検証。CLI replay で `on` + 既存 reformulation-records の日本語 BM25 hit@8 は **15/16** のまま。省略 / off の旧5件の順位は handle **6,1,null,null,null**、BM25 **1,1,1,1,1** のまま。既存記録や score の内容は上書きしていない。`bun run verify` の format check が既存 JSON 5 件で失敗したため、許可された formatter-only の修正を行った（`reformulation-records.json` と `retrieval-jp-{handle,bm25}{,-reformulation}.json`）。全 5 件について変更前 HEAD と変更後を JSON parse して等値、canonical JSON の SHA-256 も同一と確認した。
- 全体検証: `PATH=/home/box/.bun/bin:$PATH bun run verify`（Bun 1.4.4）。typecheck / lint / format / core 146 tests / examples 51 tests / build / pack を通す。baseline `INSTRUCTION_VERSION` は `build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623` のまま。
- 未実施: multi の実モデル query 生成、compose-4・`retrieval-4f7bhy-jp`・日本語16件の到達と組み立て評点、false-friend / 誤意図の対比較。multi の query 記録・hit 数・SKILL score は作っていない。token 削減も本番 ContextStill 改善も主張しない。
- 次の判断: 親が searchTask-only の recorded-inference を埋め、同じ検索 profile の提案 28 単一 query / 書き換えなしと比較する。単一 query より実測で改善するまで既定 off。提案 30–34 は未実装。
