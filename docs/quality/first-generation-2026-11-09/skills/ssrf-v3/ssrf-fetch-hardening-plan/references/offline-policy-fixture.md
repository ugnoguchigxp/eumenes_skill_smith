このPython例は標準ライブラリだけを使う未実行の合成モデル。外部通信・ファイル操作は行わない。URL parser、DNS、HTTP clientの代用品ではなく、拒否時点と先行して許された作用の期待値を検査する。各hopの解析結果を合成入力として与える。実装のURL解析、全特殊用途アドレスの網羅、peer検査前の要求送信防止は別途検証する。数値上限も例示値であり本番設定ではない。

```python
from ipaddress import ip_address

def public(text):
    ip = ip_address(text)
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast

def model(hops, elapsed=0, size=0):
    effects = []
    for scheme, userinfo, host, answers, peer in hops:
        host = host.lower().rstrip('.')
        if (scheme not in ('http', 'https') or userinfo
                or host == 'localhost' or host.endswith('.localhost')):
            return 'url', effects
        effects.append('dns')
        if not answers or not all(public(a) for a in answers):
            return 'dns', effects
        # 固定した候補への接続だけを試みる想定。
        effects.append('connect')
        if peer not in answers or not public(peer):
            return 'peer', effects
        effects.append('request')
    if elapsed > 2 or size > 16:
        return 'limit', effects
    return 'ok', effects

ok = ('https', False, 'public.example', ['8.8.8.8'], '8.8.8.8')
sent = ['dns', 'connect', 'request']
assert model([ok]) == ('ok', sent)
for scheme, auth, host in [('file', False, 'public.example'),
                           ('https', True, 'public.example'),
                           ('http', False, 'x.localhost.')]:
    hop = (scheme, auth, host, ['8.8.8.8'], '8.8.8.8')
    assert model([hop]) == ('url', [])
for bad in ['127.0.0.1', '10.0.0.1', '169.254.169.254',
            '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
            '224.0.0.1', 'ff02::1', '::ffff:127.0.0.1']:
    hop = ('https', False, 'public.example', ['8.8.8.8', bad], bad)
    assert model([hop]) == ('dns', ['dns'])
changed = ('https', False, 'public.example', ['8.8.8.8'], '127.0.0.1')
assert model([changed]) == ('peer', ['dns', 'connect'])
redirect = ('http', False, 'localhost', ['127.0.0.1'], '127.0.0.1')
assert model([ok, redirect]) == ('url', sent)
assert model([ok], elapsed=2, size=16) == ('ok', sent)
assert model([ok], elapsed=2.01) == ('limit', sent)
assert model([ok], size=17) == ('limit', sent)
print('offline assertions passed')
```

全assert通過時だけ正常終了し、違反時はAssertionErrorで終了する。peer不一致ケースのconnectはモデル上の接続試行であり、実装で禁止先への接続を容認する意味ではない。実装は事前の接続先固定を必須とし、peer検査は追加防御とする。資源制限の拒否は要求後に起こるため、それ以前の適法な要求まで禁止しない。