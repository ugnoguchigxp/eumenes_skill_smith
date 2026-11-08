標準Pythonだけを使う、将来のローカル検証用の未実行例。HTMLは合成入力であり、対象フォームを変更しない。2入力の正常・エラー表示・解除を正例にし、重複ID、参照切れ、別入力の説明混入、名前の上書き、古いエラー残存を負例にする。全assert通過で正常終了し、期待違反ならAssertionErrorで停止する。

```python
from html.parser import HTMLParser
from collections import Counter

class DOM(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.nodes = []
        self.feed(text)
    def handle_starttag(self, tag, attrs):
        self.nodes.append((tag, dict(attrs)))

def check(text, error):
    nodes = DOM(text).nodes
    ids = [a['id'] for _, a in nodes if 'id' in a]
    assert all(ids) and len(ids) == len(set(ids)), 'duplicate/empty ID'
    labels = Counter(a.get('for') for t, a in nodes if t == 'label')
    inputs = {a['id']: a for t, a in nodes if t == 'input'}
    assert set(inputs) == {'email', 'phone'}
    for key, a in inputs.items():
        assert labels[key] == 1, 'missing/ambiguous label'
        assert 'aria-label' not in a and 'aria-labelledby' not in a
        refs = a.get('aria-describedby', '').split()
        assert all(r in ids for r in refs), 'dangling reference'
        expected = [key + '-hint']
        if error and key == 'email':
            expected.append('email-error')
        assert refs == expected, 'wrong/stale description'
        assert a.get('aria-invalid', 'false') == (
            'true' if error and key == 'email' else 'false'
        )
    assert ('email-error' in ids) == error

def fixture(error):
    refs = 'email-hint email-error' if error else 'email-hint'
    invalid = 'true' if error else 'false'
    message = '<p id="email-error">メール形式を確認してください</p>' if error else ''
    return (
        '<label for="email">メール</label>'
        f'<input id="email" aria-describedby="{refs}" aria-invalid="{invalid}">'
        '<p id="email-hint">連絡先に使用します</p>' + message +
        '<label for="phone">電話</label>'
        '<input id="phone" aria-describedby="phone-hint">'
        '<p id="phone-hint">市外局番から入力してください</p>'
    )

clean, failed = fixture(False), fixture(True)
for state in (False, True, False):
    check(fixture(state), state)

bad = [
    (clean + '<p id="email">重複</p>', False),
    (clean.replace('id="email-hint"', 'id="lost"'), False),
    (clean.replace('aria-describedby="phone-hint"',
                   'aria-describedby="email-hint"'), False),
    (clean.replace('<input id="email"',
                   '<input aria-label="別の名前" id="email"'), False),
    (failed, False),
]
for text, state in bad:
    try:
        check(text, state)
    except AssertionError:
        pass
    else:
        raise AssertionError('negative case was not rejected')
print('fixture assertions passed')
```

この検査器は例の明示的labelと2入力に限定する。ブラウザの名前計算、CSSによる非表示、実際のDOM更新、スクリーンリーダーの通知は検証しない。対象へ転用する際は入力一覧と期待する説明を実DOMに合わせ、暗黙ラベルなど有効な別構造を機械的に否定しない。