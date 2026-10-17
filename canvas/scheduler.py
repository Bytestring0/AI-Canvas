"""Generic task-owned schedules; no domain-specific hours, credentials or commands."""
import datetime as dt
from zoneinfo import ZoneInfo
from .common import submissions
from .registry import tasks

def due(task, timestamp):
    schedule = task.get("schedule")
    if not schedule:
        return False
    # Fixed UTC+8 fallback keeps Windows dependency-free for schedules in that zone.
    zone = dt.timezone(dt.timedelta(hours=8)) if schedule["timezone"]=="Asia/Shanghai" else ZoneInfo(schedule["timezone"])
    local = timestamp.astimezone(zone)
    if local.weekday() not in schedule["weekdays"]:
        return False
    clock = local.strftime("%H:%M")
    nominal_minute = (local.hour*60+local.minute)//10*10
    if nominal_minute % schedule["interval_minutes"]:
        return False
    # Slot-level deduplication belongs to the task runtime, which owns its state.
    return any(start<=clock<=end for start,end in schedule["windows"])

def plan(timestamp=None):
    timestamp = timestamp or dt.datetime.now(dt.timezone.utc)
    active = {manifest["task"] for _,manifest in submissions()}
    return [{"id":task["id"],"secret":task.get("credential_secret",""),"image":task.get("container_image","")} for task in tasks() if task["id"] in active and due(task,timestamp)]
