これはブラウザAPIの代用品ではなく、設計上の許可・抑止規則を標準Pythonで表した未実行の例である。各入力値は合成値で、DOM判定、実際のIME順序、イベント取消し、支援技術との共存は検証しない。将来、権限のある呼出側が実行する場合、全assert通過で正常終了、失敗時はAssertionErrorで停止する。

```python
from itertools import product

# 合成入力。承認済み割当への一致と、対象画面のフォーカスを前提にしない。
base = dict(os='windows', ctrl=True, meta=False, alt=False,
            shift=False, matched=True, focused=True, enabled=True,
            consumed=False, editable=False, composing=False,
            repeat=False, latched=False, pending=False)

def allowed(e):
    if e['os'] not in ('windows', 'linux', 'macos'):
        return False
    mods = (e['meta'] and not e['ctrl']) if e['os'] == 'macos' else (
        e['ctrl'] and not e['meta'])
    return (mods and not e['alt'] and not e['shift']
            and e['matched'] and e['focused'] and e['enabled']
            and not any(e[k] for k in ('consumed', 'editable', 'composing',
                                      'repeat', 'latched', 'pending')))

# 正の期待値：各OSで指定の主要修飾キーだけなら許可。
for os_name in ('windows', 'linux', 'macos'):
    e = dict(base, os=os_name, ctrl=os_name != 'macos',
             meta=os_name == 'macos')
    assert allowed(e) is True

# 負の期待値：入力・IME・反復・押下済み・確認待ちのいずれでも抑止。
for flags in product((False, True), repeat=5):
    e = dict(base, **dict(zip(
        ('editable', 'composing', 'repeat', 'latched', 'pending'), flags)))
    assert allowed(e) == (not any(flags))
for change in ({'ctrl': False}, {'meta': True}, {'alt': True},
               {'shift': True}, {'matched': False}, {'focused': False},
               {'enabled': False}, {'consumed': True}, {'os': 'unknown'}):
    assert allowed(dict(base, **change)) is False

# 長押しの合成列：初回だけ許可。ラッチ解除後の別押下は許可。
sequence = [base, dict(base, repeat=True, latched=True),
            dict(base, repeat=True, latched=True)]
assert [allowed(e) for e in sequence] == [True, False, False]
assert allowed(dict(base, latched=False)) is True
```