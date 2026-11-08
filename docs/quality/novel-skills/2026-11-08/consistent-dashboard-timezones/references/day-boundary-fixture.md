将来、権限のある呼出側で実行する未実行のPython標準ライブラリ例。対象アプリのAPIを模造せず、暦日からUTC区間への変換規則と負例を検査する。zoneinfo対応PythonとIANAタイムゾーンデータが必要。データ不足なら停止し、自動取得しない。成功しても対象DB・画面の動作検証にはならない。
```python
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc
try:
    zones = {z: ZoneInfo(z) for z in (
        'Asia/Tokyo', 'America/New_York')}
except ZoneInfoNotFoundError:
    raise SystemExit('未測定: 必要なタイムゾーンデータがない')

def span(day, zone):
    # 翌暦日を先に求める。UTC開始へ24時間を足さない。
    a = datetime.combine(day, time.min, zone)
    b = datetime.combine(day + timedelta(days=1), time.min, zone)
    return a.astimezone(UTC), b.astimezone(UTC)

cases = [
    ('Asia/Tokyo', date(2024, 1, 2),
     '2024-01-01T15:00:00+00:00', '2024-01-02T15:00:00+00:00', 24),
    ('America/New_York', date(2024, 3, 10),
     '2024-03-10T05:00:00+00:00', '2024-03-11T04:00:00+00:00', 23),
    ('America/New_York', date(2024, 11, 3),
     '2024-11-03T04:00:00+00:00', '2024-11-04T05:00:00+00:00', 25),
]
for name, day, start, end, hours in cases:
    a, b = span(day, zones[name])
    assert (a.isoformat(), b.isoformat()) == (start, end)
    assert (b - a).total_seconds() == hours * 3600
    points = [a - timedelta(microseconds=1), a,
              b - timedelta(microseconds=1), b]
    assert [a <= p < b for p in points] == [False, True, True, False]
    assert span(day + timedelta(days=1), zones[name])[0] == b

now = datetime(2024, 1, 1, 15, 30, tzinfo=UTC)
assert now.astimezone(zones['Asia/Tokyo']).date() == date(2024, 1, 2)
assert now.astimezone(zones['America/New_York']).date() == date(2024, 1, 1)
# UTC日付を既定日付として使う誤りを検出する負例。
assert now.date() != now.astimezone(zones['Asia/Tokyo']).date()

# 秋の重複する01:30も、別々の瞬間として同じ日に含む。
a, b = span(date(2024, 11, 3), zones['America/New_York'])
repeated = [datetime(2024, 11, 3, h, 30, tzinfo=UTC) for h in (5, 6)]
assert all(a <= p < b for p in repeated)
assert [p.astimezone(zones['America/New_York']).hour for p in repeated] == [1, 1]
assert repeated[0] != repeated[1]

try:
    ZoneInfo('Invalid/Zone')
except ZoneInfoNotFoundError:
    pass
else:
    raise AssertionError('無効zoneを受理した')
print('fixtureの全assert合格')
```
終了条件は全assertを通過して最後の表示に到達すること。依存不足・例外・assert失敗は未合格として停止する。実アプリの入力拒否、集計、キャッシュ、非同期更新は別途ワークフローで検証する。