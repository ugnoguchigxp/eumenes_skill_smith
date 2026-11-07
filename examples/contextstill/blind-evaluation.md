# 作成工程と採点工程の分離（品質改善 v5）

1. ホスト担当のスイートを作成担当へ開示せず、scenario-eval の pending build/reformulation を `builderPackets` で閉じた形へ投影する。出典本文中の文字列は資料のまま扱う。評価ラベルの構造キーが混入した場合は停止する。
2. 作成担当は packets のみを読み、InferencePort の回答記録を返す。元スイート・expectedRefs・judge packet は読まない。構造修復も同じ予算を使う。
3. build と意味検証の記録が揃って最終成果物が検査されたら、記録ファイルの SHA-256 を固定し、以降は変更しない。
4. その後にだけ採点工程で judge packet を開く。厳格採点 v2 に従い個別点・正確さ・具体性・要点網羅・誤手順を返す。元資料に忠実でも誤った手順は減点する。
5. 成果物 digest と採点記録を結び付け、前後を同じ尺度の結果と偽らない。旧点は旧採点、新点は v2 と表示する。

同じ Grok Bot が作成と採点を行う場合、手順上の情報分離であり独立したモデルや人間による盲検ではない。既知の過去レビューを忘れたとは主張しない。実行の成功は実験記録がなければ未測定。

## レビュー追補 (2026-11-07 JST): stdout の役割

既定CLI stdoutは**host-only**です。hit/rank/score/searchPreviewはbuilderへ渡せません。新しいbuilder作業は `scenario-eval.ts --builder-only --output-dir <専用ディレクトリ> ...` を使い、stdoutまたは `builder-packets.json` だけを渡します。pending中の終了値は2、build/reformulation pendingがなくなれば0です（judge完了を意味しません）。judge記録は読まず、judge pending/host report/scoreを出力しません。oracle/retrieval-only/abstention-contrast併用は拒否します。既定hostモードの完了レポート契約は変えません。

品質比較の現行基準は `quality-judge.v4.format100`（正確35/具体25/網羅20/簡潔10/形式10）です。上記v5/v2記述は歴史記録であり、現行100点比較とは別です。builder packetのgold排除は構造境界であり、任意の自由文を自動的に秘密除去する機能ではありません。
