# 本文全文ではなく card → section 単位の段階的開示

## 目的

プロンプトへ詰める本文を減らし、関連 section だけを読ませて精度と token を改善します。

## 現状の問題

事実: `src/service/build.ts` 263 行で `untrustedEvidence: evidence` として Evidence 本文全文を executeBuild のデータに入れています。推定: 長文の中央にある情報が使われにくくなります。

## 提案

まず card（題名・要約・section 一覧）を渡し、モデルが要求した section だけを次段で渡します。section ID が取れない source は従来どおり全文にします。

## 検証（採用 / 不採用）

採用判定は、提案 01 の固定タスク集合（未整備なら提案 14 の評価キット）で変更前後を同じ record から比較し、下の条件で決めます。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

受入達成が同等以上で token が減ること、または長文タスクで達成が上がることです。

## 悪化したとみなす条件

必要な section を取りこぼして達成が下がることです。

## やらないこと

section の選択をコードのキーワード一致で行いません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts` 263 行。論文: Lost in the Middle https://arxiv.org/abs/2307.03172 、Agent Skills（提案 02 の URL）。

## 依存・前提

前提: section ID を返せる source（本体側は現在返しません。事実）。提案 01。



## 実装結果

- **採否**: 採用
- **内容**: 初回は `evidenceIndex`（題名・section ID）のみ。`disclose` で要求された section（または section なし資料の全文）だけを `untrustedEvidence` へ載せる。05 と 02 は `src/service/disclosure.ts` を共有。
- **パス**: `src/service/disclosure.ts`, `src/service/build.ts`, `src/contracts/schema.ts`, `src/instructions/build.ts`, `src/test/disclosure.test.ts`
- **試験**: `bun test src/test/disclosure.test.ts` ほか既存通過
- **未実施**: 実タスクでの token/達成比較
- **理由**: 本文全文ダンプをやめ、section なしは全文フォールバック。既存試験・検索後継試験を退行させない。
