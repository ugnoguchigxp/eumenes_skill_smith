# 単体試験用の疑似ContextStill

SkillSmithの実装・検証を、Eumenes本体、ContextStillの稼働サービス、APIキーに依存せず進めるための例です。実データのSQLiteコピー、公開MCPの一部を再現する処理、SourcePortへの接続例、固定モデルを使う通し確認を含みます。実LLMの意味判断や本番検索品質の評価には使いません。

## 最初に動かす

プロジェクトのルートで実行します。Bun 1.4.4を使用し、コピー処理だけPython 3の標準ライブラリを使います。

```sh
bun install --frozen-lockfile
bun run verify
```

verifyは固定データから一時DBを作ります。コピー済みDB、隣のContextStillリポジトリ、通信、待受ポートは不要です。新しい試験だけなら次を実行します。

```sh
bun run test:examples
```

この作業環境には `data/contextstill/snapshot.sqlite` を作成済みです。コピーした実データで、検索 → 本文取得 → 固定モデル → SkillSmith保存 → 外部依存の再検査を確認できます。

```sh
bun run context:check
# 別のDB・検索語を使う場合
bun run context:check /absolute/path/snapshot.sqlite 検証
```

出力は件数・状態・消費回数だけです。本文とtokenは出力しません。`model: fixed_wiring_stub` は接続確認専用の固定出力を意味します。検索語で候補が見つからない場合や接続に問題がある場合は終了コードを失敗にし、固定データで代替しません。

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

保存先ディレクトリは0700、DBは0600で作ります。`fixture_metadata` に形式、取得時刻、コピー件数、対象ソース版、省略範囲を記録します。実データは `.gitignore` の `data/` に置き、Gitとコア配布tgzには含めません。別環境のGrokbotにはローカルコピーが自動共有されません。同じ作業フォルダを使うか、許可した方法でDBを移すか、その環境で再生成してください。固定試験だけなら実データの受渡しは不要です。

## 構成と利用方法

| ファイル | 役割 |
| --- | --- |
| `snapshot.py` / `schema.sql` | 公開範囲のコピー、専用DB形式、FTS索引 |
| `contracts.ts` | 現行の検索・取得引数、返却契約と試験用拡張 |
| `database.ts` | コピーをread-onlyで開き、文字列検索・取得・サイズ制限を行う |
| `mcp.ts` | RequestをResponseへ変換するプロセス内の疑似MCP |
| `source.ts` | 疑似MCPをSkillSmithのSourcePortへ接続する試験用adapter |
| `host.ts` | 一時SQLite、固定モデル、試験用権限・jobによるホスト例 |
| `check.ts` | コピー済みデータでの通し確認。通信・listenを禁止 |
| `test/` | 合成データ、コピー処理、公開範囲、契約、変更検知、保存結合の固定試験 |

利用例は次のとおりです。`transport` を注入し、HTTPサーバーを起動せずにAPI境界を検査します。

```ts
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";

const fixture = new ContextStillFixture("data/contextstill/snapshot.sqlite");
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
| 検索 | 分かち書き、SQLite trigram FTSと短い文字列の部分一致。一致後はhandle順。実検索の複数lane・重み・埋込み順位は再現しない。`mock_lexical_only/vector_unavailable` を返す |
| theme/depth | themeで絞り込まず `theme_unavailable` を返す。depth>0では `expansion_unavailable`。意味に応じた専用分岐は持たない |
| 本文と出典 | 各フィールドは知識8,000／経験4,000 Unicode文字を上限に、応答サイズに合わせて縮める。出典の詳細は常に省略。evidenceSummaryは表示した出典リストの件数 |
| `_fixture` | この例だけの必須拡張。公開投影本文のSHA-256、revision、`complete` を返す。completeは投影した本文・出典リストに追加の切詰めがないという意味で、元の出典詳細があるという保証ではない |
| 変更検知 | 検索カードと取得の版を合わせ、validateでハッシュ・状態・省略を再確認する。元サービスからのリアルタイム失効通知はない |
| SourcePort | 条件・例外・trust・省略内容を未信頼データとして渡す。既存portは検索全体のwarnings/degradedを渡せない。この不足を本文のfixtureLimitationsに明記する。製品接続前にport契約を検討する |
| モデル | host.tsの固定出力は接続確認だけ。実モデルによる適合判断、指針の品質、成功率・費用は未評価 |

現行の実ContextStillには `_fixture` がないため、このadapterを本番接続に転用できません。実adapterでは本文の版固定、本文省略の判定、検索の競合・degraded情報の受渡しを別途確定してください。現行コアが不完全な根拠を採用しない条件を弱めて合わせないでください。

元DBを直接この例へ渡すと、専用形式がないため拒否します。既存コピーの更新は再生成・差し替え後にインスタンスを開き直してください。再検査は開いたコピー内の変更に対するもので、元DBの後続変更には追従しません。
