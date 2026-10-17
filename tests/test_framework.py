import datetime as dt
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from canvas import common,registry,build,scheduler
from canvas.common import read,write

class FrameworkTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for module in (common,registry,build):
            p=patch.object(module,"ROOT",self.root);p.start();self.addCleanup(p.stop)
        self.task={"id":"generic-fixture","title":"Fixture","readme":"README.md","runtime":"runtime","view":"ui/view.js","submission_entry":"result.txt","schedule":None}
        write(self.root/"tasks/generic-fixture/task.json",self.task)
        base=self.root/"tasks/generic-fixture"
        for path,text in {"README.md":"test","runtime/__init__.py":"def validate(task,entries): pass\ndef build_payload(task): return {'generic':True}\n","ui/view.js":"export function mount() {}","ui/styles.css":""}.items():
            p=base/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text,encoding="utf-8")
        write(self.root/"config/models.json",[{"id":"fixture","name":"Fixture","color":"#777777"}])
        (self.root/"web").mkdir();(self.root/"web/index.html").write_text("test",encoding="utf-8")
        (self.root/"README.md").write_text("generic framework",encoding="utf-8")

    def test_task_discovery_needs_no_root_registration(self):
        self.assertEqual(registry.tasks()[0]["id"],"generic-fixture")
        self.assertFalse((self.root/"config/tasks.json").exists())
        registry.validate()

    def test_build_does_not_require_any_specific_task(self):
        build.build();catalog=read(self.root/"dist/data/catalog.json")
        self.assertEqual(catalog["tasks"][0]["payload"],{"generic":True})
        self.assertTrue((self.root/"dist/task-ui/generic-fixture/view.js").is_file())
        self.assertNotIn("environment",catalog)

    def test_path_escape_is_rejected(self):
        self.task["view"]="../../../outside.js"
        write(self.root/"tasks/generic-fixture/task.json",self.task)
        with self.assertRaisesRegex(ValueError,"escapes"):registry.validate()

    def test_schedule_is_owned_by_task(self):
        task={"schedule":{"timezone":"Asia/Shanghai","weekdays":[0],"interval_minutes":10,"windows":[["10:00","10:30"]]}}
        self.assertTrue(scheduler.due(task,dt.datetime.fromisoformat("2026-10-19T10:10:00+08:00")))
        self.assertFalse(scheduler.due(task,dt.datetime.fromisoformat("2026-10-19T11:10:00+08:00")))
        self.assertFalse(scheduler.due({"schedule":None},dt.datetime.now(dt.timezone.utc)))
