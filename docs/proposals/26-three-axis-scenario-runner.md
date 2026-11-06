# 検索・複合・欠落の typed suite と二モード runner で検証基盤を固定する

## 目的

平均 4.2 の改善案（27 以降）を一つずつ採否判定できるよう、「存在する Skill を引き当てるか（retrieval）」「複数の根拠をそろえるか（compose）」「専用知識が無いときに偽らないか（absent）」を分けて測る土台を作ります。本提案は測定基盤であり、Skill の品質改善を主張しません。

## 現状の問題

事実: `scenario-eval.ts` は 5 件・32 件上限の単一 schema で、`expectedRefs` は 1 件以上、axis はありません。`retrievalRank` は最初に一致した ref の順位だけを返すため、複合課題で片方だけ届いても成功に見えます。検索だけを見たいときも builder と judge の推論記録が必要です。記録欠落時の出力は pending だけで、課題ごとの状態がありません。

## 提案

- `src/eval/scenario-score.ts` に axis 別の discriminated union（retrieval / compose / absent）を足す。旧 5 件 schema はそのまま受け、内部で正規化する。absent だけが空の期待 ref を許し、compose は 2 件以上を要求する。上限は 64 件。
- `refRanks`（期待 ref ごとの 1 始まり順位、無ければ null）と `allRequiredHit`（全 ref が k 以内のときだけ true、期待が空なら null = N/A）。
- `examples/contextstill/scenario-runner.ts`: `--retrieval-only` は SourcePort.search だけを呼び、推論 port を持たない。`--full` は従来どおり製品実行 + recordedInference + 記録済み LLM judge。
- builder へは `builderView`（goal と acceptance）だけを渡し、axis・期待 ref・期待題名は judge にだけ渡す。旧 5 件の judge 入力は byte 同一に保ち、既存記録を再生する。
- full で pending / error が一件でもあれば `meanScore` を null にし、課題ごとの status を出す（提案 35 の最小部分）。
- CLI: `--axis`、`--query-style`、`--output-dir`。新しい報告は既定で `data/contextstill/scenario-reports/` に書き、repo の `scores.json` は旧 suite の full 既定実行でだけ更新する。
- 61 件 suite `scenarios/suite-3axis.json`（旧 5 件 + 16 知識 × exact/en/jp + compose 4 + absent 4）。下書きで acceptance が無い課題には、期待題名を含まない軸共通の受入条件を足した。handle と題名は新設していない。

## 検証（採用 / 不採用）

`bun run verify`、旧 5 件の retrieval-only 順位の再現、48 件の hit@8 の再現、compose 4 件がすべて false、absent が N/A、旧 suite の full 再生で平均 4.2 の再現、単体試験（schema、複数 ref、空 ref は absent のみ、retrieval-only が search 以外を呼ばない）。

## よくなったとみなす条件

既知の数字を検索を変えずに再現し、推論ゼロで検索軸を測れ、旧記録の再生が壊れないことです。

## 悪化したとみなす条件

既知の順位や平均が変わる、builder に正解ラベルが漏れる、未採点課題を含む平均を出す、のいずれかです。その場合は戻します。

## やらないこと

検索順位の変更（BM25 は提案 27）、軸別 judge（34）、LLM 評点の作成や補完、キーワードによる意味分岐、本番 ContextStill の検索品質の主張、実ユーザー pilot（01 / 16）の代替。

## 依拠（コード）

`examples/contextstill/scenario-eval.ts`、`scenario-runner.ts`、`src/eval/scenario-score.ts`、`src/eval/recall.ts`（期待が空を許さないため、空を N/A とする `allRequiredHit` を別に置いた）。

## 実装結果

- **採否**: 採用（測定基盤として。品質改善の主張はしない）
- **retrieval-only（推論 0、handle 順検索、limit 20）**:
  - 旧 5 件 top-8 順位: commit-no-secrets=6、test-production-clone=1、no-secrets-in-logs=null、no-hook-bypass=null、four-space-indent=null（既知値と一致）
  - 48 件 allRequiredHit@8: exact 2/16、en 3/16、jp 1/16（既知値と一致）。診断用 @20: exact 4/16、en 3/16、jp 2/16
  - compose allRequiredHit@8: 0/4。secure-commit-and-logs は片方が 7 位で、旧 first-hit 順位なら「7 位で成功」に見えていた
  - absent 4 件: recall N/A（0/0 を満点扱いしない）。4 件とも top-8 に watch-list の近接候補が入る
- **full 再生（旧 suite + 既存記録）**: 5/5 scored、平均 4.2（再現）
- **未実施**: 61 件の full 採点（新しい builder / judge 記録が必要。評点は作っていない）。absent / compose に適した judge 指示（34）、失敗会計と検索 profile 束縛の残り（35）、検索改善（27）
