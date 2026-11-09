これはPython標準機能だけの未実行fixture。進捗の連番復元、真正性判定後の作用境界、注文単位の重複排除、独立した合否の論理を検査する。実際の署名検証、並行性、DBトランザクション、外部発送APIは実装・検証していない。authは検証済みという合成入力であり、暗号検証の代用ではない。

```python
from collections import Counter


def restore(snapshot, events):
    version, state = snapshot
    pending = {}
    for seq, value in events:
        if seq <= version:
            continue
        if seq in pending and pending[seq] != value:
            return None
        pending[seq] = value
    while version + 1 in pending:
        version += 1
        state = pending.pop(version)
    return None if pending else (version, state)


def fulfill(events):
    seen, paid, committed = set(), set(), set()
    shipping = Counter()
    for auth, event_id, order, status in events:
        if not auth:
            continue
        if event_id in seen:
            continue
        seen.add(event_id)
        # このfixtureではpendingは古い通知、paidだけが発送資格。
        if status == 'paid':
            paid.add(order)
        if order in paid and order not in committed:
            committed.add(order)
            shipping[order] += 1
    return shipping


def release(progress_ok, fulfillment_ok):
    return progress_ok and fulfillment_ok


snapshot = (1, 'accepted')
assert restore(snapshot, [(3, 'packed'), (2, 'paid'),
                          (2, 'paid')]) == (3, 'packed')
assert restore(snapshot, [(3, 'packed')]) is None
assert restore(snapshot, [(2, 'paid'), (2, 'cancelled')]) is None
base = [(True, 'e1', 'o1', 'paid'),
        (True, 'e1', 'o1', 'paid'),
        (True, 'e2', 'o1', 'pending'),
        (True, 'e3', 'o1', 'paid')]
assert fulfill(base) == Counter({'o1': 1})
assert fulfill(list(reversed(base))) == Counter({'o1': 1})
assert fulfill([(False, 'bad', 'o2', 'paid')]) == Counter()
assert fulfill([(True, 'e4', 'o3', 'pending')]) == Counter()
assert release(True, True)
assert not release(True, False)
assert not release(False, True)
print('fixture assertions passed')
```

全assert通過で正常終了するのが期待値。AssertionErrorまたは異常終了ならこの例の照合は不合格として修正する。成功しても、対象サービスのどちらの受入ゲートも合格にはならない。返金・取消等は単調なpaidフラグでは扱えず、対象の正式な状態遷移に従う別ケースが必要。