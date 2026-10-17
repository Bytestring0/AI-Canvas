import copy
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from .common import ROOT, read, write, inside, submissions, digest
from .engine import initial, settle, validate_orders
from canvas.registry import validate
from .clock import now, parse, snapshot_path, revision_time

IMAGE = "python:3.12-slim"

def revision_hash(folder):
    h = hashlib.sha256()
    for path in sorted(folder.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            h.update(path.relative_to(folder).as_posix().encode())
            h.update(path.read_bytes())
    return h.hexdigest()

def execute(folder, context, unsafe_local=False):
    encoded = json.dumps(context, ensure_ascii=False, allow_nan=False).encode()
    # stdout/stderr use temporary files so an output flood cannot fill host memory.
    with tempfile.TemporaryDirectory(prefix="canvas-") as tmp:
        out = Path(tmp) / "stdout"
        err = Path(tmp) / "stderr"
        if unsafe_local:
            import sys
            command = [sys.executable,"-X","utf8","-I","-S",str(folder / "strategy.py")]
        else:
            command = ["docker","run","--rm","--name",f"canvas-{os.getpid()}","--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","32","--memory","128m","--cpus","1","--user","65534:65534","--ulimit","fsize=1024:1024","--tmpfs","/tmp:rw,noexec,nosuid,size=8m","-i","-v",f"{folder.resolve()}:/submission:ro",IMAGE,"python","-X","utf8","-I","-S","/submission/strategy.py"]
        try:
            with out.open("wb") as stdout, err.open("wb") as stderr:
                result = subprocess.run(command, input=encoded, stdout=stdout, stderr=stderr, timeout=25, cwd=tmp, env={k:v for k,v in os.environ.items() if k in ("PATH","SystemRoot","WINDIR","TEMP","TMP","DOCKER_HOST","HOME")})
            if result.returncode:
                if not unsafe_local and result.returncode == 125:
                    raise RuntimeError("Docker could not start the strategy container; check daemon/image availability")
                raise ValueError(f"Strategy exited {result.returncode}: " + err.read_bytes()[:2000].decode(errors="replace"))
            if out.stat().st_size > 1_000_000:
                raise ValueError("Strategy stdout exceeds 1 MB")
            response = json.loads(out.read_text(encoding="utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
            if not isinstance(response, dict):
                raise ValueError("Strategy response must be a JSON object")
            if "orders" not in response or not isinstance(response.get("commentary", ""), str):
                raise ValueError("Response needs orders and an optional string commentary")
            if not isinstance(response.get("memory", {}), dict):
                raise ValueError("memory must be a JSON object")
            if len(json.dumps(response.get("memory", {}))) > 65536:
                raise ValueError("memory exceeds 64 KB")
            return response
        except FileNotFoundError as exc:
            raise RuntimeError("Docker is required. Install Docker or explicitly use --unsafe-local for trusted local code.") from exc
        except subprocess.TimeoutExpired as exc:
            if not unsafe_local:
                subprocess.run(["docker","rm","-f",f"canvas-{os.getpid()}"], capture_output=True, timeout=10)
            raise ValueError("Strategy timeout (25 seconds)") from exc

def simulate(slot=None, unsafe_local=False, clock=None):
    validate()
    clock = clock or now
    config_path = ROOT / "environment.json"
    config = read(config_path)
    paths = sorted((ROOT / "data/market").glob("*/*.json"))
    if not paths:
        raise ValueError("Capture an intraday snapshot first")
    snapshot = read(snapshot_path(ROOT,slot)) if slot else read(paths[-1])
    if snapshot.get("schema_version") != 2:
        raise ValueError("Daily v1 data cannot be mixed into the intraday v2 experiment")
    slot = snapshot["slot"]
    if parse(snapshot["as_of"]) > clock():
        raise ValueError("Cannot use observations from the future")
    config_hash = digest(config_path)
    season_path = ROOT / "data/season.json"
    season = read(season_path) if season_path.exists() else {"schema_version":2,"start_slot":slot,"environment_sha256":config_hash,"ruleset":config["ruleset"]}
    if season.get("schema_version") != 2 or season["environment_sha256"] != config_hash:
        raise ValueError("Environment changed; archive the old season before continuing")
    write(season_path,season)
    action_path = ROOT / "data/corporate-actions.json"
    all_actions = read(action_path) if action_path.exists() else []
    history = [read(p) for p in paths if p<=snapshot_path(ROOT,slot)][-config["history_points"]:]
    for base,manifest in submissions():
        if manifest["task"] != "honest-money":
            continue
        run_path = ROOT / f"data/runs/{manifest['model']}.json"
        run = read(run_path) if run_path.exists() else {"schema_version":2,"task":manifest["task"],"model":manifest["model"],"model_version":manifest["model_version"],"initial_cash":config["initial_cash"],"state":initial(config),"sessions":[],"revision_registry":{}}
        if run.get("schema_version") != 2:
            raise ValueError("Archive daily v1 results before starting intraday trading")
        if run["model_version"] != manifest["model_version"]:
            raise ValueError("Model identity changed; register a new model ID")
        for session in run["sessions"]:
            if digest(snapshot_path(ROOT,session["slot"])) != session["market_sha256"]:
                raise ValueError("Market snapshot changed after settlement")
            eligible = [r for r in manifest["revisions"] if revision_time(r["effective_from"])<=parse(session["timestamp"])]
            if not eligible or eligible[-1]["id"] != session["revision"]:
                raise ValueError("Revision timeline changed for a settled observation")
            if session.get("corporate_actions",[]) != [a for a in all_actions if a["date"]==session["date"]]:
                raise ValueError("Corporate-action history changed after settlement")
        for rev_id,frozen in run["revision_registry"].items():
            rev = next((r for r in manifest["revisions"] if r["id"]==rev_id),None)
            if rev is None or rev!=frozen["metadata"] or revision_hash(inside(base,rev["directory"]))!=frozen["sha256"]:
                raise ValueError(f"Executed revision {rev_id} was modified or removed")
        if run["state"]["last_slot"] and slot<=run["state"]["last_slot"]:
            continue
        eligible = [r for r in manifest["revisions"] if revision_time(r["effective_from"])<=parse(snapshot["as_of"])]
        if not eligible:
            continue
        rev = eligible[-1]
        if rev["id"] not in run["revision_registry"] and run["state"]["last_timestamp"] and revision_time(rev["effective_from"])<=parse(run["state"]["last_timestamp"]):
            raise ValueError("A new revision must take effect after the last settled observation")
        folder = inside(base,rev["directory"])
        actions = [a for a in all_actions if a["date"]==snapshot["date"]]
        state,events = settle(run["state"],snapshot,config,actions)
        if state["active_revision"]!=rev["id"]:
            events.append({"type":"revision","revision":rev["id"],"previous":state["active_revision"],"note":rev["note"],"sha256":revision_hash(folder)})
        state["active_revision"] = rev["id"]
        context = {"schema_version":2,"as_of":snapshot["as_of"],"slot":slot,"execution":"next_observed_fresh_quote","environment":config,"account":copy.deepcopy(state),"history":history,"memory":state["memory"],"revision":rev["id"]}
        status = "ok"
        try:
            response = execute(folder,context,unsafe_local)
            orders = validate_orders(response["orders"],config)
            issued = max(clock(),parse(snapshot["as_of"])).isoformat()
            state["pending"] = [{**o,"revision":rev["id"],"signal_as_of":snapshot["as_of"],"submitted_at":issued} for o in orders]
            state["memory"] = response.get("memory",{})
            events.append({"type":"signal","orders":state["pending"],"submitted_at":issued,"commentary":response.get("commentary","")[:4000]})
        except (ValueError,OSError) as exc:
            status = "strategy_error"
            events.append({"type":"strategy_error","message":str(exc)[:3000]})
        run["revision_registry"][rev["id"]] = {"metadata":rev,"sha256":revision_hash(folder)}
        run["state"] = state
        run["sessions"].append({"slot":slot,"timestamp":snapshot["as_of"],"date":snapshot["date"],"revision":rev["id"],"status":status,"cash":state["cash"],"debt":max(0,-state["cash"]),"equity":state["equity"],"return":state["equity"]/config["initial_cash"]-1,"max_drawdown":state["max_drawdown"],"positions":copy.deepcopy(state["positions"]),"events":events,"corporate_actions":actions,"market_sha256":digest(snapshot_path(ROOT,slot))})
        write(run_path,run)

