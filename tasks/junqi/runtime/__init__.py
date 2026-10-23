"""Static browser arena: building never executes contestant code."""
from pathlib import Path
from canvas.common import inside

ROOT = Path(__file__).resolve().parent.parent


def validate(task, entries):
    prompt = inside(ROOT, task["prompt"])
    if not prompt.is_file():
        raise ValueError("Junqi prompt is missing")
    for base, manifest in entries:
        for revision in manifest["revisions"]:
            folder = inside(base, revision["directory"])
            source = inside(folder, task["submission_entry"])
            if not source.is_file() or source.stat().st_size > 100_000:
                raise ValueError("Junqi requires strategy.js, at most 100000 bytes")


def build_payload(task):
    return {"prompt_text": inside(ROOT, task["prompt"]).read_text(encoding="utf-8")}
