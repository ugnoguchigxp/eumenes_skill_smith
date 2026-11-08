# 手動の保守・配布手順

対象はSkillSmithコアとSQLite adapter。CIは追加しない。ホストへの組込み、稼働サービスの操作、製品DBの更新は別の受入を要する。

## 変更と依存の確認

1. 作業差分を確認し、対象commitと未コミット変更を記録する。利用側の公開port、LLM指示・schema・rendererのidentityに影響するかを確認する。
2. `bun install --frozen-lockfile --ignore-scripts` で固定版を導入する。依存を更新する場合は必要な修正版を指定し、package.jsonとbun.lockを一緒に変更する。
3. `bun audit --json` と `bun pm licenses --json` を保存する。警告は対象版・利用経路・外部入力からの到達性を調べる。検出0件を安全性の保証にしない。
4. 変更に関係する部分試験、保存・配布の結合試験、最後に `bun run verify` を実行する。macOS/Linuxの実行条件と結果を分けて残す。

2026-11-08には、直接runtime依存Zod 4.4.3が[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)の対象として検出された。Zodは公開入力、モデル出力、保存データの検証経路から呼ばれる。ライブラリ側のbyte/件数制約はあるが、呼出し側が上限を検証する前の大きな不正配列を渡し得るため、非該当とはしなかった。修正版4.6.6へ更新し、互換試験と再auditを実施した。詳細は[依存検査記録](dependencies-2026-11-08.json)に残す。

## 成果物を確認する

```sh
bun run verify
bun scripts/check-boundaries.ts
bun scripts/measure-storage.ts
```

verifyはbuild後にpackする。buildはソース・package.json・bun.lock・compiler設定・buildスクリプトを指紋にし、成功時だけ `artifacts/build-input.json` を作る。packは現在の入力とdistのhashを照合し、古い入力、改変、追加ファイル、symlinkを拒否する。生成中の入力変更も拒否する。

tgzのMANIFEST.jsonと外側の `artifacts/manifest.json` を照合する。外側のsha256はtgz全体、内側のfilesは梱包した各ファイルのhashである。sourceGitCommitは基準commit、sourceGitDirtyは未コミット変更の有無、sourceDigestとbuildInputDigestは実際の入力を表す。dirtyな配布物を基準commitと同一と扱わない。署名・公開サーバー・自動更新の検証は未実装である。

`src/test/release.test.ts` は隔離コピーで古いbuild、出力改変、不要DB、symlinkを拒否し、抽出した配布物の公開APIから生成・結果報告・通知ackを確認する。これは実Eumenesのqueue・権限wrapperへの組込み試験ではない。

## 保存形式の更新と回復

SQLite migrationはホストが適用IDを管理し、単一writerのtransactionで順に適用する。適用前にホスト標準のbackupを取得し、対象DBと復元方法を確認する。コア自身はDBを開かず、migration実行・backup・commitも行わない。

- `knowledge/0001-init` は不変。既存DBへ再実行しない。
- `knowledge/0002-history-lookups` はJSON式索引だけを追加する。結果・候補の既存JSONを変更しない。索引の再実行は安全で、移行前の行と壊れたJSONも固定試験で確認する。
- 更新途中の失敗はtransactionをrollbackし、適用IDを成功として記録しない。再開時は未適用IDから再実行する。
- 配布を戻す場合も、権限修正前の危険な版へ戻さない。追加索引は旧版の読取りを妨げない。保存形式・指示identityが不適合な旧成果物は、明示的な拒否を維持する。
- 機能を使わない間は、ホスト側で新規submitと配達を停止し、保存済みのpending/delivery/forget残件を既存の復旧機構で扱う。稼働ホストでの無効化・切戻しは未検証である。

子プロセスをSIGKILLする8つの固定試験は、開始予約、予算予約、応答後、保存途中、commit後、配達後、ack後、forget後を確認する。外部側の成功が不明な処理を成功と推定しない。ホストの忘却journalを復元DBへ再適用する受入は、本体接続後に別途必要になる。

## 性能と実LLM評価

