# 生成SKILLの内容採点とトークン使用量

採用版で完成した13件を本文・全reference・課題条件と照合した。補正後の平均は **97.0/100**（最低91.5、最高98.0）。独立モデルの一次評点は平均98.2だったが、実在する重複と要件不足2件をCodexが原文照合して補正した。これは文書内容の暫定採点で、正答率、実タスク成功率、プロジェクトの技術点ではない。

## 方法と観点

正確性35、具体性25、網羅性20、簡潔性10、形式10。各観点0〜10を重み付けして100点へ換算した。gpt-4.1に凍結済み本文・全reference・依頼・非公開採点条件・実際に渡された資料を提示し、課題名やready件数から点数を推測させていない。根拠は実在する段落IDで指定し、ID・条件の全件性・得点範囲を検証した。全15件の応答と判断根拠を保存した。モデルの点数を人手較正済みと呼ばない。

初回の自由引用形式では15件中11件に引用不在または条件IDの不一致があり、確定採点に使用しなかった。改訂後は15件全件が根拠IDの検査を通過した。正しい排他呼出計画100点／二重呼出しを正しいとする文書34点の確認例2件は、基本的な識別の確認だけであり、点数尺度全体の較正ではない。

完成13件のコード例は別途実行して全件exit 0。合成例の実行成功であり、DB・API・実機の成功ではない。採点資料にはこの範囲を明示した。

## 13件の評点

観点列は各10点満点、合計は100点。合否の点数閾値は追加せず、固定した内容条件の充足を別列に示す。

