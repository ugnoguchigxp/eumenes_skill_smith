将来、権限のある呼出側がPython 3で実行する、外部I/Oのない合成入力の検査例。ここでの識別子は正規化済みと仮定したテスト値であり、パス解決や実cache APIを模造しない。pluginの順序を保持する設計を検査する。実行はしておらず、静的な整合点検のみ。実APIのヒット・ミス、失効、並行性の合格を意味しない。

```python
import json


def key(workspace, config, plugins, revision):
    return json.dumps(
        ["config-cache-v1", workspace, config, list(plugins), revision],
        ensure_ascii=True, separators=(",", ":")
    )


config = "shared/config.json"
a = ("workspace-a", config, ("plugin-x", "plugin-y"), "r1")
b = ("workspace-b", config, ("plugin-x", "plugin-y"), "r1")
c = ("workspace-a", config, ("plugin-z", "plugin-y"), "r1")
d = ("workspace-a", config, ("plugin-y", "plugin-x"), "r1")
e = ("workspace-a", config, ("plugin-x", "plugin-y"), "r2")
cases = [a, b, c, d, e]
keys = [key(*case) for case in cases]
assert key(*a) == key(*a)  # 同一条件は同一キー
assert len(set(keys)) == 5  # workspace/plugin/順序/更新を分離
cache = {keys[0]: "A-XY-r1", keys[1]: "B-XY-r1"}
assert cache[key(*a)] == "A-XY-r1"
assert cache[key(*b)] == "B-XY-r1"
assert key(*c) not in cache
assert key(*e) not in cache

# 区切り文字の単純連結では衝突する負例
left = ("a|b", "c", (), "r1")
right = ("a", "b|c", (), "r1")
assert "|".join(left[:2]) == "|".join(right[:2])
assert key(*left) != key(*right)

# configPathだけの旧設計は必要な分離を満たさない
bad_keys = [case[1] for case in cases]
assert len(set(bad_keys)) == 1
assert len(set(bad_keys)) != len(cases)
print("fixture checks passed")
```

期待値は全assert成立、最後のメッセージ表示、終了コード0。assert失敗または例外なら終了して設計を見直す。負例は不適切なキーが衝突することを検出するためのものであり、採用する実装ではない。