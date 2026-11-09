# 承認済みSKILLの選択・配達

初回生成に `Ports.assemblyMode: "lean"` を選ぶと、候補本文の先読みと、本文・監査を分ける生成を利用できます。意味審査と最終配達の版確認は引き続き必要です。ホストごとに明示選択する方式で、生成指示の版が異なる承認済み登録は互換として扱いません。[初回生成の実測と接続範囲](quality/first-generation-2026-11-09/results.md)を参照してください。

`skillsmith.delivery.v1`は本文を一度だけ返す公開契約です。既存の`get`、`getValidated`、`getSkillValidated`は互換入口として保持します。`getSkillDelivery`は主ファイル、全references、digest、bundleDigest、requestRef、auditRef、依存版だけを返します。`submitArtifact`（またはrequestの`delivery: "artifact"`）で新方式を指定した生成は、実際に返す応答全体へ容量上限を適用し、分割欠落を許可しません。指定しない旧生成は内部JSONの従来の容量判定も保持します。`getSkillAudit(auditRef, ...)`は別途、元要求のprincipal・scope・epochと現在性を検査します。監査には独立した最大bytes（既定32KB、明示指定は256〜131072）を適用し、小さい公開応答の上限へ内部記録を重ねません。

## 保存と承認

ホストが既存のmigration台帳で`knowledge/0003-approved-skills`から`knowledge/0005-approved-search`まで適用し、`Ports.approvedSkills`を渡すと再利用が有効になります。省略したホストの既存の生成処理は変わりません。SQLite adapterは同じwriter transactionを使い、独自にcommitしません。`0005`で既存登録の検索索引を作成し、以降の追加・更新・削除と同じtransactionで同期します。

```ts
import { sqliteApprovedSkills } from "eumenes-skill-smith/sqlite";

const approvedSkills = sqliteApprovedSkills({
  authorizePublication(tx, authority, publication) {
    // 所有domainの承認台帳で、publication.digest / scope / applicability /
    // approvalRefと、承認した本文・resourcesが一致することを照合する。
    return ownerApprovals.authorizes(tx, authority, publication);
  },
  approvalCurrent(tx, publication) {
    return ownerApprovals.current(tx, publication.approvalRef, publication.digest);
  },
});
```

`ownerApprovals`はホスト所有の接続点を表す例です。Eumenesにこの名前のAPIが存在するという意味ではありません。二つのcallbackを無条件trueにした例は評価fixture専用で、製品の承認実装には使用しません。生成成功・形式検査・元buildの実行成功だけでは公開承認を代替しません。

登録は既存のjobで生成と意味レビューを終え、参照コードの検証、適用範囲・本文・resourcesの承認を確定した後に行います。

```ts
const publication = write(tx => service.publishSkill(tx, {
  buildRef,
  approvalRef,
  applicability, // 承認した適用条件・制限。意味はLLMが読む。
}, authority));
```

登録はmanageと元buildのbuild権限を要求し、承認は新しいpublicationのdigestと共有scopeに結び付きます。公開されるのは承認済みbundleであり、元利用者のrequestやBuildへの閲覧権限を共有しません。登録後の本文変更は認めず、新しい承認・新しいrefで再登録します。

## 利用の手順

1. `prepareSkillSelection`で現在の依頼・権限と候補をスナップショット化する。
2. `selectSkill`をtransaction外で一回実行する。本文生成を行わず、InferencePortでrefと短い適用判断、またはmissを返す。選択専用の`Ports.selectionInference`を指定すると、推論とreceiptの照合にそのportを使う。省略時は既存の`Ports.inference`を使う。
3. selectedの場合だけ、writer内の`bindSkillSelection`で再照合する。新利用者のrequestとBuildを保存し、元の厳密キャッシュキーを維持する。
4. `getSkillDelivery`で外部資料版も再確認し、本文とreferencesを実際に取得してからreadyとして扱う。
5. missなら`submitAfterSkillMiss`へ渡す。直近に不適合と判定された承認済み本文を、厳密キャッシュから再配達しない。利用できる新規生成済みの厳密キャッシュがなければ既存の生成jobを登録する。pendingは利用可能なSKILLの配達成功に含めない。

