# source.get / registry.read の Evidence を境界で Zod parse

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

外部から来る Evidence の形を境界で保証します。

## 現状の問題

事実: `src/service/build.ts` は ref、version digest、external、scope の照合だけを行い、戻り値全体を Zod で検証していません。

## 提案

戻り値を Evidence の Zod schema で parse し、失敗は型付きのエラーとして扱います。

## 検証（採用 / 不採用）

不正な Evidence の試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

不正な Evidence が型付きエラーになることです。

## 悪化したとみなす条件

正常系の挙動が変わることです。

## やらないこと

schema を緩めて通しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts`、`src/contracts/schema.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/contracts/schema.ts`（`evidenceSchema` 追加）、`src/service/build.ts`（`parseEvidence` を `registry.read` / `source.get` / successor 読込みで使用）、`src/test/build.test.ts`
- 試験: `malformed evidence from registry.read is a source contract violation`、`well-formed evidence still builds after boundary validation`
- verify: 成功（Bun 1.4.4）。コア 57 件・examples 26 件通過
- 理由: 不正な status / 巨大 body / 重複 section ID が `source_contract_violation` になり、正常系は従来どおり ready になる
