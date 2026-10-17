from pathlib import Path
from canvas.common import inside,digest

ROOT = Path(__file__).resolve().parent.parent

def validate(task,entries):
    prompt = inside(ROOT,task["prompt"])
    if not prompt.is_file():
        raise ValueError("Task prompt is missing")
    for _,manifest in entries:
        for revision in manifest["revisions"]:
            if "待填写。" in prompt.read_text(encoding="utf-8") or revision.get("prompt_sha256")!=digest(prompt):
                raise ValueError("Fill in task prompt and record its SHA256")

def build_payload(task):
    return {"prompt_text":inside(ROOT,task["prompt"]).read_text(encoding="utf-8")}
