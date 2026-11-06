# 埋め込み定数を設定へ出す

これは 2026-11-06 のコードレビュー指摘の修正案で、docs/proposals の改善案とは別である。

## 目的

運用で調整が必要な値を設定にします。

## 現状の問題

事実: `src/service/index.ts` に期限上限 120 秒、build 有効期間 30 日、pending の `retryAfterMs` 1000、配布時 validate 5 秒が埋め込まれています。振り返りの 30 秒 / 1200 tokens / 32KB も定数です（場所は実装時に再確認します）。

## 提案

既定値を保ったまま設定で上書きできるようにし、範囲を Zod で検証します。

## 検証（採用 / 不採用）

既定値で既存試験が通り、上書きが効く試験を追加します。 変更後に `bun run verify`（Bun 1.4.4）が通り、追加した試験が変更前は失敗し変更後は通ることを確認します。既存試験が壊れた場合は不採用として戻します。

## よくなったとみなす条件

既定の挙動が変わらず上書きが効くことです。

## 悪化したとみなす条件

設定項目が増えすぎ誤設定が増えることです。

## やらないこと

費用上限のゲートは追加しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/index.ts`。

## 依存・前提

なし。


## 実装結果

- **採用**
- 変更: `src/contracts/limits.ts`（新規）、`src/contracts/ports.ts`、`src/index.ts`、`src/service/index.ts`、`src/service/results.ts`、`src/test/limits.test.ts`
- 試験: `service limits keep package defaults when omitted`、`pending retryAfterMs follows injected service limits`、`submit horizon override rejects deadlines beyond the configured window`、`build expiry uses the configured TTL`
- verify: 成功（Bun 1.4.4）。コア 69 件・examples 26 件
- 理由: 既定値は従来どおり。Ports.limits で上書き可能。Zod で範囲検証
