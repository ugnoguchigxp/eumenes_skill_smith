# checkDecision 失敗にも修復し、失敗コードを渡す

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

構造違反も修復機会を与え、修復入力に具体的な失敗理由を渡します。

## 現状の問題

事実: `src/service/build.ts` の修復は schema 不一致時だけで、`checkDecision` の構造違反は例外になり、修復入力は固定の `invalid_output` です。

## 提案

構造違反のコードと箇所を修復入力に含め、既存の modelCalls 上限の範囲で修復します。失敗理由を渡さない盲目的な自己修正はしません。

## 検証（採用 / 不採用）

構造違反のあと修復が成功する試験と、上限で止まる試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

修復成功の試験が通り、上限が守られることです。

## 悪化したとみなす条件

修復で検査をすり抜ける出力が通ることです。

## やらないこと

modelCalls 上限を外しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/build.ts` の `checkDecision` と修復処理。論文: LLMs Cannot Self-Correct https://arxiv.org/abs/2310.01798 。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/service/build.ts`（checkDecision 失敗を repair に回し、失敗コードを渡す。modelCalls 上限維持。context_budget_exceeded は即失敗）、`src/test/build.test.ts`
- 試験: `a structural decision failure can be repaired within the model call budget`、`structural repair stops at the model call limit and keeps the failure code`
- verify: 成功（Bun 1.4.4）。コア 61 件・examples 26 件
- 理由: 構造違反が具体コード付きで修復され、上限超過後はすり抜けず失敗コードを保持
