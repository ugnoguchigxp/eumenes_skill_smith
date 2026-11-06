# 元 build の成功と候補そのものの検証を分離する

## 目的

`executionVerified` が「元 build の成功報告」を指すことと、「生成した候補そのものを実行して検証した」ことを分け、訂正や本文変更で古い印が残らないようにします。

## 現状の問題

事実: `executionVerified` は元 build の succeeded 報告に付き、生成した提案そのものの実行ではありません。succeeded を failed へ訂正しても印が残ります。検索時にはまだ使われていません。推定: 将来の誤優先や誤昇格の要因になります。未測定: 候補一覧の改善幅。

## 提案

まず現在の印を元 build 報告由来と明示します。候補本文の digest、対象課題 / 受入条件、独立実行結果、report revision、検証器版へ束縛した別の評価証跡を試します。報告の訂正 / 忘却 / 候補変更で証跡が使えなくなることを検査します。候補を formal registry へ登録せず、ローカル候補 fixture の executor だけで実行します。試験は、元 build だけ成功して候補は失敗、成功報告の訂正、候補文の変更、空根拠、条件違い、非実行の説明タスクを含めます。

## 検証（採用 / 不採用）

boolean 印だけで検索優先度を上げません。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。安全な意味の訂正と、候補有用性の測定は採否を分けて記録します。

## よくなったとみなす条件

未実行の候補や訂正済み成功を検証済みとせず、検証不能を unverified として残し、人手の候補誤認が減ることです。

## 悪化したとみなす条件

検証可能な課題だけで全候補を排除すること、証跡のないものを成功へ換算することです。

## やらないこと

boolean 印だけで検索優先度を上げません。自動 promotion をしません。ホストの実行検証 API を発明しません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/results.ts` の `executionVerified`、関連試験 `src/test/execution-verified.test.ts`。論文: [Voyager](https://arxiv.org/abs/2305.16291)。Minecraft の実行環境がある前提を、一般手順へ無批判に移しません。

## 依存・前提

提案 17 の共通 executor と提案 22 の出所 trace。実課題で候補有用性を測るなら提案 16 のコーパスが必要です。仮定: 候補を局所実行できる課題があること。

## 実装結果

- **採否**: 採用（意味の訂正）。候補有用性の実測は未測定。
- **内容**: `executionVerified` を元 build 報告由来と明記し、succeeded 以外への訂正でクリア。候補本文 digest に束縛する `candidateVerification` と `bindCandidateVerification` を追加。本文変更で invalidated。検索優先や自動 promotion はしない。
- **パス**: `src/contracts/{schema,types,ports}.ts`, `src/sqlite/index.ts`, `src/service/results.ts`, `src/eval/candidate-verify.ts`, `src/test/execution-verified.test.ts`, `integration-contract.md`
- **試験**: `bun test src/test/execution-verified.test.ts`（5 pass）。訂正後に executionVerified が消えることを確認。
- **未実施**: 実課題での候補有用性、検索順位への影響測定（意図的に未接続）
- **理由**: 誤った「検証済み」残存を止め、候補実行と元 build 成功を分離した。
