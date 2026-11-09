以下はPython標準ライブラリだけを使う自己完結例。将来、権限のある呼出側で実行できるが、今回は未実行。各タプルは順に「パネル可視、取得中、成功内容、失敗表示、再試行可能」を表す。成功内容は、実テストでは文字列などの期待値も別途照合する。

```python
from copy import deepcopy

C = (False, False, False, False, False)
L = (True, True, False, False, False)
S = (True, False, True, False, False)
E = (True, False, False, True, True)

expected = {
    'success': [('initial', C), ('pending', L), ('settled', S)],
    'failure': [('initial', C), ('pending', L), ('settled', E)],
    'retry': [('failed', E), ('retry_pending', L), ('settled', S)],
    'close_success': [('pending', L), ('closed', C), ('late_settled', C)],
    'close_failure': [('pending', L), ('closed', C), ('late_settled', C)],
}

def verify(observed):
    assert set(observed) == set(expected), '経路不足または余分な経路'
    for route, wanted in expected.items():
        assert observed[route] == wanted, route

# 合成入力の正例：全経路が期待列と一致する。
fixture = deepcopy(expected)
verify(fixture)

# 負例：取得中の欠落、成功後のエラー残留、閉鎖後の再出現。
violations = [
    ('success', 1, ('pending', C)),
    ('retry', 2, ('settled', (True, False, True, True, True))),
    ('close_success', 2, ('late_settled', S)),
    ('close_failure', 2, ('late_settled', E)),
]
for route, index, bad_row in violations:
    bad = deepcopy(fixture)
    bad[route][index] = bad_row
    try:
        verify(bad)
    except AssertionError as error:
        assert str(error) == route
    else:
        raise AssertionError('違反を見逃した: ' + route)
print('合成観測列の正例と負例の検査終了')
```

期待値：正例を受理し、四つの負例をすべて拒否して終了する。例外なく末尾へ到達することがこの例の終了条件。実DOMの観測、非同期処理の排出、アクセシビリティ、応答順序制御は実装していない。`late_settled` は実テストで実際の処理完了境界を観測して初めて記録できる点であり、このfixtureからその到達を推定してはならない。