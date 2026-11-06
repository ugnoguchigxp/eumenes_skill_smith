# 単体試験用の疑似ContextStill

SkillSmithの実装・検証を、Eumenes本体、ContextStillの稼働サービス、APIキーに依存せず進めるための例です。実データのSQLiteコピー、公開MCPの一部を再現する処理、SourcePortへの接続例、固定モデルを使う通し確認を含みます。接続確認と固定fixtureの評価キットは実LLMの意味判断や本番検索品質の証明には使いません。タスクシナリオでのSkill組み立て評点は `bun run context:eval-scenarios` を使います。

## 最初に動かす

プロジェクトのルートで実行します。Bun 1.4.4を使用します。同梱seedからの初期化にPython、ContextStill本体、元DB、APIキーは不要です。

```sh
bun install --frozen-lockfile
bun run context:seed
bun run context:check
bun run verify
```

verifyは合成データと同梱の公開seedから一時DBを作ります。コピー済みDB、隣のContextStillリポジトリ、通信、待受ポートは不要です。元DBから再コピーする処理の試験だけPython 3の標準ライブラリを使います。新しい試験だけなら次を実行します。

```sh
bun run test:examples
```

`context:seed` はGit管理されている[公開知識seed](seed/README.md)から `data/contextstill/seed.sqlite` を作ります。知識6,957件を収録し、経験と経験由来の事例は含めません。検索 → 本文取得 → 固定モデル → SkillSmith保存 → 外部依存の再検査を確認できます。生成済みDBを作り直す場合は `--replace` を明示します。

```sh
bun run context:check
# seedを再適用する場合
bun run context:seed --replace
# 別の場所に初期化する場合
bun run context:seed --dest /absolute/path/seed.sqlite
# 別のDB・検索語を使う場合
bun run context:check /absolute/path/snapshot.sqlite 検証
```


出力は件数・状態・消費回数だけです。本文とtokenは出力しません。`model: fixed_wiring_stub` は接続確認専用の固定出力を意味します。検索語で候補が見つからない場合や接続に問題がある場合は終了コードを失敗にし、固定データで代替しません。

## Skill組み立てのシナリオ評点

`context:check` の固定モデルと `context:eval` の固定fixtureは、期待Skillが正しく組み上がったかの評点ではありません。公開seed上の決められたタスクを通し、検索順位と組み立て結果を記録したうえで、LLM（Grok Botのrecorded-inference）が 0 から 10 で評点します。

```sh
bun run context:eval-scenarios
```

推論記録が足りない場合は `data/contextstill/scenario-build-pending.json` または `scenario-judge-pending.json` を書き、終了コード 2 で待ちます。記録を `examples/contextstill/scenarios/build-records.json` と `judge-records.json` に足して再実行すると、毎回評点を標準出力と `scenarios/scores.json` に出します。既定の検索は lexical かつ handle 順のため、期待Skillが候補に入らない課題は低得点になり得ます。それは検索品質の事実であり、固定出力で埋めません。

二つのモードがあります（提案 26）。

- `--retrieval-only`: SourcePort の検索だけを呼び、推論は 0 回です。期待 ref ごとの順位、全 ref が 8 位以内か（`allRequiredHitAt8`）、診断用の 20 位以内を出します。LLM 評点は出しません。absent 軸は N/A です。
- 既定（full）: 製品実行、recordedInference、記録済み LLM judge で 0〜10 を出します。一件でも未採点なら平均を出さず、課題ごとの状態を出して終了コード 2 にします。

```sh
bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json
bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json --axis compose
```

`--search-profile handle|bm25`（既定 `handle`、retrieval-only / full 共通）、`--axis retrieval|compose|absent`、`--query-style original|exact|en|jp`、`--output-dir` が使えます。新しい報告は既定で `data/contextstill/scenario-reports/` に書き、`scenarios/scores.json` は旧 5 件 suite の full 既定実行でだけ更新します。builder には goal と acceptance だけを渡し、期待 ref・題名・axis は judge だけが見ます。

