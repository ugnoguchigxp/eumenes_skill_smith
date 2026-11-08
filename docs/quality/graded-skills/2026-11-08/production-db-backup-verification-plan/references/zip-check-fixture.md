### 利用範囲
手順4で、実装上の期待形式が「ZIP内に非空のSQLダンプ1件」と確認された場合の検査ロジック例。Python標準ライブラリだけを用い、メモリ内の合成データだけを扱う。未実行であり、本番バックアップやSQLの復元可能性を検証した例ではない。実ファイル用の操作手順ではない。

```python
import io
import zipfile

def fixture(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return buffer.getvalue()

def acceptable(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files = [x for x in archive.infolist() if not x.is_dir()]
            return (
                archive.testzip() is None
                and len(files) == 1
                and files[0].filename.endswith('.sql')
                and files[0].file_size > 0
            )
    except (zipfile.BadZipFile, RuntimeError, OSError):
        return False

cases = [
    (fixture([('backup.sql', b'SELECT 1;')]), True),
    (fixture([('backup.sql', b'')]), False),
    (fixture([('backup.txt', b'data')]), False),
    (fixture([('a.sql', b'x'), ('b.sql', b'y')]), False),
    (b'not a zip', False),
]
for data, expected in cases:
    assert acceptable(data) == expected
print('5件の期待値に一致')
```

終了条件は全assertが通り、最後のメッセージに到達すること。失敗時は例の検査ロジックを見直す。この合格を実成果物の合格へ転用しない。SQLの内容・DB整合性は別途検証が必要。