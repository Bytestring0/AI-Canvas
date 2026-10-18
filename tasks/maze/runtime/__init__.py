"""Static browser arena: building never executes contestant code."""
from pathlib import Path
from canvas.common import inside, submissions

ROOT = Path(__file__).resolve().parent.parent


def validate(task, entries):
    prompt = inside(ROOT, task["prompt"])
    if not prompt.is_file():
        raise ValueError("Maze prompt is missing")
    for base, manifest in entries:
        for revision in manifest["revisions"]:
            folder = inside(base, revision["directory"])
            for filename in ("strategy.js", "hunter.js"):
                source = inside(folder, filename)
                if not source.is_file() or source.stat().st_size > 100_000:
                    raise ValueError(f"Maze requires {filename}, at most 100000 bytes")


def build_payload(task):
    hunters = {}
    for base, manifest in submissions():
        if manifest["task"] == task["id"]:
            hunters[manifest["model"]] = {
                revision["id"]: inside(inside(base, revision["directory"]), "hunter.js").read_text(encoding="utf-8")
                for revision in manifest["revisions"]
            }
    return {"prompt_text": inside(ROOT, task["prompt"]).read_text(encoding="utf-8"), "hunter_sources": hunters}
