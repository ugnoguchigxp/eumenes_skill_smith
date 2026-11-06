# 公開入力だけの隔離 LLM query reformulation

## 目的

日本語など、索引語彙とずれた検索文を、公開してよい `searchTask` だけを入力とする隔離した補助推論で、より狭い query に書き換える。内部の task / constraints / 記憶 / authority の秘密は補助モデルへ渡さない。既存 core は SourcePort へこれまでどおり同じ `authority.searchTask` を渡す（提案 18 を戻さない）。

## 現状の問題

事実: 提案 27 の BM25 でも日本語 exact の hit@8 は 2/16 に留まる。handle 順では日本語 8/16 が一致集合外。`re_search` のモデル query は Registry にだけ渡り、外部 SourcePort へは毎回同じ `authority.searchTask` が渡る（提案 18）。example の Registry は空なので、現行の再検索だけでは mock DB の順位は変わらない。

事実: 題名そのものへ query を書き換えるだけでは現行 handle 順を救えない例がある（logs 題名 348 位、hooks 題名 333 位、indent 題名 870 位）。狭い検索語への言い換えや、英語索引への橋渡しを測る価値はある。

未測定: この隔離経路での query 生成そのものの LLM 実測、および書き換え後の日本語 hit@8。

## 提案

example / eval の SourcePort wrapper で `search(publicSearchTask)` を受ける。別の InferencePort 呼び出しへ **searchTask だけ** と検索用 schema を渡す。内部 task / constraints / memory / authority の秘密は渡さない。モデルは狭い英語または原言語の query を 1 本生成し、その query が fixture DB へ実際に届く trace を残す。

既存 core は依然として同じ `authority.searchTask` を SourcePort へ渡す。これは SourcePort 実装側の公開入力変換という実験であり、`turn.query` を外部へ直結する変更はしない。生のモデル query を trusted として昇格しない。最初は query 候補 1 本だけで測る（複数 query は提案 29）。

既定の検索経路は変えない。opt-in（評価オプション）として入れる。語句辞書や固定対訳表で query を分岐しない。

補助推論の入出力と usage は提案 22 の台帳へ計上する。1 回の source call や 1 回の製品 model call に見せかけることはしない。

## 検証（採用 / 不採用）

日本語 16 件と holdout で、同じ profile（まず handle、必要なら BM25）の書き換え前と後の hit@8 を比べる。誤意図の query は LLM が判定する。

searchTask を固定し内部 canary だけを変えた paired 入力で、補助モデルへ渡した入力と、外部／fixture へ届いた query payload が完全一致することを spy で検査する（架空 canary のローカル試験だけ）。内部 task 由来の文字列が 1 件でも補助入力または外部 query に流れたら不採用。

日本語の回復が増えず補助推論だけ増えるなら不採用。新しい recorded-inference と補助 usage が必須。欠測 token は 0 にしない。mock 改善を本番 ContextStill の検索改善と呼ばない。

## よくなったとみなす条件

- 補助モデル入力と外部 query に内部 task / canary が混入しない（提案 18 を維持）。
- 日本語検索の hit@8 が、同じ profile・同じ seed で増える。
- 誤意図の query（目的と違う知識を引く書き換え）が増えない。
- 製品の組み立て経路と `INSTRUCTION_VERSION` を壊さない。

## 悪化したとみなす条件

内部情報の流出、`turn.query` の外部直結、raw query の trusted 昇格、日本語回復なしの補助推論追加、既定経路の無断変更、欠測 token の 0 埋め。

## やらないこと

語句辞書で探索や対訳を決めない。費用上限のゲートは入れない。本番の ContextStill へ接続しない。未確認の Eumenes host API を作らない。提案 18 を戻さない。提案 29 の複数 query を同時に入れない。提案 01/16 の実ユーザー pilot とは呼ばない。

## 依拠

コード: 提案 18 の外部 query 境界、`examples/contextstill` の SourcePort、提案 22 の使用量台帳、提案 27 の検索 profile。論文への新規依拠はない。

## 依存・前提

提案 18 が前提。提案 27 の BM25 とは別変数として測る（検索順位の効果と query 書き換えの効果を混ぜない）。提案 29 は 28 のあとに、必要なら複数 query を足す。

