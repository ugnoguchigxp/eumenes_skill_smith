# 複合の coverage と整形を、根拠供給から分けて検証する

## 目的

複合 Skill の統合品質を、検索が根拠を届けたかどうかと混ぜずに測る。自然検索で届かないことと、届いた根拠を順序立てて整形できないことを分ける。

## 現状の問題

事実: 複合の構造検査は参照が 1 件でも通る。本文を連結する以上の統合品質は未測定。handle 順の自然検索では複合 4 件の allRequiredHit@8 が 0/4 なので、その低い到達を合成だけの責任にはできない。BM25 では同じ 4 件が 4/4 で届く。提案 29 の複数 query は、この同時到達を単一 query より増やさなかった。

未測定: 根拠を揃えて渡したときに、受入条件ごとの根拠・行動・観測・見直し・停止条件を衝突や重複ごと説明できるか。自然検索で根拠が届いたとき（とくに BM25）に、現行指示のままで十分か。単純連結や片方欠落を judge が落とせるか。

## 提案

評価専用に、oracle-evidence と natural の 2 条件を設ける。oracle は期待する参照の本文を検索の成否に依存せず builder へ渡す。natural は現行の検索結果だけを渡す。どちらの条件でも、期待タイトルや軸の正解ラベルは builder に見せない。

InferencePort の指示では、各受入条件について根拠、行動、観測、見直し、停止条件を統合し、重複・衝突・適用範囲を説明するよう求める。必要なら LLM 出力に section ごとの supportRefs を評価用 trace として持たせる。それを製品契約へ広げるかは、品質が上がってから決める。

行動や根拠の内容をコードの語句判定で採点しない。複合を参照 2 件以上に製品側で一律固定しない。参照の個数はタスク期待に対する評価項目に留め、意味上の coverage は LLM 判定に任せる。指示を変えなくても現行の組み立て指示で十分なら、指示変更は見送る。

既定の製品経路は変えない。評価条件は opt-in とし、提案 18 の境界（`turn.query` を SourcePort へ直結しない、内部情報を補助モデルへ渡さない）を維持する。欠測 token は 0 にしない。

## 検証（採用 / 不採用）

複合 4 件を、oracle と natural の 2 取得条件で新しい recorded-inference により採点する。coverage、coherence、conflict handling、actionability を分けて見る。一方の手順を消した出力、互いに矛盾する出力、単純連結の負例も judge にかける。

oracle 条件で品質が改善し、natural 条件でも根拠が届くときに改善し、適用範囲の誤用が増えなければ採用する。合計点だけ上がって片方の欠落を許すなら不採用。現行指示のままで十分なら指示変更は不採用（測定ハーネスだけ残してよい）。

## よくなったとみなす条件

- builder が期待ラベルを見ない。
- oracle と natural が混ざった採点にならない。
- 単純連結や片方欠落を、統合できた出力と区別できる。
- 根拠が届いている natural 条件（例: BM25）でも、統合の説明が改善する。

## 悪化したとみなす条件

期待ラベルの漏洩、製品の複合規則を参照件数で固定すること、片方欠落を高得点にすること、自然検索の失敗を合成失敗として加算すること、提案 18 を戻すこと。

## やらないこと

語句辞書で coverage を判定しない。費用上限のゲートは入れない。本番 ContextStill へ接続しない。未確認の Eumenes host API を作らない。提案 18 を戻さない。提案 29 を既定にしない。提案 01/16 の実ユーザー pilot とは呼ばない。提案 30・32・33・34 は同時に実装しない。

## 依拠

提案 18、26、27、35。論文への新規依拠はない。

## 依存・前提

複合 4 件の自然検索到達は提案 27 の BM25 で 4/4、handle で 0/4。提案 29 は不採用。検索効果と合成効果は混ぜて採点しない。

## 実装結果

測定ハーネスを opt-in として採用。既定の製品経路は natural のまま。複合 4 件の品質採点後、baseline 指示の変更は見送った。

