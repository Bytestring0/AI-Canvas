"""All stock-specific hooks and configuration stay in this task directory."""
import math
import json
import re
from .common import ROOT,read

def validate(task,entries):
    config = read(ROOT/"environment.json")
    for key in ("initial_cash","max_debt","annual_debt_interest","commission_rate","minimum_commission","sell_tax_rate","slippage_bps"):
        if type(config[key]) not in (int,float) or not math.isfinite(config[key]) or config[key]<0:
            raise ValueError(f"Invalid trading environment: {key}")
    if config["initial_cash"]==0 or config["lot_size"]!=100 or config["cadence_minutes"]!=10:
        raise ValueError("Invalid trading lot/cadence/capital")
    prompt=(ROOT/"prompt.md").read_text(encoding="utf-8").strip()
    readme=(ROOT/"README.md").read_text(encoding="utf-8")
    start="<!-- AI_CANVAS_PROMPT_START -->"
    end="<!-- AI_CANVAS_PROMPT_END -->"
    if start not in readme or end not in readme or readme.split(start,1)[1].split(end,1)[0].strip()!=prompt:
        raise ValueError("Task README must embed the entire current generation prompt")
    examples=[json.loads(block) for block in re.findall(r"```json\s*\n(.*?)\n```",prompt,re.S)]
    if not examples or examples[0]!=config:
        raise ValueError("Generation prompt environment is stale; update the complete prompt and README")
    if len(examples)<3 or examples[1].get("environment")!=config:
        raise ValueError("Generation prompt input example must include the complete current environment")

def build_payload(task):
    return {"environment":read(ROOT/"environment.json"),"prompt_text":(ROOT/"prompt.md").read_text(encoding="utf-8")}

def capture():
    from .provider import fetch_market
    return fetch_market()

def run(cursor,unsafe_local=False):
    from .runner import simulate
    return simulate(cursor,unsafe_local=unsafe_local)
