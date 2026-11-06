# 実課題の戦略別・棄権別 pilot を実行する

## 目的

Skill なし / Agent Skills 型 / SkillSmith を同じ実行器へ渡し、reuse / adapt / compose / provisional の効用と、needs_input の妥当さを実課題で測ります。これは提案 01 の未実施部分（実タスク測定）を一度だけ扱う項目です。

## 現状の問題

事実: 提案 01 は比較ハーネスとスキーマだけを入れ、実ユーザー課題コーパスと品質スコアは未用意のまま部分採用です。reuse / adapt / compose / provisional の効用は混在し、needs_input の妥当さも未集計です。未測定: (C) 対 (B) および対 (A) の達成率、適切な棄権と過剰棄権、戦略別の成否。

## 提案

ユーザーが利用を認めた実課題 10〜20 件を、目的・受入条件・期待結果付きで固定します。成功既知 / 条件変更 / 複数根拠 / 根拠不足に層化し、(A) なし、(B) Agent Skills 型、(C) SkillSmith を同じ executor へ渡します。匿名化だけで外部送信許可とみなしません。結果に actual strategy、適切な棄権 / 過剰棄権、受入条件別の成否を後付けの人手ラベルで付けます。judge は既存の較正関数を使い、一部の held-out 人手判定と照合します。

## 検証（採用 / 不採用）

(C) 対 (B) だけでなく対 (A) も paired で表示します。採否は「試験が通った」だけでは決めません。小 pilot に統計的決着を装いません。差が不明なら保留、悪化ならその strategy を縮小します。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

特定の strategy で受入達成が上がり誤適用が増えないこと、または達成が同等で呼び出しと token の負担が減ることです。

## 悪化したとみなす条件

合成が達成を下げること、または過剰棄権が増えることです。その場合はその strategy を縮小します。

## やらないこと

架空の「実課題」を作りません。固定モデル出力を実測品質として計上しません。judge の自己評価だけでの採用をしません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/eval/task.ts`、`src/eval/compare.ts`、`src/eval/baseline.ts`、`src/eval/judge.ts`。論文: [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)、[ARES](https://arxiv.org/abs/2311.09476)、[Self-RAG](https://arxiv.org/abs/2310.11511)、[ToolLLM](https://arxiv.org/abs/2307.16789)。10〜20 課題で ARES 並みの精度や統計保証は主張しません。

## 依存・前提

仮定: 適切な実課題と評価者を得られること。前提: 提案 17・18 の安全と評価整合を先行。本体の P4 待ちは不要です。実ユーザー課題コーパスと人手評価者が必要です。

## 実装結果

- **採否**: 部分採用（ハーネス拡張のみ）。実課題 pilot 実行は未実施。
- **内容**: EvalRunResult に `actualStrategy` と人手/judge の `abstention` ラベル欄を追加。比較 deltas に `acceptanceAdvantageVsNone`（C対A）、`strategyCounts`、`abstention` 集計を追加。架空の実課題コーパスや品質スコアは作っていない。
- **パス**: `src/eval/task.ts`, `src/eval/compare.ts`, `src/test/eval-compare.test.ts`
- **試験**: `bun test src/test/eval-compare.test.ts`（4 pass）
- **未実施**: ユーザー実課題 10〜20 件の収集、戦略別・棄権別の人手評価、合成縮小判断
- **理由**: 測定枠は揃えたが、コーパスなしでは「よくなった」条件を満たせない。