- **選択**: `scenario-eval.ts --full --suite examples/contextstill/scenarios/suite-3axis.json --axis compose --evidence-supply natural|oracle`。省略は `natural`、未知値はエラー。oracle は full 評価専用（retrieval-only と同時指定はエラー）。検索 profile、query-reformulation（off）、assembly-mode（baseline）の既定値は不変。
- **根拠供給**: oracle は suite の expectedRefs だけを評価側で読み、既存の fixture SourcePort.get から実際の文書を取得する。ref 順に並べた通常の card を評価専用 SourcePort.search から返すため検索順位には依存しない。製品 execute は通常どおり get / disclose / validate を通り、版・complete・認可・予算・I/O・return の検査は省略しない。本文・題名を期待ラベルから合成しない。oracle の順位は供給条件の記録であり自然検索の改善ではない。
- **隔離**: builder の task は従来の builderView（goal / acceptance）だけ。期待題名・expectedRefs ラベル・axis は追加せず、通常の card と格納済み本文だけを渡す。SourcePort へ turn.query を渡す変更なし、core は未変更で authority.searchTask の境界を維持。補助モデルの入力も未変更。
- **指示**: baseline `buildInstructions` / `INSTRUCTION_VERSION` は変更なし（`build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623`）。compose の参照 2 件以上を製品規則にしていない。採点の結果、現行指示と受入条件（単なる連結を禁ずる）で根拠が届いたときは統合指針が出たため、compose-integration の指示 delta は見送る。
- **judge**: compose だけの別 schema / 指示で coverage / coherence / conflictHandling / actionability を分離。期待文書本文は judge にだけ追加し、評点は LLM に委ねる。内容を語句で採点しない。元の assemblyJudgeSchema / judge 指示 / 元 5 件の payload は変更なし。報告の composeScores に別項目を保存する。
- **identity / 会計**: 提案 35 の identity に evidenceSupply と compose judge 指示・schema digest を追加。oracle の recorded-inference は host-side recordContext も inputDigest に束縛し、同一の model data でも natural の記録を流用しない。この context は builder の data / system / schema に挿入しない。natural は旧 digest を維持する。builder / judge 呼び出しと評価専用 get を実測、token 欠測は null のまま。記録欠落は pending、meanScore は null。`--output-dir` 指定時の build / judge pending もそのディレクトリに置く。
- **試験結果**: `compose-isolation.test.ts` の 7 試験通過。oracle の元 search を例外にしても実カード・本文が execute / get / disclose で利用でき、builder data の全 turn に gold label / canary 題名 / axis が無い。natural compose の retrieval-only は既存報告の全 rows と parsed 同一（handle 0/4、BM25 4/4 allRequiredHit@8）。旧 5 件 handle full replay は 5/5 scored、平均 4.2 を再現。欠測 builder / judge は pending で SKILL・評点を補完しない。`bun run verify` 通過。
- **採点結果**: 複合 4 件を現行 baseline 指示のまま recorded-inference で採点した。builder は期待ラベルを見ていない。token 欠測は null のまま。`INSTRUCTION_VERSION` は採点前後で不変。
  - natural handle: 4/4 `needs_input`、mean score 1（1, 1, 1, 1）。coverage 平均 1.25（2, 1, 1, 1）、coherence 平均 0、conflictHandling 平均 2.0（3, 5, 0, 0）、actionability 平均 2.0。期待Skillの同時到達は 0/4 のまま。ログ手順が候補に無い、誤った近傍（context_compile の verify）を公式のフック回避禁止に使わない、など検索未到達を正直に保留している。これを合成失敗として元 5 件の 4.2 から差し引かない。
  - natural BM25: 4/4 `ready` / `compose`、mean score 8（8, 8, 8, 8）。coverage 平均 8.75（9, 9, 8, 9）、coherence 平均 8.25（8, 8, 8, 9）、conflictHandling 平均 8.25（8, 9, 8, 8）、actionability 平均 8.0。根拠が届いたときは、先に一方を確認して他方を免除しないこと、適用範囲の違い、検証項目を一つの指針として書いている。packed-offline-smoke の coverage 8 は、モノレポ依存グラフ内や PATH 上の開発バイナリを避ける注意が原文ほど明示されていないため。
  - oracle（search-profile handle で供給だけ切替）: 4/4 `ready` / `compose`、mean score 8。次元点は natural BM25 と同一。同じ開示本文から同じ組み立てを書いており、oracle だから加点していない。evalEvidenceGetCalls は handle/BM25 が 8（judge 用の期待文書取得）、oracle が 16（preload 8 + judge 8）。
- **負例**: `secure-commit-and-logs` の oracle 正例（score 8）を親が明示的に改変し、同じ compose judge 指示 / schema で別 digest として採点した。正例の評点はコピーしていない。
  - dropped-procedure: score 3、coverage 3、coherence 4、conflictHandling 2、actionability 4、expectedSkillUsed false（ログ手順の本文を削除）。
  - contradiction: score 2、coverage 4、coherence 2、conflictHandling 1、actionability 2、expectedSkillUsed false（マスキングすれば .env をコミットしてよい、と根拠の禁止を反転）。
  - concatenation: score 4、coverage 7、coherence 2、conflictHandling 2、actionability 6、expectedSkillUsed true（2件の原文を連結しただけ）。
  3件とも正例の 8 より低く、片方欠落・矛盾・単純連結を統合成功と区別できた。
- **採否**: 測定ハーネスは採用（opt-in。省略時は natural）。製品の複合規則も baseline 指示も変えない。指示変更は不採用。品質改善を製品既定の効果としては主張しない。natural handle の低点は検索未到達であり合成軸へ加算しない。
- **記録**: `examples/contextstill/scenarios/build-records-compose-natural-{handle,bm25}.json`、`build-records-compose-oracle.json`、対応する `judge-records-compose-*.json` と `scores-compose-*.json`、負例は `compose-negatives.json` と `judge-records-compose-negatives.json`。

### 親の記録作成例

各条件で別の `--output-dir` / build-records / judge-records を使う（存在しない記録は pending を出す）。oracle は profile に依存しない供給だが、比較報告には選んだ profile も束縛する。

```sh
PATH=/home/box/.bun/bin:$PATH bun examples/contextstill/scenario-eval.ts \
  --full --suite examples/contextstill/scenarios/suite-3axis.json --axis compose \
  --search-profile bm25 --evidence-supply oracle \
  --build-records data/contextstill/compose-oracle/build-records.json \
  --judge-records data/contextstill/compose-oracle/judge-records.json \
  --output-dir data/contextstill/compose-oracle
```

natural は `--evidence-supply natural`（または省略）とし、handle / bm25 を別々に保存する。pending の system / data / schema を実推論に渡し、inputDigest と一致する出力だけを記録する。oracle pending に付く recordContext は host-side digest の一部であり、builder の model payload に加えない。judge の負例は assembled の内容を親が明示的に変更した別 payload として `inferenceTask` で digest を計算し、実際の LLM 判定だけを記録する。元の正例の評点をコピーしない。
