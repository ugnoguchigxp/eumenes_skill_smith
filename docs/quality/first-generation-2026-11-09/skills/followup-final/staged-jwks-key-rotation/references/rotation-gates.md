以下は標準Pythonだけを使う未実行の合成モデルである。登録失敗時の保全、世代競合、キャッシュ未到達での切替拒否、受理期限までの保持を静的に照合するための例であり、DBの原子性・JWT暗号検証・SDKの動作は検証しない。権限のある呼出側が任意に実行し、全assert成立で正常終了、違反時はAssertionErrorとなる。数値はfixture専用で実環境のTTLではない。

```python
from copy import deepcopy

base = dict(gen=0, signer='old', keys={'old'},
            ready=False, stopped=False, deadline=None)

def publish(s, expected, stored):
    t = deepcopy(s)
    if expected != s['gen'] or not stored:
        return t
    t['gen'] += 1
    t['keys'].add('new')
    return t

def switch(s, expected):
    t = deepcopy(s)
    if (expected == s['gen'] and 'new' in s['keys']
            and s['ready']):
        t['signer'] = 'new'
    return t

def retire(s, expected, now):
    t = deepcopy(s)
    if (expected == s['gen'] and s['signer'] == 'new'
            and s['stopped'] and s['deadline'] is not None
            and now > s['deadline']):
        t['keys'].discard('old')
    return t

# 登録失敗は先行更新も含めて残さない。
assert publish(base, 0, False) == base
p = publish(base, 0, True)
assert p['keys'] == {'old', 'new'} and p['signer'] == 'old'
# 同じ世代を基にした二つ目の要求は変更しない。
assert publish(p, 0, True) == p
# キャッシュ未到達なら署名は切り替えない。
assert switch(p, 1) == p
p['ready'] = True
s = switch(p, 1)
assert s['signer'] == 'new' and s['keys'] == {'old', 'new'}
# 期限不明、発行停止未確認、期限内、世代競合は撤去しない。
assert retire(s, 1, 200) == s
s.update(stopped=True, deadline=120)
assert retire(s, 1, 120) == s
assert retire(s, 0, 121) == s
assert retire(dict(s, stopped=False), 1, 121)['keys'] == {'old', 'new'}
assert retire(s, 1, 121)['keys'] == {'new'}
```

実装では世代照合と状態変更の不可分性、公開集合の生成、全発行元の停止確認を別途実証する。この例の正常終了を対象環境の合格とは扱わない。