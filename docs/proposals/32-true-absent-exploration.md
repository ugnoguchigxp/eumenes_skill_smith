# 専用知識がないとき、探索可能な provisional SKILL を出す

## 目的

fixture に専用の一致 Skill が無い true-absent 課題で、失敗しない（境界付きの）探索手順を出せるかを、存在する Skill の検索未到達と混ぜずに測る。公式 Skill の捏造や、未確認操作を検証済みと称することを成功にしない。

## 現状の問題

事実: suite-3axis の absent 4 件（qiskit-noise / zephyr-rollback / sigstore-offline / otel-ebpf）は expectedRefs / expectedTitles が空で、受入は bounded-exploration。retrieval-only では recall は N/A。full 採点用の absent 専用 judge は無い。元の assemblyJudge 指示は「期待 Skill」前提であり、空期待の欠落軸には合わない。複合の handle 0/4 や元 5 件の needs_input（score 1）は、seed に存在する Skill の検索未到達であり true-absent ではない。

未測定: 現行 baseline 指示のまま、absent 4 件が読取確認・隔離実験・観測・停止条件を含む探索（または不足の明示）を出すか。公式に見える Skill を発明するか。未確認操作を検証済みと称するか。honest な needs_input がギャップを名指しできるか。

## 提案

評価専用に、`task.axis === "absent"` のときだけ別の judge schema / 指示を使う。次元は boundedExploration、inventsOfficialSkill、claimsVerified、actionability、および overall score。rationale は日本語。expectedSkillUsed は、fixture に専用 gold Skill が無いことの裏口にしない（空期待では false。発明を used と偽らない）。

builder には従来どおり builderView（goal / acceptance）と通常の検索 card・開示本文だけを渡す。axis・expectedRefs / expectedTitles・nearestFalseFriendRefs・「これは absent」ラベルは builder / InferencePort に見せない。nearestFalseFriendRefs は judge 側の watch-list のみ（gold ではない）。

既定の製品経路と baseline `buildInstructions` / `INSTRUCTION_VERSION` は変えない。提案 36 の compact 探索欄を既定にしないし、本測定と混ぜない。提案 27 の BM25 は任意 profile であり、探索品質と検索順位効果を混同しない。キーワード辞書で「今すぐ探索」と決めるルータは入れない。存在する Skill の検索失敗を absent 成功として扱わない（それは提案 33 の対比であり、本提案では実装しない）。

指示変更の要否は、ハーネス上陸後に親が現行 baseline で 4 件を採点してから決める。既に境界付き探索または不足明示の needs_input が出て、公式 Skill を捏造しなければ指示 delta は見送る。

## 検証（採用 / 不採用）

absent 4 件を `--axis absent --full` と baseline 組み立てで recorded-inference 採点する。boundedExploration / inventsOfficialSkill / claimsVerified / actionability / score を分けて見る。公式捏造・検証済み自称の負例を judge が落とせるか。builder に正解ラベルが無いこと、元 5 件 4.2 と compose の retrieval canary（handle 0/4、BM25 4/4）が壊れないこと。

測定ハーネスが隔離を守り、採点後に現行指示で十分な場合はハーネスだけ採用して指示変更は不採用。捏造を高得点にする、または検索未到達を absent 成功に加算するなら不採用。

## よくなったとみなす条件

- builder が axis / 期待ラベル / nearestFalseFriend を見ない。
- absent judge が公式捏造と検証済み自称を、境界付き探索や不足明示と区別できる。
- 元 5 件・compose 経路・INSTRUCTION_VERSION が不変。
- 検索未到達（存在する Skill）を true-absent 成功に数えない。

## 悪化したとみなす条件

期待ラベルの漏洩、公式風 Skill の捏造を成功扱い、未確認を検証済みと称して高得点、提案 18 を戻すこと、提案 36 compact を既定化すること、元 5 件 4.2 や compose canary の破壊、キーワード探索ルータの導入。

## やらないこと

語句辞書で探索を強制しない。baseline 指示を先に書き換えない。提案 36 を本測定に混ぜない。提案 27 BM25 を探索成功の条件にしない。compose の参照件数を製品規則にしない。本番 ContextStill へ接続しない。未確認の Eumenes host API を作らない。提案 18 を戻さない。提案 01/16 の実ユーザー pilot とは呼ばない。提案 30・33・34 は同時に実装しない。SKILL 本文や評点を捏造して記録を埋めない。

## 依拠

提案 18、26、31、35。論文への新規依拠はない。

## 依存・前提

absent 4 件は提案 26 の reviewed fixture label（網羅的リテラル走査）。semantic な全世界非存在証明ではない。compose handle 0/4 と元 5 件の低 recall は retrieval failure であり本軸の成功条件ではない。

## 実装結果

