# 適切な棄権と過剰棄権を対比し、存在 Skill の検索未到達を欠落扱いしない

## 背景

事実: 提案 32 で true-absent 4 件（expectedRefs 空）は handle / baseline / natural で 4/4 `ready` / `provisional`、mean 8、boundedExploration 8、inventsOfficialSkill / claimsVerified / expectedSkillUsed はすべて false と採点した。この 8 は欠落軸専用であり、存在する Skill の検索未到達の成功ではない。

事実: 元 5 件 handle では commit-no-secrets（rank 6）と test-production-clone（rank 1）が ready / reuse、score 9。no-secrets-in-logs / no-hook-bypass / four-space-indent は retrievalRank null の needs_input、score 1。compose natural は handle 0/4 同時到達（すべて needs_input）、BM25 4/4 ready / compose mean 8。これらの Skill は seed に存在し、handle の未到達は retrieval failure であって true absence ではない。

未測定: 検索未到達のときの needs_input が、欠けている根拠を名指しする適切な棄権か。期待 ref が届いているのに棄権する過剰棄権があるか。存在する Skill を「専用 Skill は無い」とする偽の欠落探索があるか。元の assemblyJudge は score 1 を付けるだけで、この区別を記録しない。

## 対象

expectedRefs が空でない課題（元 5 件、suite-3axis の retrieval / compose）。absent 軸（expectedRefs 空）は提案 32 の judge のままで対象外。

## 方法

評価専用の対比 judge（`examples/contextstill/abstention-isolation.ts`）を opt-in で追加する。次元は overall score（0〜10）、expectedSkillUsed（元 5 件と同じ意味）、rationale（日本語）、および:

- treatsExistingAsAbsent: expectedRefs があるのに、専用 Skill が無い前提の探索 provisional を書く、または非存在を主張する（偽の欠落・不採用側）。
- excessiveAbstention: この回の retrieved に期待 ref があるのに needs_input / unavailable（過剰棄権）。
- appropriateGap: 期待 ref が retrieved に無く、needs_input / unavailable として欠落根拠を名指しし、全世界的な非存在を主張しない（適切な棄権）。

schema 上は排他ではないが、指示で appropriateGap と treatsExistingAsAbsent、appropriateGap と excessiveAbstention を同時に true にしないよう求める。根拠を使った reuse / adapt / compose の ready は棄権ではない。

judge data には task（expectedRefs を含む）、retrieved / retrievalRank、組み立て結果に加え、ハーネスが機械照合した `expectedRefsRetrieved`（retrieved に現れた期待 ref）を渡す。builder には従来どおり builderView（goal / acceptance / constraints / references）と通常の card・本文だけを渡す。axis・expectedRefs / expectedTitles・nearestFalseFriendRefs・evidenceSupply・棄権 / 欠落の gold は builder data に入れない。

CLI: `--abstention-contrast off|on`（省略時 off、他の値はエラー、on は `--full` 必須）。報告は別項目 `abstentionScores`。identity に abstentionContrast と対比 judge 指示・schema digest を追加（加算のみ）。judge 入力の system / schema / data が変わるため、元 5 件・compose の judge 記録は digest が一致せず再利用されない。build 記録は builder 入力が不変なので再利用できる。

キーワードで探索か棄権かを決めるルータは入れない。提案 36 compact を混ぜない。検索順位を変えない。BM25 を本軸の条件にしない。

## 検証

親が既存の build 記録を対比 judge で採点する（新しい builder 出力は作らない）。期待: 元 5 件の 2 hit は 3 フラグとも false、3 miss（needs_input のまま）は appropriateGap true / 他 false。compose handle の needs_input は同じく appropriateGap 類。compose BM25 の ready は excessiveAbstention / treatsExistingAsAbsent false。負例（親が作成）: (a) miss の needs_input を「公式 Skill は無い」とする 32 型探索に改変 → treatsExistingAsAbsent true・低得点、(b) hit / compose ready を期待 ref 到達下で needs_input に改変 → excessiveAbstention true・低得点。正例の評点はコピーしない。

試験（`test/abstention-isolation.test.ts`）: digest 安定と INSTRUCTION_VERSION 不変、フラグ厳格、省略時の元 5 件 handle 5 件 mean 4.2、compose retrieval handle 0/4・BM25 4/4、builder data に gold / axis / falseFriend / 対比 canary が無い、記録欠落は awaiting_judge のまま評点を作らない、token は null、on で元 5 件・compose judge 記録を再利用しない。

## 採用しないとき

judge が偽の欠落探索や過剰棄権を適切な棄権と区別できない、検索未到達を absent 成功に加算する、builder へ gold が漏れる、元 5 件 4.2 や compose canary が壊れるなら不採用。現行指示で検索未到達時に適切な棄権が出て、根拠到達時に組み立てるなら、ハーネスのみ採用し指示変更は見送る。

