標準Pythonだけを使う未実行の合成例。将来、許可されたローカル環境で判定設計を点検するときに読む。対象APIやDOMを模造するものではなく、ブラウザーからの抽出・アクセシブル名計算・応答制御は検証しない。すべてのassert通過が終了条件で、違反を見逃すとAssertionErrorになる。

```python
from copy import deepcopy

# (操作または到着イベント, 観測された表示)
expected = [
    ('open', 'loading'), ('resolve', 'success'),
    ('reopen', 'loading'), ('reject', 'error'),
    ('retry', 'loading'), ('resolve', 'success'),
    ('reopen', 'loading'), ('close', 'closed'),
    ('late-resolve', 'closed'),
    ('reopen', 'loading'), ('close', 'closed'),
    ('late-reject', 'closed'),
]

def panel_ok(trace):
    return trace == expected

# id、名前、説明IDは観測記録、wantとerrorsは承認済み期待値。
fields = [
    dict(id='email', name='メール', want='メール', desc=['e1']),
    dict(id='limit', name='上限', want='上限', desc=['e2']),
]
errors = {'e1': ('email', '形式が不正'), 'e2': ('limit', '範囲外')}

def form_ok(rows, messages):
    ids = [r['id'] for r in rows]
    if len(ids) != len(set(ids)):
        return False
    for r in rows:
        if not r['name'] or r['name'] != r['want']:
            return False
        linked = r['desc']
        if any(k not in messages for k in linked):
            return False
        if any(messages[k][0] != r['id'] for k in linked):
            return False
        needed = {k for k, v in messages.items() if v[0] == r['id']}
        if not needed.issubset(set(linked)):
            return False
    return all(owner in ids for owner, text in messages.values())

assert panel_ok(list(expected))
bad = list(expected)
bad[8] = ('late-resolve', 'success')
assert not panel_ok(bad)  # 閉じた後の再表示を拒否
bad = list(expected)
bad[4] = ('retry', 'error')
assert not panel_ok(bad)  # 再試行が取得中へ進まない
assert form_ok(fields, errors)
for key, value in [('name', '別の名前'), ('desc', ['e2']), ('desc', [])]:
    bad_fields = deepcopy(fields)
    bad_fields[0][key] = value
    assert not form_ok(bad_fields, errors)
clean = deepcopy(fields)
for row in clean:
    row['desc'] = []
assert form_ok(clean, {})  # エラー解消後
assert not form_ok(fields, {})  # 消えた説明への参照が残る
print('合成記録の判定例: 合格')
```

この例では説明をエラーだけに限定している。実画面の通常ヘルプは別に扱い、エラー解消時に削除しない。新旧リクエストの競合、ラベル構造、計算済み説明は本文の実画面観測で別途判定する。