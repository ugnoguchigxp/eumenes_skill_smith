標準Pythonだけを使う未実行の設計fixture。APIの模造ではなく、単一作業・単一世代の純粋な状態遷移を検査する。期待値は最終進捗5、欠番中は未完了、矛盾イベントは拒否。全assert通過なら終了コード0、失敗なら非0となる。認可・永続化・並行snapshot・世代切替の実装は検証しない。

```python
from copy import deepcopy

class View:
    def __init__(self):
        self.c = 0
        self.value = 0
        self.status = 'running'
        self.pending = {}
        self.seen = {}

    def feed(self, seq, delta, status):
        event = (delta, status)
        if seq in self.seen:
            if self.seen[seq] != event:
                raise ValueError('identity conflict')
            return
        if seq <= self.c:
            return  # snapshotに含まれる範囲
        self.seen[seq] = event
        self.pending[seq] = event
        while self.c + 1 in self.pending:
            if self.status != 'running':
                raise ValueError('event after terminal')
            delta, status = self.pending.pop(self.c + 1)
            self.value += delta
            self.status = status
            self.c += 1

    def snapshot(self, seq, value, status):
        if seq < self.c:
            raise ValueError('stale snapshot')
        tail = [(s, *e) for s, e in self.pending.items() if s > seq]
        self.c, self.value, self.status = seq, value, status
        self.pending, self.seen = {}, {}
        for event in sorted(tail):
            self.feed(*event)

    def result(self):
        return self.c, self.value, self.status

first = (1, 2, 'running')
last = (2, 3, 'succeeded')
expected = (2, 5, 'succeeded')
v = View()
v.feed(*last)
assert v.result() == (0, 0, 'running')  # 終端でも欠番を飛ばさない
v.feed(*first)
assert v.result() == expected
before = deepcopy(v.result())
v.feed(*first)
v.feed(*last)
assert v.result() == before  # 再送で加算しない
try:
    v.feed(2, 99, 'succeeded')
except ValueError:
    pass
else:
    raise AssertionError('conflict accepted')
w = View()
w.feed(*last)
w.snapshot(1, 2, 'running')  # 期限切れ復旧の境界を模す
w.feed(*first)
assert w.result() == expected
started_only = View()
started_only.feed(1, 0, 'running')
assert started_only.status != 'succeeded'
```