## リスク

`expectedRefsRetrieved` は judge への事実ヒントであり、判定を機械的に誘導しうる（推定）。3 フラグは LLM 判断であり、境界例（部分到達の compose）は揺れうる。compose で一部の期待 ref だけ届いた場合の過剰棄権の定義は judge 判断に委ねている。記録済み scores.json の identity は採点時点のものであり、再生成すると加算フィールドが増える（評点・payload は不変）。

## 実装結果

測定ハーネスを opt-in として採用した（`--abstention-contrast on --full` のときだけ）。既定の製品経路、baseline `buildInstructions`、`INSTRUCTION_VERSION`（`build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623`）、元 assemblyJudgeSchema、compose / absent judge は変更なし。既存の build 記録だけを対比 judge で採点し、新しい builder 出力は作っていない。指示変更は見送った。対比 judge の平均 8 は元 5 件の assembly judge 平均 4.2 の置き換えではない。

### 親の採点例

```sh
PATH=/home/box/.bun/bin:$PATH bun examples/contextstill/scenario-eval.ts \
  --full --abstention-contrast on --search-profile handle \
  --build-records examples/contextstill/scenarios/build-records.json \
  --judge-records examples/contextstill/scenarios/judge-records-abstention-original-five.json \
  --output-dir data/contextstill/abstention/original-five
```

- **採点結果（対比 judge。元の assembly / compose judge の評点は変えていない）**:
  - 元 5 件 handle: mean 8（8, 8, 8, 8, 8）。2 hit（commit-no-secrets rank 6、test-production-clone rank 1）は ready / reuse、expectedSkillUsed true、3 フラグとも false。3 miss（no-secrets-in-logs / no-hook-bypass / four-space-indent）は needs_input、expectedRefsRetrieved 空、appropriateGap true、treatsExistingAsAbsent / excessiveAbstention false。不足文は今回の候補の不適合を名指しし、世界非存在や探索型 provisional にはしていない。この 8 は元の assembly judge 平均 4.2（9, 9, 1, 1, 1）を置き換えない。検索未到達の 1 は expectedSkillUsed 側の比較用スライスのまま残す。
  - compose natural handle: mean 8（8, 8, 8, 8）、4/4 needs_input、expectedSkillUsed false。fix-check-and-no-force / packed-offline-smoke / python-style は期待 ref が検索に無く appropriateGap true。secure-commit-and-logs だけコミット規則が 7 位に届き、ログ指針は届いていない。needs_input は届いた半分を開示済みと認め残りの半分を名指しした。不完全な compose を拒んだので excessiveAbstention は false。expectedRefsRetrieved が空でないため appropriateGap も false（3 フラグとも false）。treatsExistingAsAbsent は 4 件とも false。
  - compose natural BM25: mean 8（8, 8, 8, 8）、4/4 ready / compose、expectedSkillUsed true、期待 ref が両方検索に届き両方使っている。3 フラグとも false。根拠到達時に組み立てている。
  - provider の入出力トークンは null のまま（未測定）。
- **負例**: 元 5 件 handle の正例を親が明示的に改変し、同じ対比 judge 指示 / schema で別 digest として採点した。正例の評点はコピーしていない。
  - treats-existing-as-absent（元 no-secrets-in-logs の appropriateGap 8）: score 2、treatsExistingAsAbsent true、appropriateGap false。本文が公式専用 Skill はコーパスに存在しないとして探索型 provisional を書く。
  - excessive-abstention（元 commit-no-secrets の ready / reuse 8）: score 2、excessiveAbstention true。期待 Skill が検索 6 位に届いているのに needs_input で拒む。
  どちらも正例の 8 より低く、偽の欠落探索と過剰棄権を適切な棄権・根拠利用と区別できた。
- **採否**: 測定ハーネスは採用（`--abstention-contrast on --full` のときだけ）。製品経路・baseline 指示は変えない。指示変更は不採用。現行指示は検索未到達で不足を名指しし（偽の欠落探索にしない）、根拠が揃えば組み立て、複合の片方だけなら残りの不足を名指しする。対比 judge の平均 8 を元 5 件 4.2 の改善とは呼ばない。提案 32 の欠落軸 mean 8 も、この検索未到達の成功としては数えない。
- **記録**: `examples/contextstill/scenarios/scores-abstention-original-five.json`、`scores-abstention-compose-handle.json`、`scores-abstention-compose-bm25.json`、対応する `judge-records-abstention-*.json`、負例は `abstention-negatives.json` と `judge-records-abstention-negatives.json`。build 記録は既存のものを再利用した。
