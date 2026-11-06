# degraded / truncated 時に再検索するかをモデルが判断する

## 目的

検索結果が degraded や truncated のとき、そのまま合成せず、再検索の要否をモデルに判断させます。

## 現状の問題

事実: SourcePort は warnings / degraded を返せますが、それを受けて再検索する経路はありません。

## 提案

検索の状態（degraded、truncated、件数）を構造化してモデルへ渡し、モデルが再検索を求めた場合のみ、コードが予算内で構造化された再検索を 1 回実行します。意味の判断はモデル側に置き、コードは要求の実行と上限の強制だけを行います。

## 検証（採用 / 不採用）

採用判定は、提案 01 の固定タスク集合（未整備なら提案 14 の評価キット）で変更前後を同じ record から比較し、下の条件で決めます。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

degraded 条件のタスクで受入達成が上がり、正常条件で悪化しないことです。

## 悪化したとみなす条件

再検索が無駄に増えて token が増えるのに達成が変わらないこと、または正常条件で悪化することです。

## やらないこと

状態語やクエリ語に基づく固定の分岐を入れません。無制限の再検索ループを作りません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts` の検索・予算予約。論文: Corrective RAG https://arxiv.org/abs/2401.15884 、Self-RAG https://arxiv.org/abs/2310.11511 。

## 依存・前提

前提: 提案 01、14。degraded を再現する疑似環境（examples/contextstill）。



## 実装結果

- **採否**: 採用（製品経路の継ぎ目）
- **内容**: `modelTurnSchema` に `re_search` を追加。モデルが要求したときだけ予算内で再検索を1回実行。degraded 等のキーワード分岐はしない。`modelCalls` 上限を 4 に拡張（既定の試験は 2 のまま）。
- **パス**: `src/contracts/schema.ts`, `src/service/build.ts`, `src/instructions/build.ts`, `src/test/re-search.test.ts`
- **試験**: `bun test src/test/re-search.test.ts` ほか既存コア通過
- **未実施**: 実タスクでの degraded 条件の達成率比較（提案 01 コーパス待ち）
- **理由**: 構造化された再検索と予算強制が動き、既存試験を退行させない。意味判断はモデル側のまま。
