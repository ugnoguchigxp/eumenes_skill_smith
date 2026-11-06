# レビュー指摘の修正案（review-fixes）

このディレクトリは 2026-11-06 のコードレビューで見つかった問題への修正案です。改善の検討課題は `docs/proposals/` にあり、ここの修正とは別です。

- `01-evidence-schema-boundary.md`: source.get / registry.read の Evidence を境界で Zod parse
- `02-sqlite-json-schema.md`: JSON.parse のまま型断言しない
- `03-instruction-version-digest.md`: INSTRUCTION_VERSION を指示本文の digest から導く
- `04-structural-repair.md`: checkDecision 失敗にも修復し、失敗コードを渡す
- `05-batch-validate.md`: validate を配列まとめて呼ぶ
- `06-dedupe-cross-source-refs.md`: local/external の同一 ref で build 全体を落とさない
- `07-successor-error-vs-missing.md`: 通信断と後継なしを区別し、可能なら後継の版を pin する
- `08-doc-drift.md`: 文書ドリフトの修正
- `09-bun-version-in-verify.md`: verify で bun 1.4.4 を確認する
- `10-configurable-limits.md`: 埋め込み定数を設定へ出す
- `11-cache-external-builds.md`: 外部依存でもキャッシュ可、配布前に既存の validate を使う
