import hashlib
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
    return [(p.parent, read(p)) for p in sorted((ROOT / "submissions").glob("*/*/submission.json"))]