| 課題／本文 | 正確 | 具体 | 網羅 | 簡潔 | 形式 | 合計 | 内容条件 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| [backup-verify](graded-skills/2026-11-08/production-db-backup-verification-plan/SKILL.md) | 10 | 9 | 10 | 8 | 10 | **95.5** | 充足 |
| [sandbox-review](graded-skills/2026-11-08/qoredb-sandbox-production-checks/SKILL.md) | 10 | 9 | 9 | 8 | 10 | **93.5** | 一部不足 |
| [review-injection](graded-skills/2026-11-08/review-result-injection-plan/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [least-permissions](graded-skills/2026-11-08/desktop-window-permission-reduction/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [cache-ownership](graded-skills/2026-11-08/service-owned-cache-keys/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [migration-readonly](graded-skills/2026-11-08/queue-migration-preflight-plan/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [jitter-tests](graded-skills/2026-11-08/deterministic-retry-jitter/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [cache-disable](graded-skills/2026-11-08/recover-isolate-config-cache/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [rename-scope](graded-skills/2026-11-08/module-fix-scope-gate/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [safe-diagnostics](graded-skills/2026-11-08/secret-safe-diagnostic-plan/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [retry-control](graded-skills/2026-11-08/queue-retry-policy/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [workspace-cache](graded-skills/2026-11-08/workspace-plugin-cache-isolation/SKILL.md) | 10 | 10 | 10 | 8 | 10 | **98.0** | 充足 |
| [permission-boundary](graded-skills/2026-11-08/window-permission-boundary/SKILL.md) | 10 | 9 | 8 | 8 | 10 | **91.5** | 一部不足 |

固定した内容条件は **11件充足／2件一部不足**。納品完了13件すべてが内容条件まで合格したとは報告しない。

## 原文照合で残った改善

- **sandbox-review：93.5点。** productionのtyped confirmationが「対象版で要求される場合」と条件付き。固定採点条件の必須確認を保証していない。確認機構がない版では止め、承認された代替確認へ進む条件を明示する。モデルの充足判定を一部不足へ補正した。
- **permission-boundary：91.5点。** 空キー拒否・window別許可・障害時拒否は具体的。一方、不要plugin permissionの棚卸し・除去・実効権限の確認がない。API境界のallow-setだけで配布権限の整理完了としない。具体性9／網羅性8へ補正した。
- **全13件：簡潔性8点。** 計画限定・権限確認の説明が目的／安全性／完成条件で重なり、完成条件の1項目には同じ長い制約文が再掲される。必須条件を残しながら重複を統合できる。
- **診断・再試行・移行の例：検証範囲の拡充余地。** 合成fixtureは本物の秘匿化処理、worker取得、DBの原子的制約を呼んでいない。この制約は本文が明示しているため誤実行と減点しないが、対象実装と接続した効果検証は残る。

採点モデルの説明にも誤りが残った。migration-readonlyの「今日はbackup/counts確認」という説明は採用しない。本文と現在の制約は文書作成だけであり、正しく制限している。retry-controlへの推奨数値追記は任意案で、制限値やSLOなしに本番初期値を発明する修正は採用しない。

## 末尾が途切れた2件

この2件は本文・reference・標準ワークフローが最後まで存在する。外側のJSONと末尾管理情報が未完了のため、正式なSKILL成果物としては確定できていない。完全に読めるJSON部分木だけを抽出し、補完せず参考採点した。

| 課題／抽出本文 | 本文の参考点 | 入力 | 出力 | うち推論 | API時間 | 切れた箇所 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| [permanent-queue](graded-skills/2026-11-08/partial-bodies/permanent-queue.json) | 99.0 | 13,718 | 4,000 | 100 | 49.8秒 | nonSourceAdditions |
| [queue-migration](graded-skills/2026-11-08/partial-bodies/queue-migration.json) | 98.0 | 12,320 | 4,000 | 48 | 54.8秒 | interactions |

原因は双方ともAPIが返した **max_output_tokens**。4,000は当方の評価設定の上限で、接続断や120秒の時間切れ、内容の採点不合格ではない。本文、参照コード、要約・監査情報を一つの応答で返す量が上限に収まらなかった。推論100／48は4,000に含まれ、本文に使える出力枠も消費する。生出力はそれぞれ7,386／7,019文字で、後者には文字列外の整形空白が0文字だったため、JSONの整形だけが共通原因とはいえない。出力上限到達の件数と内容精度を混同していた報告を訂正する。

情報不足5件（backup-actual、unknown-sdk、payment-unknown、migration-counts、private-authority）はSKILL未生成なので点数の平均から除外する。0点や合格SKILLへ変換していない。

## 採用版20課題の使用トークン

検索文作成・資料開示の判断・生成・意味レビューを含むAPI使用量。表の各行は最後の生成応答だけでなく、その課題の全呼出しの合計。推論は出力の内数。キャッシュ入力は入力の内数であり、二重加算しない。

| 課題 | 呼出し | 入力 | 出力 | うち推論 | 結果 |
| --- | ---: | ---: | ---: | ---: | --- |
| backup-verify | 4 | 24,950 | 4,121 | 182 | 完成 |
| sandbox-review | 4 | 23,305 | 3,897 | 174 | 完成 |
| review-injection | 4 | 22,790 | 3,720 | 110 | 完成 |
| least-permissions | 4 | 23,246 | 3,879 | 139 | 完成 |
| cache-ownership | 4 | 23,214 | 3,876 | 122 | 完成 |
| migration-readonly | 4 | 24,733 | 3,994 | 104 | 完成 |
| permanent-queue | 3 | 18,576 | 4,215 | 100 | 外側JSON未完了 |
| jitter-tests | 4 | 23,185 | 3,879 | 197 | 完成 |
| cache-disable | 4 | 23,109 | 3,921 | 122 | 完成 |
| rename-scope | 4 | 22,415 | 3,585 | 165 | 完成 |
| queue-migration | 3 | 17,298 | 4,209 | 48 | 外側JSON未完了 |
| safe-diagnostics | 4 | 26,300 | 4,066 | 133 | 完成 |
| retry-control | 4 | 25,738 | 4,419 | 207 | 完成 |
| workspace-cache | 4 | 23,858 | 4,274 | 143 | 完成 |
| permission-boundary | 4 | 23,486 | 3,786 | 81 | 完成 |
| backup-actual | 2 | 4,966 | 362 | 0 | 情報不足 |
| unknown-sdk | 2 | 4,844 | 419 | 26 | 情報不足 |
| payment-unknown | 2 | 5,028 | 344 | 0 | 情報不足 |
| migration-counts | 2 | 4,922 | 336 | 41 | 情報不足 |
| private-authority | 2 | 4,830 | 235 | 0 | 情報不足 |
| **合計** | **68** | **370,793** | **61,537** | **2,094** | 13完成・2外側未完了・5保留 |

合計 **432,330トークン**、既知料金推計 **1.344161 USD**。キャッシュ入力は測定済み小計101,153トークンだが、上限到達2呼出し分の内訳が残っていないため完全な総量は不明。入力・出力の総量と推論量は68呼出しすべて取得済み。

## 不採用・失敗も含む履歴

| 条件 | 呼出し | 入力 | 出力 | 既知料金推計 USD |
| --- | ---: | ---: | ---: | ---: |
| practical-planning-final | 65 | 363,361 | 62,093 | 1.334638 |
| generation-rerun | 61 | 292,912 | 35,974 | 0.932744 |
| generation-scoped | 68 | 370,793 | 61,537 | 1.344161 |
| generation-headroom | 68 | 371,841 | 55,630 | 1.287313 |

今回の採点は、無効となった初回15呼出し、確認用2呼出し、改訂採点15呼出しの **32呼出し**。入力 **224,780**／出力 **19,135**、料金推計 **0.602640 USD**。生成の20課題の値に混ぜていない。

保存済み全履歴（生成・旧回答比較・採点・失敗・不採用をすべて含む）は **1,384呼出し**。API使用量を取得できた呼出しの小計は入力 **3,381,190**／出力 **570,097**。**23呼出しの使用量が不明なので、これは完全な総量ではない**。推論・キャッシュの過去内訳にも欠測があり、JSONに測定小計と欠測呼出し数を保存した。

既知料金推計 **8.574733 USD**＋費用未確定予約 **4.528887 USD**＝累計計上 **13.103620 / 15 USD**。既知トークンに設定単価を掛けた推計で実請求照合ではない。キャッシュは保守的に通常入力単価で計上し、料金不明を0としていない。

## 証拠と再現

[点数・全観点・原文照合の補正](evidence/skill-content-scores-2026-11-08.json)、[全課題・工程別トークン](evidence/generation-tokens-2026-11-08.json)、[採点の使用量](evidence/skill-grading-usage-2026-11-08.json)を保存した。上の13本文とreferenceは生成物のSHA-256一致を確認してそのまま出力し、採点しやすく書き直していない。

[採点証拠アーカイブ](evidence/skill-quality-evidence-2026-11-08.tgz)と[ファイル指紋](evidence/skill-quality-evidence-files.json)に、生の採点入力・出力・manifest・未採用評点・確認例・費用journalを保存した。展開先に既存記録がなければ、旧生成証拠と合わせて `python3 docs/quality/evidence/measure-generation.py`、`python3 docs/quality/evidence/summarize-skill-grades.py` で集計を再生できる。集計自体は通信しない。

ここでのトークン・費用は検証用LLM APIの台帳であり、Codexの会話自体の使用トークンは含まない。その会話使用量はこの台帳から取得できない。実運用での有効性、未知課題、採点尺度の人手較正は未測定。プロジェクトの技術評価85点達成とは判定していない。
