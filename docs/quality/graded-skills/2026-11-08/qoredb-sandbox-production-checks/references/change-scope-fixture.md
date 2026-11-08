将来、権限のある呼出側で実行する標準Pythonだけの例。DBへ接続せず、合成データについて対象行の期待値と対象外の不変性を検査する。SQLの安全性、文数、制約、QoreDBの動作は検証しない。本回答では未実行であり、実データの合格を示さない。

```python
from copy import deepcopy

before = {1: {"status": "old"}, 2: {"status": "keep"}}
expected = {1: {"status": "new"}, 2: {"status": "keep"}}
approved_ids = {1}

def matches(actual):
    changed = {k for k in set(before) | set(actual)
               if before.get(k) != actual.get(k)}
    return actual == expected and changed == approved_ids

good = deepcopy(expected)
bad_value = deepcopy(expected)
bad_value[1]["status"] = "wrong"
bad_scope = deepcopy(expected)
bad_scope[2]["status"] = "changed"
bad_missing = deepcopy(expected)
del bad_missing[1]

assert matches(good) is True
assert matches(bad_value) is False
assert matches(bad_scope) is False
assert matches(bad_missing) is False
print("合成差分の正例1件・負例3件が期待どおり")
```

終了条件：全assertを通過して表示行に到達すれば正常終了。AssertionErrorなどの例外があれば失敗。実運用では挿入・更新・削除それぞれの承認対象と期待値を定義し、適切な一意キーで比較する。