これはPython標準ライブラリだけを使う未実行の方針fixture。接続関数や対象APIの代用品ではなく、拒否順序と作用の期待値を検査する。Pythonの版ごとのIP分類差、実URL parser、DNS、TLS、タイマー、ストリーミングは別途検証する。IPはデータのみで、通信しない。全assert完了が終了条件、AssertionErrorは不合格。
```python
from ipaddress import ip_address, ip_network
from urllib.parse import urlsplit

META = {ip_address('169.254.169.254')}
CGN = ip_network('100.64.0.0/10')

def allowed_ip(text):
    if '%' in text:
        return False
    a = ip_address(text)
    if a.version == 6 and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return (a.is_global and not a.is_multicast
            and not a.is_reserved and not a.is_unspecified
            and not a.is_loopback and not a.is_link_local
            and not a.is_private and a not in META
            and not (a.version == 4 and a in CGN))

def model(hops, elapsed=1, size=1, time_cap=5, size_cap=10,
          redirect_cap=2):
    events = []
    for index, (url, answers, peer) in enumerate(hops):
        if index > redirect_cap:
            return 'redirect', events
        u = urlsplit(url)
        host = (u.hostname or '').rstrip('.').lower()
        if (u.scheme not in ('http', 'https') or not host
                or u.username is not None or u.password is not None
                or host == 'localhost' or host.endswith('.localhost')):
            return 'url', events
        events.append('resolve')
        if not answers or not all(allowed_ip(x) for x in answers):
            return 'dns', events
        # connectは検証済み回答から選んだIPへの接続試行を表す。
        events.append('connect')
        if peer not in answers or not allowed_ip(peer):
            return 'peer', events
        events.append('request')
    if elapsed > time_cap or size > size_cap:
        return 'limit', events
    return 'ok', events

public = '8.8.8.8'
good = ('https://example.test/', [public], public)
assert model([good]) == ('ok', ['resolve', 'connect', 'request'])
for url in ('file:///etc/hosts', 'https://u:p@example.test/',
            'http://localhost/', 'http://x.localhost./'):
    assert model([(url, [public], public)]) == ('url', [])
for bad in ('127.0.0.1', '10.0.0.1', '169.254.169.254',
            '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
            '::ffff:127.0.0.1', '224.0.0.1', '::'):
    assert not allowed_ip(bad)
    assert model([('https://example.test/', [public, bad], public)]) == (
        'dns', ['resolve'])
assert model([('https://example.test/', [], public)]) == ('dns', ['resolve'])
# 再解決や経路変更で禁止peerになった場合、HTTP要求前に停止。
assert model([('https://example.test/', [public], '127.0.0.1')]) == (
    'peer', ['resolve', 'connect'])
# 最初の許可段の通信は残し、次の禁止段の接続を行わない。
bad_hop = ('https://next.test/', ['::1'], '::1')
assert model([good, bad_hop]) == (
    'dns', ['resolve', 'connect', 'request', 'resolve'])
assert model([good] * 4)[0] == 'redirect'
assert model([good], elapsed=5, size=10)[0] == 'ok'
assert model([good], elapsed=6)[0] == 'limit'
assert model([good], size=11)[0] == 'limit'
```
上限の数値はfixture専用。モデルは応答完了時の値を入力しているだけで、実装の即時中断やメモリ上限を検証しない。実装では読み取り中の超過、DNS待機、低速応答、圧縮展開も試験する。