Python標準機能だけの合成例。現在は実行しない。将来、許可されたローカル環境でのみ利用する。実システムのAPIや移行成功を模造せず、計画の操作区分だけを検査する。

```python
import json

fixture = json.loads('''{
  "today": ["plan"],
  "future_preflight": ["backup", "counts", "dry_run"],
  "cutover_approved": false
}''')

def valid_boundary(plan):
    return (
        plan["today"] == ["plan"]
        and set(plan["future_preflight"]) <= {"backup", "counts", "dry_run"}
        and plan["cutover_approved"] is False
    )

assert valid_boundary(fixture) is True
for forbidden in ("stop_daemon", "write_migration", "drop_old_tables"):
    bad = dict(fixture, today=["plan", forbidden])
    assert valid_boundary(bad) is False
bad = dict(fixture, future_preflight=["counts", "write_migration"])
assert valid_boundary(bad) is False
assert valid_boundary(dict(fixture, cutover_approved=True)) is False
print("文書境界fixture合格")
```

期待値は正常例のみTrue、全違反例はFalse。全assert通過時のみ表示して終了コード0、失敗はAssertionErrorで非0終了する。静的整合のみ照合済みで実行は未測定。この例は、実際の権限、backupの復元可能性、dry-runの無副作用性、DB件数一致を証明しない。