# 公開知識seed

ContextStillから取得した公開範囲の知識6,957件を収録しています。リポジトリ所有者の公開許可に基づき、コード・ドキュメントと同じ[MIT License](../../../LICENSE)で提供します。生成したSQLiteを配布せず、このseedから検索索引を含むDBを作成します。

```sh
bun run context:seed
bun run context:check
```

既定の生成先は `data/contextstill/seed.sqlite` です。既存DBへの上書きには `--replace` が必要です。

```sh
bun run context:seed --replace
bun run context:seed --dest /absolute/path/seed.sqlite
```

元DB、ContextStillの稼働サービス、認証情報は不要です。Bunとインストール済みのプロジェクト依存だけで動きます。固定モデルによる接続確認であり、実LLMによる指針の適合判断や検索品質を証明するデータセットではありません。

## 内容と形式

- `knowledge.jsonl.gz`: gzip圧縮されたUTF-8 JSONL。`record: knowledge` は公開投影された知識、`record: conflict` は収録知識同士の未解決競合ペアです。
- `manifest.json`: 形式版、ライセンス、件数、圧縮ファイルと展開後データのSHA-256、展開後byte数、対象ソース版・取得時刻、省略範囲です。現在は知識6,957件、経験0件、競合ペア0件です。
- 出典はrole/sourceKindだけです。経験、経験から作られた事例、設定、認証情報、鍵、元ログ、raw source、出典の本文・URL、埋込み、personal、repo限定データを含めません。知識の本文・条件・例外・手順は保持しています。

入力は `global` scopeと `coding/general/eumenes` spaceに限定します。初期化時にはハッシュ・件数・schema・公開範囲・重複handle・後継参照・競合参照を検査します。FTS索引は初期化時に再構築します。作成は一時DB上で完了させてから原子的に配置し、既存の無関係なDBは `--replace` があっても上書きしません。試験用DBを開いている場合は閉じてから再生成してください。

本文にはエージェント向けの指示文も含まれますが、実行権限を持たない参考知識として扱います。疑似APIの制限と本番との差は[上位README](../README.md)に記載しています。

## seedの更新

公開対象を更新するときだけ、ローカルの投影DBから明示的に書き出します。元DBを直接公開seedへ渡すことはできません。

```sh
bun run context:snapshot --replace
bun run context:seed:export --source data/contextstill/snapshot.sqlite
bun run test:examples
```

`context:snapshot` だけPython 3を使います。書出しは知識に限定し、経験と経験由来の事例を除きます。同じ投影DBからは同じseedを生成します。公開する本文とmanifestの差分を確認してからcommitしてください。生成済みSQLiteの更新は `bun run context:seed --replace` で行います。
