# 技術品質改善の実装記録

対象は `47cfdf5e8d42ee19d59edb6e3d2e4bdc5c5fc85a` を基準とする作業差分。CIは変更しない。追加の実LLM予算は10 USDで、ローカルLLMは使わない。実装・固定試験・実践課題の採点・実製品の受入を区別する。85点は目標であり、実績として転記しない。

## 実装と固定検証

| 対象 | 変更と根拠 | 確認 |
| --- | --- | --- |
| Q01 認可 | request/executionの共通照合で、元principal・scope・epoch・sourceRefs・buildRef・executionRefを操作別の権限へ結ぶ | 9操作×6負例とreport-onlyの正常例。修正前に31件失敗、修正後に不正な変更0件。principal/epoch/参照のガードを外す負例も検出 |
| Q02 再現性 | 試験専用seed DB、一時パスの実体化、旧schemaの再生成診断、READMEのbm25/autoと全references保存を同期 | macOS既定TMPDIRとLinuxで標準verify。危険な出力先の拒否、旧DBの非変更、既存の作業DBのhash一致 |
| Q03 SQL | 0001を保持し、0002でJSON式索引を追加。対象条件をSQLへ移し、選択行だけを解析 | 移行・再実行・破損行隔離・report訂正・実query planを検査。対象外10,000行でも解析数は対象分だけ |
| Q04 責務 | 生成処理から検索・取得とusage集計を分け、生成と意味レビューの呼出し観測を共通化 | 予算・取消・絶対usage更新・canonical本文・identityの回帰試験。LLM指示やrendererのidentityは変更せず、API形式変換は例のadapterへ限定 |
| Q05 検出能力 | 実ソースのガードを隔離コピーだけで外す10種の負例 | principal、epoch、元参照、execution、予算、runToken、receipt、配達保存、取消、canonical本文の10/10を検出。構文エラーによる失敗は採用しない |
| Q06 復旧 | 別BunプロセスをSIGKILLし、実ファイルSQLiteを開き直す | 開始予約、予算予約、provider応答後、保存transaction中、commit後、配達後、ack後、forget後の8境界。予約を戻さず、保存途中はrollback、同じ通知IDで再送 |
| Q07 計測 | noteCallへ本文を含めないdurationを追加。失敗時の予約と観測usageを保持し、診断callbackの失敗前にもusageを保存 | 100/1,000/10,000行×対象0/1/8行×connection-cold/warm×200回＝3,600回。p95最大0.089875 ms、1,000→10,000行のp95倍率最大1.089。基準は10 ms以下・2倍以下 |
| Q09 配布・依存 | ビルド入力とdistの指紋、dirty表示、古いbuild/改変/混入拒否。Zodを既知問題の修正版4.6.6へ固定更新 | tgz抽出後の公開APIで生成→結果報告→通知ack。型151ファイル、コア359件・例160件の計519件成功。手動auditの再照会は0件 |

標準verifyは型・lint・format・コア/例の固定試験・build・packを含む。[macOS](evidence/macos-verify.log)、[Linux](evidence/linux-verify.log)、[違反検出](evidence/boundary-controls.json)、[性能の全測定値](evidence/storage-measurement.json)を保存する。LinuxはBun 1.4.4の使い捨てcontainerへソースをコピーし、frozen installから実行した。DB・設定・credentialはcontainerへ渡していない。測定値は合成履歴参照で、実ホスト負荷やOS cacheが冷えた状態を示さない。

## 実LLMの評価条件

ユーザーの追加指示に従い、ContextStillの公開知識から[20の実践課題](practical-suite.json)を構成した。再利用、条件変更、複数根拠、情報不足の各5件である。実ユーザーの利用履歴や実環境での作業ではなく、作業計画の回答を比較する。設計の20件・3方式・各3回という件数は維持する。

回答側には目的と公開の受入条件だけを渡し、参照の正解と詳細な期待解は生成後のjudgeへ渡す。Skillなし、既存のAgent Skills型の段階的開示、現行SkillSmithを同一executorで比較する。judgeはexecutorとは別のモデルとし、方式名を渡さない。候補の学習・正式採用、実環境の変更は行わない。

初回のJSON modeは構造不正と400エラーがあり、合格とは扱わない。API仕様に必要な構造化出力の変換を例のadapterへ追加し、元のschemaで再検証する。1,200 token条件で複数の応答が途中終了したため、その条件を完了・成功へ数えず保持した。生成4,000 token・回答2,000 token・4並行へ条件を固定し直した。生成のmodelCalls 4、sourceCalls 12、本文の上限、必須項目・意味レビューは維持する。過去の費用予約も同じjournalへ残し、未精算を0へ換算しない。

