Python標準ライブラリだけで閉じた設計例。注文サマリを仮の用途とし、テナント・注文ID・元データ版を識別条件にしている。実サービスで必要な条件は本文の手順で別途決める。辞書はキーの分離を見るための合成入力の格納先であり、実際のcache API、TTL、通信や永続化を模造するものではない。コードは未実行。

```python
import json


def service_cache_address(tenant_id, order_id, revision):
    if not all(isinstance(x, str) and x for x in (tenant_id, order_id)):
        raise ValueError("nonempty string IDs required")
    if type(revision) is not int or revision < 0:
        raise ValueError("nonnegative integer revision required")
    namespace = "order-summary:v1"
    key = json.dumps(
        [tenant_id, order_id, revision],
        ensure_ascii=True, separators=(",", ":")
    )
    return namespace, key


address = service_cache_address("t1", "o1", 3)
expected = ("order-summary:v1", '["t1","o1",3]')
assert address == expected
assert service_cache_address("t1", "o1", 3) == address
assert service_cache_address("t2", "o1", 3) != address
assert service_cache_address("t1", "o2", 3) != address
assert service_cache_address("t1", "o1", 4) != address

# 単純な区切り文字連結では衝突する組も区別する。
a = service_cache_address("a:b", "c", 0)
b = service_cache_address("a", "b:c", 0)
assert a != b
assert json.loads(a[1]) == ["a:b", "c", 0]

# 名前空間と生成済みキーだけで値を識別できる。
store = {address: "summary-a", a: "summary-b"}
assert store[address] == "summary-a"
assert service_cache_address("t2", "o1", 3) not in store

# 負例は必ず拒否されることを期待する。
for args in [("", "o1", 3), ("t1", "o1", -1), ("t1", "o1", True)]:
    try:
        service_cache_address(*args)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid input accepted")

print("fixture passed")
```

期待値は全assert通過後の `fixture passed` と正常終了。assert失敗や例外なら不合格として生成規則を見直す。最適化によってassertを無効化せず実行する。この例の通過は実リポジトリや実環境の合格を意味しない。