# 実行で検証できたものだけを候補へ進める

## 目的

改善候補や provisional 指針のうち、実行で受入条件を満たしたものだけを正式化の候補に進めます。

## 現状の問題

事実: 現在、候補の昇格に実行検証の条件はありません。正式採用（P6）は未実装です。

## 提案

受入条件を満たした実行報告が付いたものだけに「検証済み」の印を付け、管理者への候補一覧に載せます。正式公開は管理者操作（P6）のままとし、自動登録しません。

## 検証（採用 / 不採用）

採用判定は、提案 01 の固定タスク集合（未整備なら提案 14 の評価キット）で変更前後を同じ record から比較し、下の条件で決めます。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

候補一覧の人手評価で採用に値する割合が上がることです。

## 悪化したとみなす条件

検証可能なタスクに偏り、有用な候補が落ちることです。

## やらないこと

自動で registry へ登録しません。 本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/results.ts`。論文: Voyager https://arxiv.org/abs/2305.16291 。

## 依存・前提

前提: 受入条件付きの報告（提案 01、14）。

## 実装結果

- **採否**: 採用（ローカル印）
- **内容**: `markExecutionVerified` は succeeded の report + bindUse がある proposed/validated 候補にだけ `executionVerified` を付ける。自動で正式 Skill 登録はしない。
- **パス**: `src/service/results.ts`, `src/contracts/schema.ts`, `src/contracts/types.ts`, `src/test/execution-verified.test.ts`
- **試験**: 通過。本体 publish API は未発明。
- **理由**: Voyager 的な実行検証の印を、ホスト API なしで安全に追加できた。
