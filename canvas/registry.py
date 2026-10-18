"""Framework discovery and contracts. Task rules live exclusively in task plugins."""
import hashlib
import importlib.util
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
    registered = tasks()
    ids = [task["id"] for task in registered]
    if not ids or len(ids)!=len(set(ids)) or any(not ID.fullmatch(x) for x in ids):
        raise ValueError("Task IDs must be unique lowercase slugs")
    by_id = {t["id"]:t for t in registered}
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
        task_id = manifest["task"]
        if base.is_symlink() or base.parent.is_symlink() or any(p.is_symlink() for p in base.rglob("*")):
            raise ValueError("Submission symlinks are not accepted")
        for revision in manifest["revisions"]:
            folder = inside(base,revision["directory"])
            for entry in (by_id[task_id]["submission_entry"],"README.md"):
                if not inside(folder,entry).is_file():
                    raise FileNotFoundError(f"Missing submission file: {folder / entry}")
    for task in registered:
        load_runtime(task).validate(task,[(b,m) for b,m in entries if m["task"]==task["id"]])
    palette = ["#4c8f80", "#6386b5", "#b78b4d", "#a17caa", "#b86669", "#6b9cad"]
    models = [{"id": name, "name": name, "color": palette[int(hashlib.sha256(name.encode()).hexdigest()[:8], 16) % len(palette)]}
              for name in sorted({manifest["model"] for _, manifest in entries})]
    return registered,models
