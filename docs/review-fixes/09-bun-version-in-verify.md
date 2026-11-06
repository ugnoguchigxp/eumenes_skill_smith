# verify で bun 1.4.4 を確認する

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

verify が誤った bun 版で紛らわしく失敗するのを防ぎます。

## 現状の問題

事実: `bun run verify` は Bun 1.4.4 で成功し、PATH 上の 1.4.2 では `bun check` がなく失敗します。verify は版を確認していません。

## 提案

verify の最初で bun 版を確認し、不足なら明示的なメッセージで止めます。

## 検証（採用 / 不採用）

1.4.2 と 1.4.4 で挙動を確認します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

版不足が明確なメッセージで止まることです。

## 悪化したとみなす条件

正しい版で失敗することです。

## やらないこと

bun の自動インストールはしません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `package.json`、`scripts/`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `scripts/verify.ts`、`scripts/bun-version.ts`（新規）、`src/test/bun-version.test.ts`
- 試験: `verify bun version gate accepts 1.4.4 and rejects older patch`
- verify: 成功（Bun 1.4.4）。1.4.2 相当は `bunAtLeast` で false
- 理由: 版不足が明示メッセージで止まり、1.4.4 では従来どおり通る
