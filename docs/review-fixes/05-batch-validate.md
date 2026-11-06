# validate を配列まとめて呼ぶ

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

port の呼び出し回数を減らします。

## 現状の問題

事実: `src/contracts/ports.ts` の validate は配列を受け取れますが、`src/service/build.ts` は 1 件ずつ呼んでいます。

## 提案

まとめて 1 回呼び、結果を ref で対応付けます。

## 検証（採用 / 不採用）

呼び出し回数を数える試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

呼び出しが 1 回になり結果が同じことです。

## 悪化したとみなす条件

部分失敗の扱いが曖昧になることです。

## やらないこと

port の形を変えません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/contracts/ports.ts`、`src/service/build.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/service/build.ts`（selected を一度に validate）、`src/test/build.test.ts`
- 試験: `selected external evidence is validated in one source call`
- verify: 成功（Bun 1.4.4）
- 理由: build 時の validate が 1 回になり、無効時は従来どおり source_revoked。delivery の再検証は別途維持
