これは標準Pythonだけを使う未実行の合成例であり、SDK、DB、署名検証、並行性、発送先を模造した実装ではない。verifiedは検証後入力を表す仮定で、署名検証の代用品ではない。期待値はassertに記載する。全assert通過時のみ終了コード0、違反時はAssertionErrorで終了する。
```python
from copy import deepcopy

initial = {"events": set(), "paid": False,
           "hold": False, "commands": set()}

def ingest(state, event, fail=None):
    # 検証失敗・照合不一致は更新しない
    if not event["verified"] or event["amount"] != 100:
        return state, "reject"
    if event["id"] in state["events"]:
        return state, "duplicate"
    draft = deepcopy(state)
    draft["events"].add(event["id"])
    if fail == "receipt":
        return state, "retry"
    if event["kind"] == "refund":
        draft["hold"] = True
    elif event["kind"] == "paid" and not draft["hold"]:
        draft["paid"] = True
        draft["commands"].add("ship:order-1")
    if fail == "commit":
        return state, "retry"
    return draft, "durable"

paid = {"id": "p1", "verified": True,
        "amount": 100, "kind": "paid"}
for bad in (dict(paid, verified=False), dict(paid, amount=99)):
    state, result = ingest(initial, bad)
    assert result == "reject" and state == initial
for point in ("receipt", "commit"):
    state, result = ingest(initial, paid, point)
    assert result == "retry" and state == initial
state, result = ingest(initial, paid)
assert result == "durable" and state["paid"]
state, result = ingest(state, paid)
assert result == "duplicate"
state, _ = ingest(state, dict(paid, id="p2"))
assert state["commands"] == {"ship:order-1"}
refund = dict(paid, id="r1", kind="refund")
held, _ = ingest(initial, refund)
held, _ = ingest(held, paid)
assert held["hold"] and not held["paid"]
assert held["commands"] == set()
assert initial == {"events": set(), "paid": False,
                   "hold": False, "commands": set()}
```
返金先着時は保留するモデルであり、一般的な決済状態機械を定義しない。検査対象は更新候補の一括確定、再送、異なる通知IDに対する同一注文キー、保留後の発送抑止に限る。外部へ発送指示が一度だけ受理されることや、実DBのロールバックを証明しない。