# 失敗・reasoning・補助推論を含む使用量台帳

## 目的

成功した最後の receipt だけでなく、失敗・reasoning・補助推論を含む使用量を説明できるようにします。再検索や開示で本当に効率化したかを判断するための台帳です。

## 現状の問題

事実: 無効なモデル出力などで系列が失敗すると、蓄積した token 合計が保存されません（`invalid_model_output` のあと tokens が null、modelCalls は 2 でも最後の receipt だけ残る）。reasoning token は契約にありません。delivery の validate I/O は request の sourceCalls 予約の外です。推定: 現在の効率比較は偏ります。未測定: 実総量と削減量（reasoning を含む）。

## 提案

評価 trace に各 call の input digest、call 種別、receipt、provider usage を保存し、成功・失敗・取消で集計します。reasoning / cached input / total は提供元が返す metadata のみ nullable で保存し、output に reasoning が含まれるかを明示して二重加算しません。build / reflection / workflow / delivery validate を別列にします。必要ならローカル契約を後方互換で拡張しますが、Eumenes の usage API の形は推測しません。

## 検証（採用 / 不採用）

2 回応答後の失敗、途中の null、reasoning の内包 / 別計上、cancel 後の usage 到着、receipt 失効、cache hit / delivery 再 validate を fixture で照合します。悪化した場合は変更を戻し、不採用の理由を本ファイルに追記します。

## よくなったとみなす条件

provider の原票と全試行の集計が一致し、不明を 0 にせず、同一課題の達成あたり使用量を説明できることです。

## 悪化したとみなす条件

usage 取得のため推論を増やすこと、欠測を推定で埋めること、意味挙動を変えることです。

## やらないこと

非公開の思考本文を保存・採点しません。token 数を金額へ無根拠に換算しません。費用上限のゲートを入れません。本番の ContextStill への接続、語句辞書やキーワードによる意味分岐、未確認の Eumenes host API の新設、自動正式公開は行いません。推論は Grok Bot が recorded-inference の継ぎ目を通して行います。

## 依拠（コード・論文）

コード: `src/contracts/` の使用量と receipt、`src/service/build.ts` のモデル呼び出し集計、delivery の validate。論文への新規依拠はありません。token 測定はユーザーの既存方針に応えます。

## 依存・前提

fixture から開始できます。実 reasoning metadata を持つ record は別途必要で、なければ null のままです。提案 16・20 の評価前提です。仮定: provider が usage を返すこと。
