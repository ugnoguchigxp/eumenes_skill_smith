Python標準機能だけの合成入力による方針検査。未実行であり、対象キューやHTTP APIの実装ではない。秒単位の相対時刻を使い、hintは仕様に従って検証・秒換算済みのサーバー待機下限を表す。許可された呼出側が隔離環境で実行し、全assert通過なら正常終了、失敗ならAssertionErrorで停止する。

```python
from math import isfinite

# 設計例の値。対象環境の推奨値ではない。
def decide(kind, now, attempt, age, u=0.5, hint=None):
    assert attempt >= 1 and age >= 0 and 0 <= u <= 1
    assert isfinite(now) and isfinite(age)
    if kind == 'invalid':
        return ('quarantine', None)
    if kind != '429':
        return ('review', None)
    if attempt >= 4 or age >= 60:
        return ('exhausted', None)
    if hint is not None and (not isfinite(hint) or hint < 0):
        return ('review', None)
    backoff = min(16, 2 * 2 ** min(attempt - 1, 3))
    delay = max(1, backoff * u, hint or 0)
    if age + delay >= 60:
        return ('exhausted', None)
    return ('waiting', now + delay)

def eligible(decision, now):
    state, due = decision
    return state == 'waiting' and due is not None and now >= due

# 正例: サーバー下限を尊重し、期限到達時だけ取得可能。
d = decide('429', 100, 1, 0, u=0.5, hint=7)
assert d == ('waiting', 107)
assert not eligible(d, 106)
assert eligible(d, 107)
# 負例: 恒久不備・不明エラー・上限超過を取得しない。
for kind, attempt, age in [('invalid', 1, 0),
                           ('unknown', 1, 0),
                           ('429', 4, 0), ('429', 1, 59)]:
    result = decide(kind, 100, attempt, age)
    assert not eligible(result, 1000)
assert decide('429', 100, 1, 0, hint=-1)[0] == 'review'
# 下限と指数増加上限の境界。
assert decide('429', 100, 1, 0, u=0) == ('waiting', 101)
assert decide('429', 100, 3, 0, u=1) == ('waiting', 108)
```

実装側では別途、実際の取得処理が期限条件を適用すること、更新と所有権解放の原子性、重複配信時の冪等性、再起動後の期限保持を試験する。この例の通過だけではそれらは判定できない。