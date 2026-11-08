これはPython標準機能だけの未実行fixtureであり、製品APIの模造ではない。パスは既に意味が確定した文字列と仮定し、正規化処理は含めない。許可されたローカル環境で実行する場合、全assert通過で終了コード0、違反時はAssertionErrorによる非0終了を期待する。

```python
import json

# 合成入力。configPathは同じで、文脈ごとに期待設定が異なる。
a = ('/work/a', '/shared/config', ('/plugins/a', '/plugins/common'))
b = ('/work/b', '/shared/config', ('/plugins/b', '/plugins/common'))
c = (a[0], a[1], tuple(reversed(a[2])))
expected = {'a': {'owner': 'A'}, 'b': {'owner': 'B'}}

def key(context):
    root, config, plugins = context
    return json.dumps([root, config, list(plugins)], ensure_ascii=False)

# 負例：configPathだけでは後の書込みが先の値を上書きする。
legacy = {}
legacy[a[1]] = expected['a']
legacy[b[1]] = expected['b']
assert legacy[a[1]] != expected['a']

# 正例：各要素とプラグイン順序の差を保持する。
assert key(a) != key(b)
assert key(a) != key(c)
assert key(a) != key(('/work/other', a[1], a[2]))
assert key(a) != key((a[0], '/other/config', a[2]))
cache = {key(a): expected['a'], key(b): expected['b']}
assert cache[key(a)] == {'owner': 'A'}
assert cache[key(b)] == {'owner': 'B'}
# 片側を無効化しても他方を残す。
del cache[key(a)]
assert key(a) not in cache
assert cache[key(b)] == {'owner': 'B'}
```

終了条件は全assertの通過。実製品の並行性、設定変更検知、可変オブジェクト共有、パス解決はこの例では検証しない。