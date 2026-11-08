Python標準機能だけの未実行例。将来、権限のあるローカル環境で実行する。合成済み区間の保持契約を検査するもので、parser・editor・DOMの動作を模造または検証するものではない。文字列のHTML風部分は実行しない。

```python
import json

prefix = '= 見出し\r\n\r\n'
raw = '[vendor]\r\n----\r\n\r\n日本語 & <img src=x onerror=alert(1)>\r\n----\r\n'
suffix = '\r\n後続\n'
original = prefix + raw + suffix
start, end = len(prefix), len(prefix) + len(raw)
node = {'type': 'rawAsciiDocBlock', 'source': original[start:end]}
restored = json.loads(json.dumps(node, ensure_ascii=False))
assert restored == node
assert prefix + restored['source'] + suffix == original

# 編集後の期待値は、指定した一箇所だけが変わる文字列。
edited = raw.replace('日本語', '編集済み日本語', 1)
restored['source'] = edited
expected = prefix + edited + suffix
assert prefix + restored['source'] + suffix == expected
assert expected[:start] == prefix
assert expected.endswith(suffix)

# 正規化・空白削除を意図的に混入すると拒否できること。
for corrupted in (raw.replace('\r\n', '\n'), raw.strip()):
    rejected = False
    try:
        assert prefix + corrupted + suffix == original
    except AssertionError:
        rejected = True
    assert rejected
print('原文保持fixtureの期待値と負例判定が一致')
```

全assert通過で正常終了する。未捕捉のAssertionErrorは失敗として停止する。この例の成功を、実装の往復変換やブラウザ安全性の合格には数えない。