順位比較の報告には `searchProfile` を記録します。profile 間の報告を残す場合は別々の `--output-dir` を使います。`context:check` / 固定fixture の検索は変更していません。BM25 は任意の測定用 profile です。旧5件 suite の full + LLM judge では平均 8.6（handle の 4.2 から上昇）で、3件は handle 順では needs_input だったものが指針を出せました。日本語はほぼ改善せず退行もあるため既定は handle のままです（[提案27の実測](../../docs/proposals/27-lexical-bm25-ranking.md)）。mock 検索は本番 ContextStill 検索と異なり、提案01/16の実ユーザーpilotではありません。再生は `examples/contextstill/scenarios/build-records-bm25.json` と `judge-records-bm25.json` を指定し、`--output-dir` を既定の `scores.json` とは別にします。

```sh
bun run context:eval-scenarios --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json --search-profile handle --output-dir data/contextstill/scenario-reports/handle
bun run context:eval-scenarios --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json --search-profile bm25 --output-dir data/contextstill/scenario-reports/bm25
bun run context:eval-scenarios --suite examples/contextstill/scenarios/suite.json --search-profile bm25 --build-records examples/contextstill/scenarios/build-records-bm25.json --judge-records examples/contextstill/scenarios/judge-records-bm25.json --output-dir data/contextstill/scenario-reports/bm25-full
```


## コピー内容と更新

これは元DBファイルの丸ごと複製ではなく、公開範囲の論理コピーです。2026-11-06に、ContextStillの版 `dd365e96115903626254a3d445ed5e097210a194` を参照し、知識6,957件・経験843件、42,860,544 bytesを保存しました。現在のコピーでは公開対象外の行を除いているため、元DBの全件数とは異なります。

- `global` scope、`coding/general/eumenes` space、非撤回で、公開取得できる知識・経験を保存します。検索はさらに `active/searchable` に限定します。`superseded/evidence_only` は取得のみ可能です。
- 状況、本文、理由、適用条件、非適用条件、例外、手順、公開経験への事例参照、版、状態を保存します。
- 出典はroleとsourceKindだけです。設定、認証情報、鍵、元の会話ログ、raw source、出典の本文・URL、metadata、埋込み、personal、repo限定の行は保存しません。公開知識そのものに含まれる文章は改変せずコピーします。
- 公開対象の後継参照と未解決の競合ペアを保存します。themeやグラフ検索は再現しません。

再生成する場合は以下を使います。既存コピーへの上書きには `--replace` が必要です。

```sh
bun run context:snapshot --replace
# コピー元が別の場所にある場合
bun run context:snapshot --source /absolute/path/context-still.sqlite3 --dest /absolute/path/snapshot.sqlite
```

コピー元の既定値だけが隣の `../contextStill/data/context-still.sqlite3` を参照します。コピー後の実行には元DB・元リポジトリは不要です。コピー元はread-only接続と読取transactionで読み、WALを含む整合した時点を取り出します。作業中は0600の一時ファイルを使い、完成後に原子的に配置します。元DBへの書込み、checkpoint、サービス操作は行いません。

保存先ディレクトリは0700、DBは0600で作ります。`fixture_metadata` に形式、取得時刻、コピー件数、対象ソース版、省略範囲を記録します。生成したSQLiteは `.gitignore` の `data/` に置き、Gitとコア配布tgzには含めません。知識だけの公開seedはGit管理します。別環境のGrokbotもclone後に `bun run context:seed` で初期化できます。経験843件を含むローカルコピーは自動共有されません。

## 構成と利用方法

| ファイル | 役割 |
| --- | --- |
| `snapshot.py` / `schema.sql` | 公開範囲のコピー、専用DB形式、FTS索引 |
| `seed/` | MITで提供する公開知識6,957件の圧縮JSONLと検証manifest |
| `seed.ts` / `export-seed.ts` | seed検証・SQLite初期化と、知識だけの明示的な再書出し |
| `contracts.ts` | 現行の検索・取得引数、返却契約と試験用拡張 |
| `database.ts` | コピーをread-onlyで開き、文字列検索・取得・サイズ制限を行う |
| `mcp.ts` | RequestをResponseへ変換するプロセス内の疑似MCP |
| `source.ts` | 疑似MCPをSkillSmithのSourcePortへ接続する試験用adapter |
| `host.ts` | 一時SQLite、固定モデル、試験用権限・jobによるホスト例 |
| `check.ts` | コピー済みデータでの通し確認。通信・listenを禁止 |
| `scenario-eval.ts` / `scenario-runner.ts` / `scenarios/` | 公開seed上のタスクシナリオ。retrieval-only は検索順位だけ、full は recorded-inferenceでSkillを組み立てLLMが評点する。`suite-3axis.json` は検索・複合・欠落の 61 件 |
| `test/` | 合成データ、コピー処理、公開範囲、契約、変更検知、保存結合の固定試験 |

