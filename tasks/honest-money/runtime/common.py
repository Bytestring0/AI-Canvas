from pathlib import Path
from canvas.common import read,write,digest,inside
from canvas.common import submissions as all_submissions

ROOT = Path(__file__).resolve().parent.parent

def submissions():
    return [(base,item) for base,item in all_submissions() if item["task"]==ROOT.name]