```ts
const prepared = read(tx => service.prepareSkillSelection(tx, request, authority));
const selection = await service.selectSkill(prepared, {
  signal,
  reserve: hostCommittedReservation,
  noteUsage: hostPersistObservedUsage,
});
if (selection.decision.kind === "selected") {
  const accepted = write(tx =>
    service.bindSkillSelection(tx, prepared, selection, authority));
  const packet = await service.getSkillDelivery(
    accepted.requestRef!, authority, read, signal, deliveryContext);
  // packet.kind === "ready"でのみ全bundleを利用側へ渡す。
} else {
  write(tx => service.submitAfterSkillMiss(tx, prepared, selection, authority));
}
```

`hostCommittedReservation`は外部推論前のホスト所有の永続予約です。選択中はまだBuildがないため、失敗・missを含むtoken・費用の計測はホスト台帳へ残します。bindしたBuildには選択のreceipt、判断、入力/出力tokenを保存します。未知tokenを0に置換しません。外部確認の`deliveryContext.reserve`は従来の`reserveDelivery`を使い、物理呼出しごとに予約します。

PreparedとSelectedは信頼されたホスト内の処理間データです。外部のcallerへ丸ごと公開せず、LLM入力にも`skillSelectionInput`の公開投影だけを使います。元のprivate Build、principal、評価専用条件はLLM入力へ含めません。Selectedは同じサービスで発行したものだけを結び付け、改変・別receiptへの付替え・JSONでの偽造を拒否します。クラッシュ後に選択中のオブジェクトを復元してbindしません。完了済みのrequest/Build/publicationは永続化され、通常取得で再開できます。未完了を自動で成功へ変更せず、ホストの明示的な新しい選択試行として計測します。

LLMは候補の原目的・制約と現在の受入条件を照合します。用途の追加、未確認条件、計画から実操作への変更はmissです。意味判定をキーワードや類似度の閾値へ移しません。コードはscope、policy、environment、必要能力の版一致、approval、epoch、source、expiry、bundleの整合性を強制します。選択指示の版が変わると、旧版で結び付けた再利用結果は再選択が必要になります。

SQLiteの`ApprovedSkillStore.scan`はscope、環境、受け手、方針、能力版、期限を候補数の制限前に絞ります。名前、適用範囲、元の目的を文字列索引で順位付けし、一致がなければ構造条件に合う新しい順で取得します。承認や失効で除外した候補はページを進めて補います。走査上限は既定256件、最大4096件です。候補枠が埋まる前に走査上限に達した場合は`catalog_scan_limit`を返します。`catalog.exhausted`は取得経路の候補を読み切ったかを示すもので、言い換えや同一テーマの登録が多い場合の網羅性は保証しません。既存の`list`のみのstoreも使用できますが、同じ絞り込みや補充は利用できません。

共有のために元のBuild認可は弱めません。新しい依頼は別のrequest/Buildになり、`bindUse`と`reportResult`も従来の実行所有権検査を使います。利用条件は新しいタスク結付けに保持し、本文の安定した制約を削除・昇格させません。内部Buildのtask欄は現在の依頼、配達する不変bundleはpublicationの正本です。再描画による無承認の本文変更を避けます。

## 失効と更新

publicationは元buildとapprovalRefへ依存リンクを持ち、結付けBuildはpublicationへリンクします。`forget`は根の失効を先に確定するため、消去が分割されても全依存先を直ちに配達不能にします。残りのpendingはホストが既存queueで消去します。承認失効、資料更新、方針変更、期限切れでもreadyを返しません。生成中の旧版を新しい承認版として代用しません。

外部版の確認は既存SourcePort.validateを維持しています。fixtureの全文getを製品の版一括APIだとは扱いません。取得にかかる実通信時間と、索引の現在性を保証する所有domainの契約は、本体接続時の受入項目です。

## 再現と計測

固定試験はネットワークを禁止し、改変・越権・失効・保存再開を検査します。有料の選択試験は`bun examples/contextstill/measure-approved-selection.ts OUTPUT_DIR`で明示実行します。元の15 USD累計台帳を排他で使用し、既存の未確定予約を保持します。新しい出力先が必須で、自動再試行しません。

同梱の評価は3件の凍結済み本文を記録再生で登録し、実クラウドの選択推論、永続SQLiteへの結付け、ローカル公開資料の版確認、全bundleの取得までを計測します。参照IDやpendingを返した時点では時計を止めません。登録数を9・1,000・10,000件に変えた測定と制約は[評価記録](quality/catalog-improvement-2026-11-09/results.md)を参照してください。
