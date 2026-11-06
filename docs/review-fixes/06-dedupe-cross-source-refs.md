# local/external の同一 ref で build 全体を落とさない

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

同じ ref の重複で build 全体が失敗するのを防ぎます。

## 現状の問題

事実: `src/service/build.ts` はローカルと外部を順位で交互に並べ、同じ ref があると失敗します。

## 提案

重複を除去するか、source ごとの namespace で区別します。どちらにするかは実装時に試験で比べます。

## 検証（採用 / 不採用）

重複 ref の試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

重複があっても build が成立することです。

## 悪化したとみなす条件

異なる内容を誤って同一視することです。

## やらないこと

順位付けの方式を作り直しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/service/build.ts`（同一 ref は先勝ちで後続を落とす。同順位では local が先）、`src/test/build.test.ts`
- 試験: `duplicate refs across local and external keep the first-seen card`
- verify: 成功（Bun 1.4.4）
- 理由: 重複でも build が成立し、先に見た local が選ばれ、異なる内容の外部同名を誤読しない
