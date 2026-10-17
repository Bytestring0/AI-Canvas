import datetime as dt
import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from canvas.common import write,read
from test_trading_engine import PLUGIN,CONFIG,snapshot,order,clock,SYMBOL

runner=importlib.import_module(PLUGIN.__name__+".runner")

class TradingRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/"honest-money";self.root.mkdir()
        self.base=Path(self.temp.name)/"submissions/honest-money/fixture"
        self.folder=self.base/"revisions/v1";self.folder.mkdir(parents=True)
        (self.folder/"strategy.py").write_text("# synthetic fixture",encoding="utf-8")
        (self.folder/"README.md").write_text("fixture",encoding="utf-8")
        self.manifest={"schema_version":1,"task":"honest-money","model":"fixture","model_version":"fixture-1","revisions":[{"id":"v1","directory":"revisions/v1","effective_from":"2026-10-19","note":"first"}]}
        write(self.base/"submission.json",self.manifest)
        write(self.root/"environment.json",CONFIG)
        for p in (patch.object(runner,"ROOT",self.root),patch.object(runner,"validate"),patch.object(runner,"submissions",side_effect=lambda:[(self.base,read(self.base/"submission.json"))])):
            p.start();self.addCleanup(p.stop)
        self.stamps=["2026-10-19T09:30:00+08:00","2026-10-19T09:40:00+08:00","2026-10-19T09:50:00+08:00"]
        for stamp in self.stamps:write(clock.snapshot_path(self.root,stamp),snapshot(stamp))
        self.result=self.root/"data/runs/fixture.json"

    def simulate(self,stamp):
        with patch.object(runner,"execute",return_value={"orders":[order()],"memory":{}}) as execute:
            runner.simulate(stamp,clock=lambda:clock.parse(stamp)+dt.timedelta(seconds=5))
            return execute

    def test_next_capture_execution_and_idempotence(self):
        self.simulate(self.stamps[0]);self.assertFalse(read(self.result)["state"]["positions"])
        self.simulate(self.stamps[1]);value=read(self.result)
        self.assertEqual(value["state"]["positions"][SYMBOL]["quantity"],100)
        self.assertFalse(self.simulate(self.stamps[1]).called);self.assertEqual(read(self.result),value)

    def test_context_history_has_no_future_observations(self):
        execute=self.simulate(self.stamps[0]);context=execute.call_args.args[1]
        self.assertEqual(context["schema_version"],2)
        self.assertTrue(all(s["as_of"]<=context["as_of"] for s in context["history"]))

    def test_intraday_revision_preserves_account_and_old_order_origin(self):
        self.simulate(self.stamps[0])
        folder=self.base/"revisions/v2";folder.mkdir()
        (folder/"strategy.py").write_text("# new",encoding="utf-8");(folder/"README.md").write_text("new",encoding="utf-8")
        self.manifest["revisions"].append({"id":"v2","directory":"revisions/v2","effective_from":"2026-10-19T09:35:00+08:00","note":"review"})
        write(self.base/"submission.json",self.manifest);self.simulate(self.stamps[1])
        run=read(self.result)
        self.assertEqual(run["state"]["active_revision"],"v2")
        self.assertEqual(next(e for e in run["sessions"][-1]["events"] if e["type"]=="filled")["revision"],"v1")

    def test_code_and_environment_are_frozen(self):
        self.simulate(self.stamps[0]);(self.folder/"strategy.py").write_text("modified",encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"modified"):self.simulate(self.stamps[1])
        write(self.root/"environment.json",{**CONFIG,"initial_cash":200000})
        with self.assertRaisesRegex(ValueError,"Environment changed"):self.simulate(self.stamps[1])

    def test_market_snapshot_rewrite_rejected(self):
        self.simulate(self.stamps[0]);write(clock.snapshot_path(self.root,self.stamps[0]),snapshot(self.stamps[0],price=12))
        with self.assertRaisesRegex(ValueError,"Market snapshot changed"):self.simulate(self.stamps[1])

    def test_strategy_error_does_not_reverse_already_matched_orders(self):
        self.simulate(self.stamps[0])
        with patch.object(runner,"execute",side_effect=ValueError("bad JSON")):
            runner.simulate(self.stamps[1],clock=lambda:clock.parse(self.stamps[1]))
        run=read(self.result)
        self.assertEqual(run["sessions"][-1]["status"],"strategy_error")
        self.assertEqual(run["state"]["positions"][SYMBOL]["quantity"],100);self.assertFalse(run["state"]["pending"])

    def test_docker_command_is_readonly_networkless_and_limited(self):
        def fake(command,**kwargs):
            for flag in ("--read-only","--network","--cap-drop","--pids-limit","--memory"):self.assertIn(flag,command)
            self.assertEqual(command[command.index("--network")+1],"none")
            kwargs["stdout"].write(b'{"orders":[],"memory":{}}')
            from subprocess import CompletedProcess
            return CompletedProcess(command,0)
        with patch.object(runner.subprocess,"run",side_effect=fake):runner.execute(self.folder,{})

    def test_trusted_protocol_process_strips_credentials(self):
        (self.folder/"strategy.py").write_text('import json,sys,os\nc=json.load(sys.stdin)\njson.dump({"orders":[],"memory":{"leaked":"CANVAS_DATA_TOKEN" in os.environ}},sys.stdout)',encoding="utf-8")
        with patch.dict("os.environ",{"CANVAS_DATA_TOKEN":"synthetic"}):
            result=runner.execute(self.folder,{},unsafe_local=True)
        self.assertFalse(result["memory"]["leaked"])
