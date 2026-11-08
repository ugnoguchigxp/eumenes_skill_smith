Python標準機能だけの自己完結した設計例。プロジェクトの既存APIではない。静的に期待値を照合した未実行fixtureであり、対象実装の合格を示さない。floatとして表現可能な数値を想定する。乱数の契約は有限な0以上1以下とし、1は上限の直接試験にも用いる。

```python
import math


def jitter_delay(base, jitter_ratio, rng):
    if not math.isfinite(base) or base < 0:
        raise ValueError('base')
    if not math.isfinite(jitter_ratio):
        raise ValueError('ratio')
    r = min(1.0, max(0.0, jitter_ratio))
    if r == 0 or base == 0:
        return base
    u = rng()
    if not math.isfinite(u) or not 0.0 <= u <= 1.0:
        raise ValueError('rng')
    delay = base * (1.0 + r * (2.0 * u - 1.0))
    if not math.isfinite(delay):
        raise ValueError('delay overflow')
    return delay


def forbidden_rng():
    raise AssertionError('rng must not be called')


for ratio in (-0.2, 0.0):
    assert jitter_delay(100.0, ratio, forbidden_rng) == 100.0
assert jitter_delay(0.0, 0.5, forbidden_rng) == 0.0

for ratio, expected in (
    (0.2, [80.0, 100.0, 120.0]),
    (1.0, [0.0, 100.0, 200.0]),
    (1.5, [0.0, 100.0, 200.0]),
):
    actual = [jitter_delay(100.0, ratio, lambda: u)
              for u in (0.0, 0.5, 1.0)]
    assert all(math.isclose(a, e, rel_tol=0, abs_tol=1e-12)
               for a, e in zip(actual, expected))


def run_sequence():
    values = iter([0.0, 0.5, 1.0])
    return [jitter_delay(100.0, 0.2, lambda: next(values))
            for _ in range(3)]


assert run_sequence() == run_sequence()
calls = []
assert jitter_delay(100.0, 0.2, lambda: calls.append(1) or 0.5) == 100.0
assert calls == [1]


def must_reject(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError('invalid input accepted')


for base in (-1.0, float('nan'), float('inf')):
    must_reject(lambda: jitter_delay(base, 0.2, forbidden_rng))
for ratio in (float('nan'), float('inf'), -float('inf')):
    must_reject(lambda: jitter_delay(100.0, ratio, forbidden_rng))
for u in (-0.01, 1.01, float('nan'), float('inf')):
    must_reject(lambda: jitter_delay(100.0, 0.2, lambda: u))
must_reject(lambda: jitter_delay(1e308, 1.0, lambda: 1.0))
```

全assert通過で正常終了することがこの例の合格条件。例外・assert失敗は不合格として終了し、統合へ進めない。対象言語への移植では、この入力・期待値を維持して実際の遅延計算関数へ適用する。