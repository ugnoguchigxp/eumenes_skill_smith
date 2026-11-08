これは標準Pythonだけを使う未実行の検査仕様例であり、対象の秘匿化関数ではない。手で定義した期待出力と、各経路に秘密値を戻した負例で判定器を点検する。実装側では、承認された隔離環境で実際の保存直前出力・シリアライズ結果を同じ種類の検査へ渡す。以下の成功は実装の合格を意味しない。

```python
import copy
import json

secrets = ('META_SYN_71', 'DIFF_SYN_82', 'QUERY_SYN_93', 'AUTH_SYN_64')
raw = {
    'metadata': {'items': [{'token': secrets[0]}]},
    'diff': [{'before': secrets[1], 'after': 'public'}],
    'url': 'https://example.invalid/path?token=' + secrets[2] + '&page=2',
    'headers': {'Authorization': 'Bearer ' + secrets[3]},
    'status': 'failed', 'error_code': 'E_SYN'
}
expected = {
    'metadata': {'items': [{'token': '[REDACTED]'}]},
    'diff': [{'before': '[REDACTED]', 'after': 'public'}],
    'url': 'https://example.invalid/path?token=[REDACTED]&page=2',
    'headers': {'Authorization': '[REDACTED]'},
    'status': 'failed', 'error_code': 'E_SYN'
}

def strings(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, str):
        yield value

def boundary_ok(value, serialized):
    try:
        roundtrip = json.loads(serialized)
    except (ValueError, TypeError):
        return False
    texts = list(strings(value)) + [serialized] + list(strings(roundtrip))
    return (value == expected and roundtrip == value
            and not any(secret in text for secret in secrets for text in texts))

wire = json.dumps(expected, ensure_ascii=False)
assert boundary_ok(expected, wire), 'positive boundary rejected'
assert not boundary_ok(raw, json.dumps(raw)), 'raw leak accepted'
for field in ('metadata', 'diff', 'url', 'headers'):
    bad = copy.deepcopy(expected)
    bad[field] = copy.deepcopy(raw[field])
    assert not boundary_ok(bad, json.dumps(bad)), 'field leak accepted'
assert not boundary_ok(expected, json.dumps(raw)), 'serializer leak accepted'
bad = copy.deepcopy(expected)
bad['error_code'] = '[REDACTED]'
assert not boundary_ok(bad, json.dumps(bad)), 'diagnostic loss accepted'
print('fixture assertions passed')
```

終了条件：全assertを通過すれば正常終了、違反時はAssertionErrorで非正常終了する。失敗メッセージは入力値を表示しない。URLへの接続やファイル書込みはない。URLエンコード、多行鍵、実際のログ形式の網羅性はこの小例では保証しない。