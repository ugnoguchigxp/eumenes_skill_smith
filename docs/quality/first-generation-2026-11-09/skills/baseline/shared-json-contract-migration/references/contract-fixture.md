以下はPython標準機能だけで、試験データのJSON往復、分類の充足、期待結果の整合を検査する未実行例。Zodの代用品ではなく、対象コードの合格を示さない。versionとlimit、範囲1〜10、旧版拒否はこの例だけの仮定であり、実際には承認した契約から作り直す。成功時はassertをすべて通過して正常終了し、欠落した負例を意図的に作った場合は検査で検出する。

```python
import copy
import json

cases = [
    {'case': '正例', 'input': {'version': 2, 'limit': 5}, 'accept': True, 'output': {'version': 2, 'limit': 5}},
    {'case': '欠落', 'input': {'version': 2}, 'accept': False},
    {'case': '未知キー', 'input': {'version': 2, 'limit': 5, 'extra': 0}, 'accept': False},
    {'case': '境界下限', 'input': {'version': 2, 'limit': 1}, 'accept': True, 'output': {'version': 2, 'limit': 1}},
    {'case': '境界上限', 'input': {'version': 2, 'limit': 10}, 'accept': True, 'output': {'version': 2, 'limit': 10}},
    {'case': '境界下限外', 'input': {'version': 2, 'limit': 0}, 'accept': False},
    {'case': '境界上限外', 'input': {'version': 2, 'limit': 11}, 'accept': False},
    {'case': '旧版', 'input': {'version': 1, 'limit': 5}, 'accept': False},
]
expected = {
    '正例': True, '欠落': False, '未知キー': False,
    '境界下限': True, '境界上限': True,
    '境界下限外': False, '境界上限外': False, '旧版': False,
}

def check_matrix(rows):
    assert len(rows) == len(expected)
    assert {r['case']: r['accept'] for r in rows} == expected
    for row in rows:
        assert json.loads(json.dumps(row['input'])) == row['input']
        if row['accept']:
            assert row['output'] == row['input']
        else:
            assert 'output' not in row

check_matrix(cases)
broken = copy.deepcopy(cases)
broken[1]['accept'] = True  # 欠落ケースを誤って受理する期待値
try:
    check_matrix(broken)
except AssertionError:
    pass
else:
    raise AssertionError('負例の期待値破損を検出できなかった')
```

実契約の試験では同じ形式の各inputを実際の受信境界へ渡し、受理可否・検証後の値・不正時の利用処理呼出回数を別途照合する。この例にはその実測処理を含めていない。