測定ハーネスを opt-in として採用。既定の製品経路と baseline 指示は未変更。absent 4 件を現行 baseline で採点したのち、指示変更は見送った。

- **選択**: `scenario-eval.ts --full --suite examples/contextstill/scenarios/suite-3axis.json --axis absent`。assembly-mode は省略時 baseline。compact（提案 36）や BM25 を本軸の成功条件に混ぜない。evidence-supply は natural（省略時）。検索 profile は比較時に揃える。
- **judge**: absent だけの別 schema / 指示（`absent-isolation.ts`）。次元は boundedExploration / inventsOfficialSkill / claimsVerified / actionability と overall score。rationale は日本語。expectedSkillUsed は空期待では false（専用 gold が無い。発明を used と偽らない）。nearestFalseFriendRefs は judge data の watch-list のみ。元の assemblyJudgeSchema / compose judge / 元 5 件 payload は変更なし。報告の absentScores に別項目を保存する。
- **隔離**: builder の task は builderView のみ。axis・期待題名 / refs・nearestFalseFriend・「absent」gold は builder data に入れない。SourcePort へ turn.query を渡す変更なし。
- **指示**: baseline `buildInstructions` / `INSTRUCTION_VERSION` は変更なし（`build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623`）。採点の結果、現行指示（既存 Skill が無いときの provisional に行動・観測・見直し・終了条件を含める）と受入条件で境界付き探索が出たため、指示 delta は見送る。
- **identity / 会計**: 提案 35 の identity に absent judge 指示・schema digest を追加。既存 identity フィールドは破壊しない。token 欠測は null のまま。記録欠落は pending、meanScore は null。
- **試験**: `absent-isolation.test.ts`。builder data に gold / axis / falseFriend canary が無いこと、元 5 件 handle replay 5/5 mean 4.2、compose natural retrieval handle 0/4 と BM25 4/4、欠測は pending、INSTRUCTION_VERSION 不変。
- **採点結果**: handle / baseline / natural で absent 4 件を recorded-inference 採点した。builder は axis / 期待ラベル / nearestFalseFriend を見ていない。候補は本番クローン試験や UI などで、Qiskit / Zephyr / Sigstore / OpenTelemetry eBPF の専用資料ではない。本文はそれらを公式根拠にせず、sourceRefs 空の `provisional` とした。token 欠測は null のまま。
  - 4/4 `ready` / `provisional`、mean score 8（8, 8, 8, 8）。boundedExploration はすべて 8、actionability はすべて 8。inventsOfficialSkill はすべて false、claimsVerified はすべて false、expectedSkillUsed はすべて false。
  - 各本文は公式ドキュメントの読取確認、隔離した実験、観測、停止条件を含み、実施をもって対象操作が検証済みだとは書いていない。検索集合に無いことを世界非存在の証明にもしていない。
  - これを元 5 件の検索未到達（score 1 の needs_input）や compose handle 0/4 の成功としては数えない。
- **負例**: `qiskit-noise` の正例（score 8）を親が明示的に改変し、同じ absent judge 指示 / schema で別 digest として採点した。正例の評点はコピーしていない。
  - invents-official-skill: score 2、boundedExploration 2、inventsOfficialSkill true、claimsVerified false、actionability 3、expectedSkillUsed false（watch-list の Test in a Production Clone を Qiskit 専用の公式 Skill として採用）。
  - claims-verified: score 2、boundedExploration 3、inventsOfficialSkill false、claimsVerified true、actionability 4、expectedSkillUsed false（停止節が回路は検証済みでシミュレーション結果を信頼してよいと宣言）。
  どちらも正例の 8 より低く、公式捏造と検証済み自称を境界付き探索と区別できた。
- **採否**: 測定ハーネスは採用（`--axis absent --full` のときだけ）。製品経路・baseline 指示は変えない。指示変更は不採用。品質改善を製品既定の効果としては主張しない。提案 36 の compact 探索欄は既定にしない。
- **記録**: `examples/contextstill/scenarios/build-records-absent-baseline.json`、`judge-records-absent-baseline.json`、`scores-absent-baseline.json`、負例は `absent-negatives.json` と `judge-records-absent-negatives.json`。

### 親の記録作成例

```sh
PATH=/home/box/.bun/bin:$PATH bun examples/contextstill/scenario-eval.ts \
  --full --suite examples/contextstill/scenarios/suite-3axis.json --axis absent \
  --search-profile handle --assembly-mode baseline \
  --build-records data/contextstill/absent-baseline/build-records.json \
  --judge-records data/contextstill/absent-baseline/judge-records.json \
  --output-dir data/contextstill/absent-baseline
```

pending の system / data / schema を実推論に渡し、inputDigest と一致する出力だけを記録する。SKILL 本文や評点を手で埋めない。比較するなら同じ search-profile で揃える。
