# 計測手順（ContextStill mock の SKILL 組み立て評価）

正式な計測の入口は次の 1 コマンドです。外部 LLM は呼ばず、記録済みの採点と検索のみの結果を集計します。

```
bun run context:scoreboard          # 表
bun run context:scoreboard -- --json  # JSON（digest や出典ファイルはこちらだけ）
```

## 区分（課題 61 件、suite-3axis）

| 区分 | n | 測るもの |
|---|---|---|
| retrieval/original | 5 | 当初の課題文で、該当 Skill を検索で引き当て、本文として使えるか |
| retrieval/exact | 16 | 題名どおりの問い合わせでの検索的中 |
| retrieval/en | 16 | 英語言い換えでの検索的中 |
| retrieval/jp | 16 | 日本語言い換えでの検索的中 |
| compose | 4 | 複数 Skill を合わせた手順を組み立てられるか |
| absent | 4 | seed に該当が無い課題で、公式 Skill を捏造せず探索手順を出せるか |

retrieval 区分には hit@8（主）と hit@20（診断用）を出します。retrieval/original の SKILL 点は seed-skill-assembly の記録（scores.json / scores-bm25.json）を課題 ID で対応させています。

## 条件（2 列）

- handle: assembly baseline・evidence natural・言い換え off・弃権対比 off
- bm25: 検索だけ BM25、他は同じ

compact、oracle、言い換え on / multi、弃権対比は診断用で、この表には入れません。

## 点数の扱い

- SKILL 点は LLM 判定による 0〜10 の暫定値で、人手で較正していません。
- 平均は「区分 × 条件」ごとに、その区分の全課題が採点済みのときだけ出します。区分や軸をまたいだ平均は出しません。
- 品質改善を主張する資料ではありません。

## 未測定

- retrieval/exact・en・jp の SKILL 組み立て点（handle・bm25 とも）
- absent の BM25 の SKILL 点
- provider の入出力トークン

## 検索結果の再生成

```
bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json \
  --axis retrieval --query-style {original|exact|en|jp} --search-profile {handle|bm25} --output-dir <dir>
```

出力を `examples/contextstill/scenarios/retrieval-{style}-{profile}.json` として置きます。
