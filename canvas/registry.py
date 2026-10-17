"""Framework discovery and contracts. Task rules live exclusively in task plugins."""
import datetime as dt
import importlib.util
import re
import sys
from .common import ROOT, ID, read, inside, submissions

def tasks():
    return [read(p) for p in sorted((ROOT/"tasks").glob("*/task.json"))]

def task_root(task):
    return ROOT/"tasks"/task["id"]

def load_runtime(task):
    folder = inside(task_root(task),task["runtime"])
    name = "canvas_plugin_" + task["id"].replace("-","_")
    if name in sys.modules and sys.modules[name].__file__ == str(folder/"__init__.py"):
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name,folder/"__init__.py",submodule_search_locations=[str(folder)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

def validate():
    registered,models = tasks(),read(ROOT/"config/models.json")
    for entries in (registered,models):
        ids = [x["id"] for x in entries]
        if not ids or len(ids)!=len(set(ids)) or any(not ID.fullmatch(x) for x in ids):
            raise ValueError("Registry IDs must be unique lowercase slugs")
    by_id = {t["id"]:t for t in registered}
    model_ids = {m["id"] for m in models}
    for model in models:
        if not model.get("name") or not re.fullmatch(r"#[0-9a-fA-F]{6}",model.get("color","")):
            raise ValueError("Model needs a name and #RRGGBB color")
    for task in registered:
        root = task_root(task)
        if not (root/"task.json").is_file():
            raise ValueError("Task ID must match its directory")
        for field in ("readme","view"):
            if not inside(root,task[field]).is_file():
                raise ValueError(f"Task missing {field}")
        schedule = task.get("schedule")
        if schedule and (type(schedule.get("interval_minutes")) is not int or schedule["interval_minutes"]<10 or schedule["interval_minutes"]%10):
            raise ValueError("Task interval must be a positive multiple of the ten-minute framework poll")
    entries = submissions()
    for base,manifest in entries:
        task_id,model_id = manifest["task"],manifest["model"]
        if task_id not in by_id or model_id not in model_ids or base!=ROOT/"submissions"/task_id/model_id:
            raise ValueError("Submission path/registry mismatch")
        if base.is_symlink() or base.parent.is_symlink() or any(p.is_symlink() for p in base.rglob("*")):
            raise ValueError("Submission symlinks are not accepted")
        if manifest.get("schema_version")!=1 or not isinstance(manifest.get("model_version"),str) or not manifest["model_version"]:
            raise ValueError("Submission needs schema_version=1 and exact model_version")
        revisions = manifest["revisions"]
        if not revisions or len({r["id"] for r in revisions})!=len(revisions):
            raise ValueError("Revision IDs must be unique")
        dates = []
        for revision in revisions:
            if not ID.fullmatch(revision["id"]) or not revision.get("note"):
                raise ValueError("Revision needs slug ID and note")
            timestamp = revision["effective_from"]
            if len(timestamp)==10:
                timestamp += "T00:00:00+00:00"
            date = dt.datetime.fromisoformat(timestamp)
            if date.tzinfo is None:
                raise ValueError("Revision datetime must have timezone")
            dates.append(date)
            folder = inside(base,revision["directory"])
            for entry in (by_id[task_id]["submission_entry"],"README.md"):
                if not inside(folder,entry).is_file():
                    raise ValueError(f"Revision missing {entry}")
            if any(p.stat().st_size>5_000_000 for p in folder.rglob("*") if p.is_file()):
                raise ValueError("Submission file exceeds 5MB")
        if dates!=sorted(set(dates)):
            raise ValueError("Revision effective_from must strictly increase")
    for task in registered:
        load_runtime(task).validate(task,[(b,m) for b,m in entries if m["task"]==task["id"]])
    return registered,models