## 実装結果

opt-in の評価経路として実装した。**既定は off のまま**。日本語 16 件では、同じ seed のうえで BM25 と組み合わせると hit@8 が 2/16 から 15/16 に増えた。handle 順だけでは 1/16 から 2/16 で、補助推論だけ増える域を大きくは出ない。既定の検索経路は変えない。

- 選択: `scenario-eval.ts --query-reformulation off|on`（省略時 off、未知の値はエラー）。on のときだけ `examples/contextstill/query-reformulation.ts` の `createReformulatingSource` が fixture SourcePort を包む。記録は `--reformulation-records`（既定 `examples/contextstill/scenarios/reformulation-records.json`）。
- 境界（提案 18 維持）: core と host は変更していない。core は従来どおり `authority.searchTask` を `SourcePort.search` へ渡す。wrapper は受け取った文字列だけを `data: { searchTask }` として補助 InferencePort へ渡し、固定 instructions と schema（`{ query }` 1 本）を付ける。返った query を内側の fixture 検索へ渡し、`{ searchTask, queryToSource }` を trace に残す。生の query を authority へ昇格しない。`turn.query` は外部へ流さない。語句辞書や対訳表は無い。
- identity: `queryReformulation` と、on のときの reformulation instructions / schema digest を提案 35 の identity に入れた（off では null）。`buildInstructions` / `INSTRUCTION_VERSION` / compact instructions は変更していない。
- usage: 補助推論は `usage.reformulationInferenceTasks`（retrieval-only では `reformulationInferenceTasks`）として別計上する。token は null のまま。
- 欠測: 補助推論の記録が無い場合は `awaiting_reformulation_inference` となり、`data/contextstill/scenario-reformulation-pending.json` に書き出して exit 2 で止まる。query を作らず、DB 検索も行わない。retrieval 報告と score ファイルは書かない。
- 隔離試験: searchTask を固定し、内部 goal に `PRIVATE_CANARY_42` を入れたものと入れないものを比べた。補助モデル入力と fixture DB へ届いた query は両者で完全一致し、canary、内部 task、host の constraints / acceptance の文字列は含まれなかった（`examples/contextstill/test/query-reformulation.test.ts`、補助モデルは searchTask を返すだけの test double）。
- 既定 off: retrieval-only の旧5件の順位は、handle（6, 1, 未取得, 未取得, 未取得）と BM25（1, 1, 1, 1, 1）のどちらも記録済みの `scores.json` / `scores-bm25.json` の searchPreview と一致した。
- 日本語 16 件の retrieval-only（suite-3axis、queryStyle=jp）。holdout 課題はこの suite に無い。補助記録は searchTask だけを見て書いた（`examples/contextstill/scenarios/reformulation-records.json`）。前後比較は `retrieval-jp-{handle,bm25}.json` と `retrieval-jp-{handle,bm25}-reformulation.json`。
- hit@8: handle 1/16 → 2/16（@20 は 2/16 → 4/16）。BM25 2/16 → 15/16（@20 は 4/16 → 16/16）。handle で新たに @8 に入ったのは `retrieval-224yjd-jp`（本番 clone）。BM25 の残り 1 件は `retrieval-4f7bhy-jp`（期待「Validate Hook Changes End-to-End」、順位 16）。書き換え query は「verify hook changes through the real execution path」で searchTask に沿うが、上位は「Fix pre-commit verify failures instead of bypassing hooks」になった（語彙の近傍であり、query が別目的を足したわけではない）。`retrieval-2o2vt6-jp` は期待が 5 位で @8 には入る。falseFriendsInTop8 は 0 件。
- 誤意図: 16 本の query はいずれも searchTask の言い換えで、別ゴールを足していない。BM25 では 14 件の 1 位が期待題名と一致、1 件は 5 位で到達、1 件は上記のフック近傍。handle 順では語彙索引を使わないため、同じ query でも回復は小さい。
- 組み立て（SKILL 出力）の評点はこの 16 件では未測定。token は null のまま。本番 ContextStill の検索改善とは呼ばない。提案 27 の既定（handle）も変えていない。
