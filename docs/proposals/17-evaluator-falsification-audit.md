# 評価器そのものに負例監査をかける

## 目的

評価キットが改竄・欠測・条件の不公平を改善として報告しないようにします。キットの機能追加そのものではなく、既存キットの信用を検査する実験です。

## 現状の問題

事実: eval CLI は canned の結果 JSON を読み、inputDigest を検証せず製品や baseline を実行しません。digest を改竄しても CLI の出力が同じになることをローカルで再現しました。baseline は constraints / environment / policy を省略し、製品より弱い構造検査です。`faithfulnessOverlap` は token 集合の重なりであり、未分節の日本語では意味的 faithfulness ではありません。`calibrateJudge` は一致率であり、ARES の judge 訓練ではありません。推定: いま出している数値には誤認のリスクがあります。

## 提案

supplied runner を実製品の execute と既存 baseline へ結ぶ小さい contract fixture を作り、共通 executor の入力 manifest を照合します。records の missing / tamper / wrong-condition / duplicate を必ず失敗にする検査を追加します。task の constraints / environment / policy の差を除きます。評価結果 JSON の fixture と推論 record を明示的に分けます。意味反転・引用の取り違え・日本語の評価負例を置き、overlap の名前を「字面一致」へ正します。

## 検証（採用 / 不採用）

採否は試験通過だけでは決めません。人手ラベルのない semantic 判定は未確定のまま残します。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

改竄はすべて検出されること、無記録の ready が 0 であること、A / B / C に同じ課題条件と下流権限を渡すこと、同一 manifest / record の再生が同じ結果になることです。

## 悪化したとみなす条件

baseline を意図的に弱めること、replay の不一致を fixture で埋めること、評価器の都合で受入判定が変わることです。

## やらないこと

新しい巨大な eval framework を作りません。即時の ARES judge 訓練をしません。全指標を一つの「品質点」へ圧縮しません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `examples/contextstill/eval-kit.ts`、`src/eval/kit.ts`、`src/eval/baseline.ts`、`src/eval/metrics.ts`、既存の `recorded.ts`（exact-input 照合はあるが CLI には未接続）。論文: [Ragas](https://arxiv.org/abs/2309.15217)、[ARES](https://arxiv.org/abs/2311.09476)。

## 依存・前提

既存の recordedInference、runEvalSuite、baseline でリポジトリ内実装が可能です。コーパスの前に負例監査はできます。提案 16 の公平比較の前提です。
