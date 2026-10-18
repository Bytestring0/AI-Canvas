from pathlib import Path
from canvas.common import inside

ROOT = Path(__file__).resolve().parent.parent

def validate(task,entries):
    prompt = inside(ROOT,task["prompt"])
    if not prompt.is_file():
        raise ValueError("Task prompt is missing")

def build_payload(task):
    return {"prompt_text":inside(ROOT,task["prompt"]).read_text(encoding="utf-8")}