初期の180回答比較では生成readyが0件だった。接続試験用の読み取り制約を計画の生成へ引き継いだうえ、生成失敗後にSkillなしで回答する処理があり、有用性の比較として無効とした。生成側がneeds_input・unavailable・errorなら回答処理を呼ばず、その結果を伝える共通の実行契約へ修正した。

計画作成だけを行う制約を明示し、クラウドの生成モデルを固定し直した最終試行では、20課題中5件がready、5件がneeds_input、1件がunavailable、9件がerrorだった。errorは意味レビュー失敗3件、呼出し予算超過1件、API出力途中終了5件。11件が品質採点へ到達したが、全体の品質平均は算出しない。全20課題を現行コードで通信禁止の再生へ通し、状態と5成果物のdigestが一致した。5成果物に含まれる独立したコード例も、それぞれ隔離したBun/Pythonで成功した。実タスク環境での成功とは扱わない。

最終比較は20課題・3方式・各3回の180回答を保存した。生成済み5課題だけでSkillSmithの回答処理を実行し、残り45試行は元の質問・非完了を伝えた。回答段階のtoken・時間を方式全体の測定値と混同せず、準備費用を別途加える。生成時の共有queryは一度だけSkillSmithへ割り当てた実験条件であり、独立した本番料金ではない。

回答の旧judgeが依頼文の危険な要求を回答者の主張と誤認したため、旧合否率を結論へ使わない。背景・条件・評価対象を分ける共通指示へ修正し、別題材8例の否定・保留・将来計画・注入を照合した。8/8で想定と一致したが、これは同じ担当が作成したケースで、人手較正ではない。回答・条件を固定した再採点と旧判定の差を[比較結果](practical-comparison-final.json)へ記録する。実作業の効果・未知課題の証拠・優位性は未確立とする。

再採点は180件を完了した。1件の採点途中終了は、同じ回答・条件のまま採点出力枠だけ900→1,800へ増やして1回確認し、失敗費用も保持した。合否の参考値は42/60・52/60・30/60だが、別の2件に将来計画を成功断定と誤認する判定が残ったため、実成功率・安全性の違反率として採用しない。旧判定とbooleanが変わった回答は38件。これ以上同じ採点へ課金せず、未較正の限界を残した。

費用は失敗したAPI形式、途中終了、schema診断、旧採点、再採点も同じ10 USDのjournalへ含める。usageが得られない過去の呼出しは予約全額を残す。[比較結果](practical-comparison-final.json)のapi_budgetが最終集計で、実際の請求額とは区別する。

追加の検証では、診断callbackの例外で成功したsource呼出しを二重記録する不具合も再現し修正した。修正前は3件すべて失敗し、修正後は成功した。クラウドadapterには応答2 MiBの読み取り上限、receipt欠落の拒否、未精算費用の保持、一時的な予約不足での待機・取消を追加し、固定試験で確認した。

## 未完了と続行条件

- Q04の文字種によるauto選択、compactの85%近似コピー判定、蓄積した指示の整理は未完了。代替案の採用比較なしに削除・変更せず、専用の意味分岐を追加して今回の課題だけを通さない。
- Q06の製品DB復元後の忘却journal再適用、Q10の実ホストwrapper・queue・Registry search/currentは未検証。Eumenes `fb8eac06ba1e32891c51355c4e067d678e7fd555` を読み取った時点でもknowledge domainが無く、既存Skill単体のsearch/current接続は未確定だった。別作業の134項目の差分を変更せず、APIやjournalを模造して本体結合の証拠にしない。
- Q08はseed由来の計画回答と別モデルの採点であり、実作業の成功・人手較正・未知の最終testを完了したとはしない。
- Q09の稼働ホストでの無効化・切戻し・正式公開は未実施。独立consumerの固定試験と手動の保守手順までである。
- Q11の再評価は[暫定74.7点](re-evaluation.md)。同じlibrary profile・全30項目で再計算し、85点の達成は未確認のまま残す。

参照: [改善計画](../technical-quality-85-plan.md)、[手動保守・配布](manual-release.md)、[依存検査](dependencies-2026-11-08.json)。

固定した実LLMの回答・推論記録・採点・全費用journalは `artifacts/quality-evidence-2026-11-08.tgz` にまとめ、[ファイル指紋](evidence/practical-files.json)へ記録した。DB・設定key・credentialは含めない。以前の不成立の試行も元のローカル出力先へ保持している。

最終差分では課題の語句を判別する専用処理や固定回答を追加していない。認可、索引、予算、応答容量、外部APIのschema形式変換だけをコードで強制し、適合や棄権、採点の意味解釈はLLMへ残した。ContextStillはこの実装ラウンドで `context_compile` 1回、`compile_eval` 1回を実施した。