`measure-storage.ts` は対象外100/1,000/10,000行、対象0/1/8行、接続を開き直す条件とwarm条件を各200回測る。p95 10 ms以下、1,000→10,000行の増加2倍以下、対象外JSON解析0を実行前の条件とする。接続coldはOSページcacheのcoldを意味しない。これは合成履歴参照であり、生成・実ホストの代表負荷へ一般化しない。

追加の実LLM予算は10 USD。ローカルLLMは使わない。保存済みのクラウド接続をbackendのsettings操作で読み取り、既存keyが無い場合は作成せず停止する。DBはread-onlyで開くため、設定の正規化で書込みが必要な場合も勝手に移行しない。credentialは同じbackendプロセス内でのみ利用し、成果物へ保存しない。

実行前に [課題](practical-suite.json)、[モデルと料金条件](cloud-eval-strong-settings.json)、出力先を固定する。料金は[OpenAI公式料金表](https://developers.openai.com/api/docs/pricing)の標準料金を使い、予約はbyte上限と出力token上限から10倍の余裕を取る。明示的なcache write・外部tool・自動retryは使わない。不明な費用は予約を解放せず、API応答のusageが得られたものだけ実測tokenへ精算する。実請求書との照合は別作業である。

```sh
bun examples/contextstill/practical-eval.ts --run \
  --settings docs/quality/cloud-eval-strong-settings.json \
  --suite docs/quality/practical-suite.json \
  --host /path/to/eumenes \
  --out artifacts/new-planning-run \
  --journal artifacts/practical-2026-11-08/costs.jsonl
```

同じ費用journalは同時に使わない。正常終了でjournalのlockを除く。異常終了時は処理が残っていないこととcosts.jsonlを確認してからlockを除去する。条件を変えて出力先を分ける場合も、同じ10 USD枠ならjournalを共用する。失敗した入力はfailures.jsonに残し、同じ条件で自動再送しない。実践課題は公開知識から新規作成した計画回答の課題で、実ユーザーの履歴や実環境での作業成功ではない。回答側へgoldの参照・詳細な期待解を渡さず、生成後に別モデルで採点する。生成品質・回答の採点・実利用の効果を分けて記録する。

APIアダプターは[公式の構造化出力仕様](https://developers.openai.com/api/docs/guides/structured-outputs)のroot object・全項目requiredという制約に合わせ、resultで包み、optionalをnullableとして送る。ZodのoneOfはprovider側でanyOfへ写し、返却時はschema上のoptional-nullだけを省略へ戻す。hostのZod検証・長さ・列挙・必須項目・配列構造は緩めない。意味の解釈や特定課題への修正は行わない。JSON modeの初回試行は生成構造不正と400エラーがあり、合格の証拠にしない。API専用形式に変更した試行とは記録を分ける。

再採点だけを行う場合は `rejudge-plans.ts` を使い、元の回答・条件と旧判定を残す。採点指示は背景と回答を分離した `plan-judge.ts` に置く。8例の較正はroot担当が作成した回帰例で、人手評価ではない。原判定の混同と再採点の差は比較結果へ残す。

providerが拒否したlookaroundは送信schemaからだけ省き、hostの元schemaで強制する。providerが無視する文字列長は機械的な長さpatternへ写す。受信は2 MiBまでで中断し、receipt欠落を拒否する。途中終了でもusageがあれば費用を計上する。並行処理の予約が一時的に枠を占める場合は精算を待ち、取消時は追加通信しない。

比較の各runのtoken・時間は回答処理だけを測る。方式全体には一度だけ行った準備を加える。採点・診断・失敗費用は総予算へ含め、方式間の運用費用とは分ける。初期の不適合な評価設定は診断履歴として保持し、推奨既定や品質の根拠にはしない。

生成だけの再検証は `--generation-only` と [追加承認後の設定](cloud-eval-generation-settings.json) を使い、新しい出力先を指定する。2026-11-08の追加承認で累計15 USDとなったが、過去のjournalと未知費用の予約を保持する。生成と実行の前提を分けた採用版は13/20。短縮目標版は不採用である。[結果](generation-results-2026-11-08.md)と証拠を確認し、過去の条件を現行の品質点へ自動転用しない。
