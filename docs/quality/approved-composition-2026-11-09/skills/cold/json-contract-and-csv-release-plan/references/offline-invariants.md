以下は標準Pythonだけを使う未実行の合成例。権限のある呼出側が必要に応じて実行する。JSONの名称変更は架空の契約であり、対象環境の変換仕様ではない。CSV側も実DB・認可・トランザクションを実装せず、全件検証後に結果を返す境界だけを示す。実装・復旧・並行更新試験の代替にはならない。

```python
import csv
import io
from copy import deepcopy

# JSON経路：対象キーだけ変換し、他の値と元入力を保存する。
def migrate(old):
    if old.get('version') != 1 or 'timeout' not in old:
        raise ValueError('contract')
    if 'timeout_ms' in old:
        raise ValueError('collision')
    if type(old['timeout']) is not int or old['timeout'] < 0:
        raise ValueError('type')
    new = deepcopy(old)
    new['timeout_ms'] = new.pop('timeout')
    new['version'] = 2
    return new

old = {'version': 1, 'timeout': 10, 'extra': {'keep': True}}
snapshot = deepcopy(old)
assert migrate(old) == {
    'version': 2, 'timeout_ms': 10, 'extra': {'keep': True}
}
assert old == snapshot
for bad in [dict(old, timeout_ms=20), dict(old, timeout='10')]:
    try:
        migrate(bad)
    except ValueError:
        pass
    else:
        raise AssertionError('migration must reject')

# CSV経路：このfixtureは作成専用。既存キーの更新は拒否する。
def stage(text, approved_tenant, store):
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames != ['tenant', 'key', 'value']:
        raise ValueError('header')
    pending = {}
    for row in reader:
        if None in row or any(v is None for v in row.values()):
            raise ValueError('columns')
        if row['tenant'] != approved_tenant:
            raise ValueError('scope')
        key = (approved_tenant, row['key'])
        if not row['key'] or not row['value']:
            raise ValueError('empty')
        if key in pending or key in store:
            raise ValueError('conflict')
        pending[key] = row['value']
    if not pending:
        raise ValueError('empty batch')
    result = deepcopy(store)
    result.update(pending)
    return result

base = {('a', 'old'): 'keep', ('b', 'old'): 'other'}
before = deepcopy(base)
header = 'tenant,key,value\n'
assert stage(header + 'a,new,yes\n', 'a', base) == {
    **base, ('a', 'new'): 'yes'
}
for tail in [
    'a,new,yes\na,bad,\n',
    'a,new,yes\nb,new,no\n',
    'a,new,yes\na,new,no\n',
    'a,new,yes\na,old,no\n',
    'a,new,yes\na,x,y,extra\n',
]:
    try:
        stage(header + tail, 'a', base)
    except ValueError:
        pass
    else:
        raise AssertionError('batch must reject')
    assert base == before
assert base == before
print('offline assertions passed')
```

期待値は正例の厳密一致と負例の拒否・元入力不変。assert失敗または予期しない例外で不合格終了、全assert通過時だけ表示行に達して正常終了する。ここで成功しても対象環境の合格にはしない。