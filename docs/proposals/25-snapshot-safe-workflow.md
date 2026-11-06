# workflow を snapshot 型の保存に戻し、観測付き成否対比を試す

## 目的

提案 12 の「成功要約から一候補を生成」のあと、await を跨ぐ保存を既存 reflection と同じ安全な lifecycle に揃え、要約だけより観測付きの成否対比が良いかを分けて試します。

## 現状の問題

事実: workflow 推論は権限が無効になったあとも保存できます。非同期の transaction lifecycle が、既存の安全な reflection 操作と違います。SQLite の `blocked()` は効きますが、authority の失効は保存を止めません。試験は非同期 callback を同期 transaction ラッパへ渡しています。対比要約には report digest / revision / peer 根拠のリンクが不足しています。`reportsByBuild` は parse-all-then-filter です。workflow 経路は caller の「成功」要約を取り、action / observation の軌跡ではありません。未測定: workflow の転移効用。

## 提案

workflow も、prepare / reserve を同期保存し、推論は transaction の外、最新の authority / report / 根拠 / receipt を照合して同期保存する、既存 reflection 型へ揃える案を試します。成功と称する caller 文字列だけでなく、報告 digest / revision、明示的な action / observation / 結果を持つ fixture を用意します。成功要約のみ対、観測付きの成功 / 失敗対比を比較し、引用した peer 根拠も派生の依存閉包へ記録します。生成物は proposed のまま残します。永続的な全課題 insight engine はこの時点では作りません。安全修正と意味改善の採否は別記します。

## 検証（採用 / 不採用）

推論中の権限 / epoch 変更、peer 訂正、根拠の忘却、二重要求 / 再開、同じ失敗を成功要約だけが隠す課題を実行します。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。品質が下がる、または長文化だけなら対比追加は不採用とし、lifecycle の安全化だけを残します。

## よくなったとみなす条件

stale 保存が 0、重複候補が 0、根拠削除が派生へ伝播し、観測付き方式が held-out 課題の過剰一般化 / 誤適用を減らすことです。

## 悪化したとみなす条件

要約より品質が下がること、または長文化だけであることです。その場合は対比追加を不採用とし、lifecycle の安全化だけを残します。

## やらないこと

成功の自己申告を実証済みと呼びません。非公開の思考を trajectory として要求しません。workflow を新しい自動実行 tool へ変換しません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開、費用上限によるゲートは行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/service/results.ts` の workflow 保存と reflection、`src/eval/workflow.ts`。論文: [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)、[ExpeL](https://arxiv.org/abs/2308.10144)、[Reflexion](https://arxiv.org/abs/2303.11366)。論文自身の ablation でも reflection 追加が悪化する例があるため、すべての reflection を足すことは推奨しません。action-space 拡張は見送ります。

## 依存・前提

既存の reflection 操作を再利用できます。構造部分はコーパスなしで着手でき、品質比較は観測付き record と提案 16 の held-out 課題が必要です。P4 は不要です。仮定: 思考を含まない観測 / action 記録を用意できること。
