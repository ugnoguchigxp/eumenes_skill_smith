これは設定構文や実際のAPIではなく、承認済み集合と候補集合の差分検査を示すPython標準機能のみの例である。手順3の正規化規則のレビューに使う。ここでは操作・対象範囲を文字列の完全一致で表す。実製品のワイルドカード、継承、deny優先順位などは、公式仕様に従って別途実効集合へ展開する必要がある。

```python
from copy import deepcopy

# 合成入力。アプリの実際の必要権限を表すものではない。
required = {
    'editor': {('filesystem', 'read', 'workspace')},
    'preview': set(),
}

def differences(candidate):
    problems = []
    if set(candidate) != set(required):
        problems.append('window-mismatch')
    for window in set(candidate) | set(required):
        actual = candidate.get(window, set())
        wanted = required.get(window, set())
        if actual - wanted:
            problems.append('extra:' + window)
        if wanted - actual:
            problems.append('missing:' + window)
    return sorted(problems)

# 正例の期待値: 差分なし。
assert differences(deepcopy(required)) == []

# 負例: 他windowへの漏出、必要権限の欠落、対象範囲の拡大。
leaked = deepcopy(required)
leaked['preview'].add(('filesystem', 'read', 'workspace'))
assert differences(leaked) == ['extra:preview']
missing = deepcopy(required)
missing['editor'].clear()
assert differences(missing) == ['missing:editor']
broad = deepcopy(required)
broad['editor'] = {('filesystem', 'read', '*')}
assert differences(broad) == ['extra:editor', 'missing:editor']
unknown = deepcopy(required)
unknown['unlisted'] = set()
assert differences(unknown) == ['window-mismatch']
print('集合照合例の期待値と一致')
```

権限のある呼出側がローカルで実行し、全assertを通過して終了コード0なら、この合成入力に対する集合照合例のみ合格とする。assert失敗・実行エラーでは終了して原因を修正する。この回答では未実行であり、実機のアクセス制御や本番配布の合格を示さない。