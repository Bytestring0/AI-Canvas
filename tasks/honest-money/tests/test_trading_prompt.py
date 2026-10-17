"""Exercise the documented wire examples against the actual process and matching contract."""
import importlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from canvas.common import write
from test_trading_engine import PLUGIN,CONFIG,engine

runner=importlib.import_module(PLUGIN.__name__+".runner")

class TradingPromptTests(unittest.TestCase):
    def examples(self):
        prompt=(PLUGIN.ROOT/"prompt.md").read_text(encoding="utf-8")
        return [json.loads(block) for block in re.findall(r"```json\s*\n(.*?)\n```",prompt,re.S)]

    def test_documented_input_state_matches_actual_initial_settlement(self):
        environment,context,response=self.examples()
        state,_=engine.settle(engine.initial(CONFIG),context["history"][-1],CONFIG)
        state["active_revision"]=context["revision"]
        self.assertEqual(context["account"],state)
        self.assertEqual(environment,CONFIG)
        self.assertEqual(context["environment"],CONFIG)
        engine.validate_orders(response["orders"],CONFIG)

    def test_documented_input_runs_through_real_protocol_process(self):
        context=self.examples()[1]
        result=runner.execute(PLUGIN.ROOT/"templates/revisions/v1",context,unsafe_local=True)
        self.assertEqual(result["orders"],[])
        self.assertEqual(result["memory"],context["memory"])
        engine.validate_orders(result["orders"],context["environment"])

    def test_environment_drift_requires_updating_complete_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in ("README.md","prompt.md"):
                (root/name).write_text((PLUGIN.ROOT/name).read_text(encoding="utf-8"),encoding="utf-8")
            write(root/"environment.json",{**CONFIG,"commission_rate":0.001})
            with patch.object(PLUGIN,"ROOT",root):
                with self.assertRaisesRegex(ValueError,"prompt environment is stale"):
                    PLUGIN.validate({},[])
