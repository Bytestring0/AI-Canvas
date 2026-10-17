"""China Standard Time and ten-minute session identities."""
import datetime as dt

SHANGHAI = dt.timezone(dt.timedelta(hours=8))

def now():
    return dt.datetime.now(SHANGHAI).replace(microsecond=0)

def parse(value):
    timestamp = dt.datetime.fromisoformat(value)
    if timestamp.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")
    return timestamp.astimezone(SHANGHAI)

def market_slot(timestamp):
    timestamp = timestamp.astimezone(SHANGHAI)
    if timestamp.weekday() >= 5:
        return None
    minute = timestamp.hour*60 + timestamp.minute
    if not (570 <= minute <= 695 or 780 <= minute <= 905):
        return None
    # Grace for the final cron of each session; still use the real capture time.
    if 690 <= minute <= 695:
        timestamp = timestamp.replace(hour=11, minute=30)
    elif 900 <= minute <= 905:
        timestamp = timestamp.replace(hour=15, minute=0)
    return timestamp.replace(minute=timestamp.minute//10*10, second=0, microsecond=0).isoformat()

def snapshot_path(root, slot):
    timestamp = parse(slot)
    if market_slot(timestamp) != timestamp.isoformat():
        raise ValueError("Invalid ten-minute market slot")
    return root / "data/market" / timestamp.date().isoformat() / f"{timestamp:%H%M}.json"

def revision_time(value):
    if len(value) == 10:
        value += "T00:00:00+08:00"
    return parse(value)
