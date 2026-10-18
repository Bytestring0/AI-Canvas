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

    def submission(self, model="New AI 模型 & test", directory="."):
        base=self.root/"submissions/generic-fixture"/model
        folder=base/directory
        folder.mkdir(parents=True,exist_ok=True)
        (folder/"result.txt").write_text("result",encoding="utf-8")
        (folder/"README.md").write_text("description",encoding="utf-8")
        return base

    def test_flat_folder_builds_without_registration_or_manifest(self):
        self.submission()
        build.build();catalog=read(self.root/"dist/data/catalog.json")
        model=catalog["models"][0]
        self.assertEqual(model["name"],"New AI 模型 & test")
        self.assertEqual(model["id"],model["name"])
        self.assertEqual(catalog["submissions"][0]["revisions"][0]["source"],"result")
        self.assertFalse((self.root/"config/models.json").exists())
        self.assertTrue((self.root/"dist/artifacts/generic-fixture"/model["id"]/"v1/result.txt").is_file())

    def test_revision_folders_are_discovered_in_natural_order(self):
        for revision in ("v10","v2","v1"):
            self.submission("unregistered",f"revisions/{revision}")
        entries=common.submissions()
        self.assertEqual([r["id"] for r in entries[0][1]["revisions"]],["v1","v2","v10"])
        registry.validate()

    def test_directory_identity_overrides_legacy_manifest(self):
        base=self.submission("folder-name","revisions/v1")
        write(base/"submission.json",{"task":"wrong-task","model":"wrong-model","revisions":[{"id":"v1","directory":"revisions/v1"}]})
        entry=common.submissions()[0][1]
        self.assertEqual(entry["task"],"generic-fixture")
        self.assertEqual(entry["model"],"folder-name")
        registry.validate()

    def test_flat_files_take_precedence_over_legacy_revisions(self):
        base=self.submission("folder-name")
        write(base/"submission.json",{"revisions":[{"id":"old","directory":"missing"}]})
        self.assertEqual(common.submissions()[0][1]["revisions"][0]["directory"],".")
        registry.validate()

    def test_missing_file_is_reported_directly(self):
        base=self.submission()
        (base/"README.md").unlink()
        with self.assertRaisesRegex(FileNotFoundError,"README.md"):
            registry.validate()

    def test_no_submissions_needs_no_model_registry(self):
        _,models=registry.validate()
        self.assertEqual(models,[])

    def test_path_escape_is_rejected(self):
        self.task["view"]="../../../outside.js"
        write(self.root/"tasks/generic-fixture/task.json",self.task)
        with self.assertRaisesRegex(ValueError,"escapes"):registry.validate()

    def test_schedule_is_owned_by_task(self):
        task={"schedule":{"timezone":"Asia/Shanghai","weekdays":[0],"interval_minutes":10,"windows":[["10:00","10:30"]]}}
        self.assertTrue(scheduler.due(task,dt.datetime.fromisoformat("2026-10-19T10:10:00+08:00")))
        self.assertFalse(scheduler.due(task,dt.datetime.fromisoformat("2026-10-19T11:10:00+08:00")))
        self.assertFalse(scheduler.due({"schedule":None},dt.datetime.now(dt.timezone.utc)))