利用例は次のとおりです。`transport` を注入し、HTTPサーバーを起動せずにAPI境界を検査します。

```ts
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";

const fixture = new ContextStillFixture("data/contextstill/seed.sqlite");
try {
  const token = crypto.randomUUID(); // 元サービスのtokenは使わない
  const transport = createMcpHandler(fixture, token);
  const source = createFixtureSource(transport, token);
  const cards = await source.search("検証", 8, new AbortController().signal);
  // ホストで ports.source = source として接続する。host.tsを参照。
} finally {
  fixture.close();
}
```

インスタンスのimportではDB・ネットワークを開きません。DBを閉じる責任は呼出元にあります。tokenはインスタンスごとのローカル値で、保存・表示しません。待受サーバーを起動するコマンドは用意していません。

## 実ContextStillとの差

これは実ContextStillの代替製品でも、MCP全体の互換実装でもありません。調査元は同版の `api/domains/mcp/service/{schemas,tools,evidence,conflicts}.ts` と関連repositoryです。

| 項目 | この例の保証・制限 |
| --- | --- |
| MCP | JSON-RPCのinitialize、initialized通知、ping、tools/list、tools/call、検索・取得をプロセス内で処理する。protocolVersionは2025-03-26。session、SSE、実HTTP、頻度・並行数制限は未実装 |
| 境界 | bearer、loopbackのHost/Origin、引数、32KiBの要求・応答を検査する。製品の認証・失効保証は含まない |
| 検索 | 分かち書き、SQLite trigram FTSと短い文字列の部分一致。一致後は既定handle順。scenario-evalでは `--search-profile bm25` で FTS5既定BM25昇順（同点handle順、2文字部分一致だけの候補は後方）を比較できる。実検索の複数lane・重み・埋込み順位は再現しない。`mock_lexical_only/vector_unavailable` を返す |
| theme/depth | themeで絞り込まず `theme_unavailable` を返す。depth>0では `expansion_unavailable`。意味に応じた専用分岐は持たない |
| 本文と出典 | 各フィールドは知識8,000／経験4,000 Unicode文字を上限に、応答サイズに合わせて縮める。出典の詳細は常に省略。evidenceSummaryは表示した出典リストの件数 |
| `_fixture` | この例だけの必須拡張。公開投影本文のSHA-256、revision、`complete` を返す。completeは投影した本文・出典リストに追加の切詰めがないという意味で、元の出典詳細があるという保証ではない |
| 変更検知 | 検索カードと取得の版を合わせ、validateでハッシュ・状態・省略を再確認する。元サービスからのリアルタイム失効通知はない |
| SourcePort | 条件・例外・trust・省略内容を未信頼データとして渡す。SourceSearchとして検索全体のwarnings（handleをrefへ変換）・degraded・truncatedを転送する（接続契約3.1） |
| モデル | host.tsの固定出力は接続確認だけ。実モデルによる適合判断、指針の品質、成功率・費用は未評価 |

現行の実ContextStillには `_fixture` がないため、このadapterを本番接続に転用できません。実adapterでは本文の版固定、本文省略の判定、実APIのwarnings・degraded語彙の照合を別途確定してください。現行コアが不完全な根拠を採用しない条件を弱めて合わせないでください。

元DBを直接この例へ渡すと、専用形式がないため拒否します。既存コピーの更新は再生成・差し替え後にインスタンスを開き直してください。再検査は開いたコピー内の変更に対するもので、元DBの後続変更には追従しません。
