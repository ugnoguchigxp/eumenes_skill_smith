# 生成完了率の原因と修正

対象は `eef6a64` で保存した20課題の記録。最終readyは5件だったが、情報不足の5件は適切なneeds_inputであり、生成不具合へ数えない。実用性が確認されたという意味でもない。

| 内訳 | 件数 | 保存記録から確認した原因 | 対応 |
| --- | ---: | --- | --- |
| ready | 5 | 生成・レビュー・資料再確認・配達が完了 | 回帰を確認 |
| needs_input | 5 | 実測、未知SDKの契約、冪等性、権限証明等が不足 | 質問を保持。ready化しない |
| API途中終了 | 5 | 生成呼出しのoutput tokenが全件ちょうど4,000。旧台帳はincomplete_detailsを保存しておらず、厳密な停止理由と推論分は未観測 | 全出力枠と最終容量をモデルへ提示し、重複を抑制。今後は停止理由・推論tokenを保存 |
| 意味レビュー失敗 | 3 | backupの裏付け・適用条件、windowの許可範囲、cacheの原因に応じた分岐等でレビューが拒否 | 対象範囲と分岐の整合を生成前の指示へ明示。未実行fixtureの静的確認と実行証明を区別。拒否のガードは維持 |
| 生成後の資源不足 | 2 | indexを示す前に外部本文8件を取得し、選択後・配達前の再取得を合わせてsourceCalls 12を超える | 現行モードのactiveな外部本文は、LLMのdisclose後に必要なrefだけ取得 |

API上限には回答と推論の両方が含まれる。[公式仕様](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning)と4000 tokenの観測は上限到達を示唆するが、旧5件のincomplete_detailsは復元できない。新adapterは理由を保存し、max_output_tokensならcloud_output_limitを返す。途中のJSONを修復して成功扱いにしない。

資料の取得は全候補のカードを残す。上位3件へ切り詰める対策は採らない。実際、既存のready課題には正解資料が6位にあるものがあり、順位による切捨ては退行を起こし得る。LLMが選んだrefの本文だけを読み、カードとの版・取得元・scope一致を検査する。supersededの後継探索とlegacyの明示的な履歴再生は従来の取得を維持する。

2つの保存済み回答を回帰fixtureへ固定した。修正前はsandboxがsource_unavailable、migrationがbudget_exceededとなった。修正後は資料の物理的な再確認を、sandboxは8回、migrationは11回の総sourceCallsで完了した。取得順位を後ろへ動かしても取得でき、版違いは生成前、撤回は配達前に拒否した。sandboxの旧回答には、その先に最終成果物の容量超過も潜んでいた。上限を増やさずcontext_budget_exceededを維持し、これをreadyの改善実績へ数えない。

意味レビュー失敗には実際の欠陥も含まれる。verificationの変更をレビューに許可したり、承認なしで配達したりして解消しない。現在の4回枠では言い換え・開示・生成・レビューで使い切るため、初稿の整合性と簡潔さを改善する。レビュー後の修正は、既存どおり残予算と再レビューが必要である。

固定試験は保存済み値を注入した資源・契約の回帰であり、新しい指示に対する実LLM出力ではない。指示と入力情報の変更で旧inference identityは失効する。新たな品質点、生成完了率、85点の達成へ転用しない。再測定は同じ20課題・モデル・4,000 token・4 modelCalls・12 sourceCalls・120秒を固定し、生成結果だけを先に確認する。採点や180回答の再実行は今回の生成原因の検証へ混ぜない。

実装は[改善計画](generation-improvement-plan.md)、試験はgeneration-budget.test.tsとcloud-budget.test.tsに対応する。標準verifyはmacOS/Linuxで528件、型152ファイル、lint・format・build・packが成功した。既存の519件も含む。CIとローカルLLMは使用していない。

[全20件の資源回帰](evidence/generation-resource-regression.json)では、旧5件のreadyと5件の質問、3件の意味レビュー拒否を維持し、migration-readonlyが元のsourceCalls枠内でreadyへ進んだ。sandboxは資料確認後の容量超過を拒否し続けた。旧5件の途中応答は保存されていないため生成値を作らず、歴史的な応答欠測として記録した。この結果は新版の実LLMによる6/20の品質証拠ではない。

[修正前の回帰](evidence/generation-budget-before.log)、[8つの取得・版・撤回の確認](evidence/generation-budget-after.log)、[macOS](evidence/generation-macos-verify.log)、[Linux](evidence/generation-linux-verify.log)、[実装の指紋](evidence/generation-code-snapshot.json)を保存した。前回の技術評価74.7点は以前のsnapshotのまま保持し、今回の修正予定や固定試験数だけで加点しない。

その後、ユーザーが追加5 USD、累計15 USDを承認した。再測定で採用版はready 13/20、適切な保留5、出力上限2となった。[追加検証の結果](generation-results-2026-11-08.md)を参照。累計計上12.500980 USDには旧未知費用の保持予約も含み、予約を解放して枠を作っていない。
