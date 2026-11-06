# 外部依存でもキャッシュ可、配布前に既存の validate を使う

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

外部依存のある build も再利用できるようにします。

## 現状の問題

事実: `src/service/index.ts` 173 行の条件 `!cached.content.dependencies.some((e) => e.external)` により、外部依存のある build はキャッシュされません。配布前の外部依存の再検証は同ファイル 378 行付近から既にあります。

## 提案

キャッシュ対象に含め、配布時に既存の validate で外部依存を再検証し、失効していればキャッシュを使いません。

## 検証（採用 / 不採用）

失効した外部依存でキャッシュが使われない試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

安全性を保ったままキャッシュが効くことです。

## 悪化したとみなす条件

失効した外部依存が配布されることです。

## やらないこと

validate を省略しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/index.ts` 173 行、378 行。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/service/index.ts`（外部依存でも cache hit を許可）、`src/test/build.test.ts`
- 試験: `cached external builds revalidate and refuse revoked sources on delivery`
- verify: 成功（Bun 1.4.4）
- 理由: 2 回目は modelCalls 増えずキャッシュ。配信は getValidated の既存 validate。失効後は source_revoked で ready にならない
