import argparse
import http.server
import json
import os
import subprocess
from functools import partial
from .common import ROOT,read,write
from .registry import tasks,load_runtime,task_root

def main():
    parser = argparse.ArgumentParser(description="AI Canvas task framework")
    sub = parser.add_subparsers(dest="command",required=True)
    for command in ("build","validate","plan"):
        sub.add_parser(command)
    serve = sub.add_parser("serve")
    serve.add_argument("--port",type=int,default=4173)
    task_cmd = sub.add_parser("task")
    task_cmd.add_argument("id")
    task_cmd.add_argument("operation",choices=("capture","run"))
    task_cmd.add_argument("--cursor")
    task_cmd.add_argument("--github-output",action="store_true")
    task_cmd.add_argument("--unsafe-local",action="store_true")
    args = parser.parse_args()
    if args.command=="validate":
        from .registry import validate
        validate()
        print("Framework and task plugins validated")
    elif args.command in ("build","serve"):
        from .build import build
        build()
        if args.command=="serve":
            print(f"http://localhost:{args.port}",flush=True)
            http.server.ThreadingHTTPServer(("127.0.0.1",args.port),partial(http.server.SimpleHTTPRequestHandler,directory=str(ROOT/"dist"))).serve_forever()
    elif args.command=="plan":
        from .scheduler import plan
        matrix = plan()
        result = {"matrix":json.dumps({"include":matrix}),"enabled":str(bool(matrix)).lower(),"base":subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()}
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"],"a",encoding="utf-8") as output:
                for key,value in result.items():
                    output.write(f"{key}={value}\n")
        print(json.dumps(result,ensure_ascii=False))
    else:
        task = next((t for t in tasks() if t["id"]==args.id),None)
        if task is None:
            raise ValueError("Unknown task ID")
        runtime = load_runtime(task)
        if args.operation=="capture":
            cursor = runtime.capture()
            write(task_root(task)/"data/capture.json",{"ready":cursor is not None,"cursor":cursor})
            if args.github_output:
                with open(os.environ["GITHUB_OUTPUT"],"a",encoding="utf-8") as output:
                    output.write(f"ready={str(cursor is not None).lower()}\ncursor={cursor or ''}\n")
            print(cursor or "No task input captured")
        else:
            cursor = args.cursor
            if cursor is None:
                marker = read(task_root(task)/"data/capture.json")
                if not marker["ready"]:
                    print("Task has no fresh input; skip execution")
                    return
                cursor = marker["cursor"]
            runtime.run(cursor,unsafe_local=args.unsafe_local)

if __name__=="__main__":
    main()
