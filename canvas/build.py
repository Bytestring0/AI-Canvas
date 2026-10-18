"""Compile task manifests into a static site without knowing any task type."""
import datetime as dt
import shutil
from .common import ROOT, read, write, inside, submissions
from .registry import validate,task_root,load_runtime

def build():
    tasks,models = validate()
    target = ROOT/"dist"
    if target.is_symlink() or not target.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Build directory must stay inside the framework workspace")
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT/"web",target)
    catalog = {"schema_version":2,"generated_at":dt.datetime.now(dt.timezone.utc).isoformat(),"guide_text":(ROOT/"README.md").read_text(encoding="utf-8"),"tasks":[],"models":models,"submissions":[]}
    by_id = {t["id"]:t for t in tasks}
    for task in tasks:
        root = task_root(task)
        item = {k:v for k,v in task.items() if k not in ("credential_secret","runtime","container_image")}
        item["readme_text"] = inside(root,task["readme"]).read_text(encoding="utf-8")
        item["payload"] = load_runtime(task).build_payload(task)
        ui = inside(root,task["view"])
        shutil.copytree(ui.parent,target/"task-ui"/task["id"])
        item["view_url"] = f"./task-ui/{task['id']}/{ui.name}"
        catalog["tasks"].append(item)
    for base,manifest in submissions():
        task = by_id[manifest["task"]]
        item = {**manifest,"revisions":[]}
        for revision in manifest["revisions"]:
            source = inside(base,revision["directory"])
            destination = inside(target/"artifacts"/task["id"]/manifest["model"], revision["id"])
            shutil.copytree(source,destination,ignore=shutil.ignore_patterns("__pycache__","*.pyc"))
            item["revisions"].append({**revision,"source":inside(source,task["submission_entry"]).read_text(encoding="utf-8"),"readme":(source/"README.md").read_text(encoding="utf-8")})
        pattern = task.get("result_pattern")
        result = inside(task_root(task),pattern.format(model=manifest["model"])) if pattern else None
        item["run"] = read(result) if result and result.is_file() else None
        catalog["submissions"].append(item)
    write(target/"data/catalog.json",catalog)
    (target/".nojekyll").touch()
    print(f"Built {len(tasks)} task plugins, {len(models)} models, {len(catalog['submissions'])} submissions")
