Python標準ライブラリだけを使う未実行の設計fixture。外部APIやwindow基盤は実装していない。callbackは呼び出し位置・回数の観測専用であり、実APIの仕様や認証の代用品ではない。本文で採用候補とした厳格形式を例示する。

```python
from unittest.mock import Mock


def parse_key(key):
    if not isinstance(key, str) or key.count(':') != 1:
        raise ValueError('Invalid permission key')
    resource, action = key.split(':')
    if (not resource.strip() or not action.strip()
            or resource != resource.strip()
            or action != action.strip()):
        raise ValueError('Invalid permission key')
    return resource, action


def boundary(key, trusted_window, allowed, check):
    resource, action = parse_key(key)
    # trusted_windowは上流で真正性を検証済みというfixtureの前提。
    if (resource, action) not in allowed.get(trusted_window, set()):
        return False
    try:
        return check(resource, action) is True
    except Exception:
        return False


allowed = {
    'viewer': {('report', 'read')},
    'editor': {('report', 'read'), ('report', 'write')},
}
invalid = [None, 4, '', ':', ':read', 'report:',
           ' :read', 'report: ', 'report:read:extra', ' report:read']
for key in invalid:
    check = Mock(return_value=True)
    try:
        boundary(key, 'viewer', allowed, check)
    except ValueError as error:
        assert str(error) == 'Invalid permission key'
    else:
        raise AssertionError('不正キーが拒否されなかった')
    check.assert_not_called()

for window, key in [('viewer', 'report:write'),
                    ('unknown', 'report:read')]:
    check = Mock(return_value=True)
    assert boundary(key, window, allowed, check) is False
    check.assert_not_called()

for window, key, expected_args in [
    ('viewer', 'report:read', ('report', 'read')),
    ('editor', 'report:write', ('report', 'write')),
]:
    check = Mock(return_value=True)
    assert boundary(key, window, allowed, check) is True
    check.assert_called_once_with(*expected_args)

for response in [False, None, 'true']:
    check = Mock(return_value=response)
    assert boundary('report:read', 'viewer', allowed, check) is False
    check.assert_called_once_with('report', 'read')

check = Mock(side_effect=TimeoutError('fixture'))
assert boundary('report:read', 'viewer', allowed, check) is False
check.assert_called_once_with('report', 'read')
print('fixture assertions passed')
```

期待値は、不正キーの例外、拒否経路の呼び出し0件、許可経路の1回呼び出し、外部拒否・異常のFalse。全assert通過時のみ表示して正常終了し、違反は例外で終了する。実装では対象契約に沿ったエラー型・非同期処理・タイムアウト制御を別途検証する。この例の成功だけでは、window真正性、失効競合、実API接続の合格を示さない。