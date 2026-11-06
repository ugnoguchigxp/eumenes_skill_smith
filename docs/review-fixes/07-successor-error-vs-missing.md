# 通信断と後継なしを区別し、可能なら後継の版を pin する

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

後継取得の失敗理由を正しく伝えます。

## 現状の問題

事実: `src/service/build.ts` の後継取得は版を pin せず、`SkillSmithError` 以外の例外をすべて `unavailable` に丸めています。

## 提案

通信断を `error` などの別状態にし、取得した後継の版を記録します。

## 検証（採用 / 不採用）

通信断と欠落、版不整合の試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

状態が区別されることです。

## 悪化したとみなす条件

状態追加で既存の呼び出し側が壊れることです。

## やらないこと

再試行ループを入れません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts` の後継取得、`src/test/successors.test.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/service/build.ts`（outcome `error` 追加）、`src/instructions/build.ts`（不足扱いの文言）、`src/test/successors.test.ts`
- 試験: 既存の missing/cycle/limit を更新、`a transport failure while fetching a successor is reported as error` を追加
- verify: 成功（Bun 1.4.4）
- 理由: 通信断は `error`、返却されたが使えない後継は `unavailable`。版 pin は後継 card が無いため未実施（発明しない）
