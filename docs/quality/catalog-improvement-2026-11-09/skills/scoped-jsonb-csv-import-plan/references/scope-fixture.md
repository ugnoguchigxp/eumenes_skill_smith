以下は標準Pythonだけの未実行fixture。CSV仕様・DB操作・seedを再現するものではなく、計画上の不変量を静的に照合する例である。Pathは実環境仕様とは無関係なキー列に限定する。権限のある呼出側が実行し、全assert通過で正常終了、失敗は例外終了となる。

```python
from copy import deepcopy

before = {
    ('alice', 'home'): {'theme': 'light', 'count': 2},
    ('alice', 'report'): {'theme': 'light'},
    ('bob', 'home'): {'theme': 'light'},
}
allowed = {('alice', 'home')}

def patch(rows, changes):
    out = deepcopy(rows)
    seen = set()
    for key, path, value in changes:
        token = (key, tuple(path))
        if key not in allowed or key not in out:
            raise ValueError('scope or missing row')
        if not path or token in seen:
            raise ValueError('empty or duplicate path')
        seen.add(token)
        node = out[key]
        for part in path[:-1]:
            if not isinstance(node, dict) or part not in node:
                raise ValueError('missing parent')
            node = node[part]
        if not isinstance(node, dict) or path[-1] not in node:
            raise ValueError('missing leaf')
        if type(node[path[-1]]) is not type(value):
            raise ValueError('type mismatch')
        node[path[-1]] = value
    return out

valid = [(('alice', 'home'), ['theme'], 'dark')]
expected = deepcopy(before)
expected[('alice', 'home')]['theme'] = 'dark'
assert patch(before, valid) == expected
assert before[('alice', 'home')]['theme'] == 'light'

bad_cases = [
    valid + [(('bob', 'home'), ['theme'], 'dark')],
    valid + [(('alice', 'report'), ['theme'], 'dark')],
    valid + [(('alice', 'home'), ['absent'], 'dark')],
    valid + [(('alice', 'home'), ['count'], 'wrong')],
    valid + valid,
]
for changes in bad_cases:
    snapshot = deepcopy(before)
    try:
        patch(before, changes)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid input accepted')
    assert before == snapshot
```

正例の期待値は指定キーのみの変更。負例の期待値は対象外ユーザー、対象外画面、存在しないpath、型不一致、重複を拒否し、入力状態を保持すること。実環境での配列・null・新規pathの許可は、このfixtureから推定しない。