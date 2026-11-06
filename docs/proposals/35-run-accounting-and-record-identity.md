# 完全 run の失敗会計と record identity を束縛する

## 目的

未採点や失敗を平均から外して見かけの精度を上げられないようにし、検索 profile・suite・指示・schema が違う記録を別評価だと見分けられるようにします。本提案は測定基盤であり、Skill の品質改善を主張しません。提案 26 が入れた「一件でも未採点なら `meanScore` は null」は維持します。

## 現状の問題

事実: full の各課題は実行例外を `error` にし得ますが、`source.search` は課題ループの try の外にあり、ここで例外が出ると残りの課題が一覧に出ません。judge の schema 不正は汎用の `error` になり、記録欠落（pending）と区別しにくいです。報告には `searchProfile` がありますが、suite・seed・builder/judge 指示・judge schema の digest と、使った記録の inputDigest は束縛されていません。profile を変えると候補順が変わり builder の inputDigest も変わるため、現行の recorded-inference は不一致を pending にします。それは維持し、報告側でも同一評価かどうかを見えるようにします。

## 提案

- 課題ごとの search / 実行 / judge を独立させ、一件の source error・budget 超過・不正 schema・記録欠落が残件の一覧を消さない。
- status を分ける: `scored` / `awaiting_build_inference` / `awaiting_judge` / `invalid`（記録はあるが judge 出力が schema に合わない） / `error`（search・実行・その他）。未採点を 0 や満点で埋めない。`meanScore` は全件 `scored` のときだけ出し、error を除外した部分平均は出さない。
- 報告に `identity` を付ける: `searchProfile`、suite id、suite ファイルの SHA-256、seed/DB ファイルの SHA-256、builder 指示 digest、judge 指示 digest、judge schema digest。digest 関数は既存の `digest()` を指示と schema に使い、ファイルは内容の SHA-256 とする。
- 課題ごとに `recordProvenance` を付ける: 実際に要求した builder の inputDigest 一覧、judge の inputDigest（未到達なら null）、使った記録の有無。retrieval の snapshot（既存の searchPreview）と used refs / terminal kind は現状どおり残す。
- 使用量は分かるものだけ書く。recorded-inference の token は null のまま 0 で埋めない（提案 22）。呼び出し回数は収集した InferenceTask 数など実測だけにする。
- 既定の `scores.json` を profile 違いや未完了 run で上書きしない（提案 26/27 のまま）。`--output-dir` を使う。

## 検証（採用 / 不採用）

`bun run verify`。単体試験で、複数課題のうち missing record・不正 schema・source error を混ぜても全件の status が一覧に残り、`complete` は false、`meanScore` は null、未採点を 0/10 で埋めないこと。同じ payload の記録再生は同じ評点。handle の記録を BM25 で流用すると digest 不一致で pending になること（既存の inputDigest 束縛）。旧 5 件 handle 再生は平均 4.2、BM25 再生は平均 8.6 のまま。新しい LLM 評点は作らない。

## よくなったとみなす条件

失敗や欠落が平均を押し上げず、別 profile / 別 suite / 別指示の記録を同一評価として混ぜられないことです。

## 悪化したとみなす条件

既知の再生評点が変わる、未採点を含む平均を出す、error 課題を落として complete 平均を出す、token の null を 0 にする、既定 `scores.json` を壊す、のいずれかです。その場合は戻します。

## やらないこと

検索順位の変更、軸別 judge（34）、日本語 query 改革（28/29）、探索 SKILL（32/33）、出力トークン削減（36）、LLM 評点の作成や補完、キーワードによる意味分岐、費用ゲート、本番 ContextStill の品質主張、提案 01/16 の実ユーザー pilot の代替。提案 36 の未追跡ファイルは触らない。

## 依拠（コード）

`examples/contextstill/scenario-runner.ts`、`scenario-eval.ts`、`recorded.ts`、`src/eval/scenario-score.ts` の指示と schema、既存の recorded-inference digest。

## 実装結果

測定基盤として採用（Skill 品質や本番 ContextStill 検索の改善は主張しない）。

- `scenario-runner.ts`: 課題ごとに search / 実行 / judge を独立。`source.search` 例外でも残件の status が残る。status は `scored` / `awaiting_build_inference` / `awaiting_judge` / `invalid`（judge 記録はあるが schema 不合）/ `error`。`meanScore` は全件 scored のときだけ。
- 報告 `identity`: `searchProfile`・suite id・suite/seed ファイル SHA-256・`digest(buildInstructions)` / `digest(JUDGE_INSTRUCTIONS)` / `digest(judgeOutputSchema)`。課題ごと `recordProvenance` と実測だけの `usage`（token は null のまま）。
- 再生（新 LLM 評点なし）: handle 既定 suite は 5/5 scored・meanScore **4.2**。BM25 記録再生は meanScore **8.6**。handle 記録を `--search-profile bm25` で流用すると digest 不一致で `awaiting_build_inference`（scored にならない）。
- 試験: `examples/contextstill/test/scenario-runner.test.ts`（source 例外の分離、invalid judge、欠落時 incomplete、identity 填充、handle→bm25 非流用）。`bun run verify` 通過。
