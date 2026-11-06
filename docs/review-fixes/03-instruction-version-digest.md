# INSTRUCTION_VERSION を指示本文の digest から導く

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

指示を変えたのに版を上げ忘れる事故を防ぎます。

## 現状の問題

事実: `src/contracts/schema.ts` 4 行で `INSTRUCTION_VERSION = "build.v3"` と手動の定数です。

## 提案

指示本文の digest から版を導くか、試験で本文 digest と定数の対応を固定します。

## 検証（採用 / 不採用）

本文を変えて版を変えない場合に失敗する試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

版の上げ忘れが試験で検出されることです。

## 悪化したとみなす条件

空白変更だけでキャッシュが全無効化され運用が困ることです。

## やらないこと

版の意味体系を作り直しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/contracts/schema.ts`、`src/instructions/build.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/instructions/build.ts`（`INSTRUCTION_VERSION = "build." + digest(buildInstructions)`）、`src/contracts/schema.ts`（再エクスポート）、`src/test/build.test.ts`
- 試験: `instruction version is the digest of the live instruction text`
- verify: 成功（Bun 1.4.4）
- 理由: 本文を変えると版が変わり、手動定数 `build.v3` への依存を除去。空白だけの変更も digest が変わる点は、上げ忘れ防止を優先した意図どおり
