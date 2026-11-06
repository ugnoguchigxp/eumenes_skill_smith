# JSON.parse のまま型断言しない

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

保存済みデータの破損を検出します。

## 現状の問題

事実: `src/sqlite/index.ts` は `JSON.parse` の結果を型断言しているだけです。

## 提案

読込み時に Zod で parse し、破損は明示的なエラーにします。

## 検証（採用 / 不採用）

破損行の試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

破損が検出されることです。

## 悪化したとみなす条件

読込みが大きく遅くなることです（未測定）。

## やらないこと

移行処理を同時に作りません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/sqlite/index.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/contracts/schema.ts`（requestRecord / report / reflection / proposal / outcome schema）、`src/sqlite/index.ts`（`parseStored`）、`src/test/sqlite.test.ts`
- 試験: `corrupt stored JSON is refused instead of typed through`
- verify: 成功（Bun 1.4.4）。コア 58 件・examples 26 件通過
- 理由: 壊れた JSON と schema 不一致が `corrupt_storage` になり、正常な reopen / replay は従来どおり
