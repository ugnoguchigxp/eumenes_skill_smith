これはPython標準機能だけで期待値の整合を照合する未実行の例であり、Zodの代替実装や対象環境の合格証拠ではない。version、limit、範囲1〜3は合成入力専用。未知キーは拒否、旧版は明示変換という例示方針であり、対象の確定仕様ではない。承認された実契約のケースに置き換え、同じ期待値を実際の受信検証にも適用する。

```python
import json
from copy import deepcopy

# 合成契約の期待値モデル。成功出力は常にversion=2。
def expected(raw):
    if not isinstance(raw, dict):
        raise ValueError('object')
    version = raw.get('version')
    if type(version) is not int:
        raise ValueError('version')
    if version == 1:
        if set(raw) != {'version', 'size'}:
            raise ValueError('keys')
        data = {'version': 2, 'limit': raw['size']}
    elif version == 2:
        if set(raw) != {'version', 'limit'}:
            raise ValueError('keys')
        data = dict(raw)
    else:
        raise ValueError('unsupported')
    if type(data['limit']) is not int or not 1 <= data['limit'] <= 3:
        raise ValueError('limit')
    return data

cases = [
    ('positive', {'version': 2, 'limit': 2}, {'version': 2, 'limit': 2}),
    ('missing', {'version': 2}, None),
    ('unknown', {'version': 2, 'limit': 2, 'extra': 0}, None),
    ('lower', {'version': 2, 'limit': 1}, {'version': 2, 'limit': 1}),
    ('upper', {'version': 2, 'limit': 3}, {'version': 2, 'limit': 3}),
    ('below', {'version': 2, 'limit': 0}, None),
    ('above', {'version': 2, 'limit': 4}, None),
    ('wrong-type', {'version': 2, 'limit': '2'}, None),
    ('old-supported', {'version': 1, 'size': 2}, {'version': 2, 'limit': 2}),
    ('old-invalid', {'version': 1, 'size': 0}, None),
    ('unsupported', {'version': 0, 'limit': 2}, None),
    ('future', {'version': 3, 'limit': 2}, None),
]
for name, payload, want in cases:
    wire = json.loads(json.dumps(payload))
    before = deepcopy(wire)
    try:
        got = expected(wire)
    except ValueError:
        got = None
    assert got == want, (name, got, want)
    assert wire == before, name
print('期待値モデル: 全ケース一致')
```

終了条件：全assert成立で正常終了し、不一致はAssertionErrorで失敗する。合格表示の対象はこの期待値モデルだけで、TypeScriptの型推論、Zodの挙動、プロセス間通信は未測定のまま。