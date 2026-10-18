import hashlib
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def inside(base, relative):
    path = (Path(base) / relative).resolve()
    if not path.is_relative_to(Path(base).resolve()):
        raise ValueError(f"Path escapes submission: {relative}")
    return path

def submissions():
    """Discover model folders; old manifests are optional metadata, never registration."""
    entries = []
    def version_order(path):
        return [(1, int(part)) if part.isdigit() else (0, part.casefold())
                for part in re.split(r"(\d+)", path.name)]

    for path in sorted((ROOT / "tasks").glob("*/task.json")):
        task = read(path)
        parent = ROOT / "submissions" / task["id"]
        if not parent.is_dir():
            continue
        for base in sorted(parent.iterdir()):
            if not base.is_dir() or base.name.startswith("."):
                continue
            if base.is_symlink():
                raise ValueError(f"Submission directory must not be a symlink: {base}")
            metadata_path = base / "submission.json"
            metadata = read(metadata_path) if metadata_path.is_file() else {}
            if (base / task["submission_entry"]).is_file():
                revisions = [{"id": "v1", "directory": "."}]
            elif metadata.get("revisions"):
                revisions = metadata["revisions"]
            else:
                revisions = [{"id": folder.name, "directory": folder.relative_to(base).as_posix()}
                             for folder in sorted((base / "revisions").glob("*"), key=version_order)
                             if folder.is_dir()]
            if not revisions:
                if not any(base.iterdir()):
                    continue
                revisions = [{"id": "v1", "directory": "."}]
            normalized = []
            for index, revision in enumerate(revisions):
                folder = inside(base, revision.get("directory", "."))
                source = inside(folder, task["submission_entry"])
                stamp = dt.datetime.fromtimestamp(source.stat().st_mtime, dt.timezone.utc).isoformat() if source.is_file() else "1970-01-01T00:00:00+00:00"
                normalized.append({"id": f"v{index + 1}", "directory": ".", "note": "", **revision,
                                   "effective_from": revision.get("effective_from") or stamp})
            entries.append((base, {**metadata, "schema_version": 1, "task": task["id"], "model": base.name,
                                   "model_version": metadata.get("model_version") or base.name, "revisions": normalized}))
    return entries
